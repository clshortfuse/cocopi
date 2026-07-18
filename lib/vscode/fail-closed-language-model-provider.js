export const COCOPI_LANGUAGE_MODEL_VENDOR = "cocopi";

const COCOPI_MODEL_CATALOG_STORAGE_KEY = "cocopi.modelCatalog.v1";
const COCOPI_PROTECTED_MODEL_IDS_STORAGE_KEY = "cocopi.protectedModelIds.v1";
const DEFAULT_COCOPI_MODEL_ID = "gpt-5.5";
const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;
const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 16_384;
const COCOPI_QUALIFIED_MODEL_CONFIGURATION_KEYS = [
  ["chat", "utilityModel"],
  ["chat", "utilitySmallModel"],
  ["inlineChat", "defaultModel"],
  ["github.copilot.chat.implementAgent", "model"],
  ["github.copilot.chat.askAgent", "model"],
  ["github.copilot.chat.exploreAgent", "model"],
  ["github.copilot.chat.conversationCompaction", "model"],
  ["github.copilot.chat.executionSubagent", "model"],
  ["github.copilot.chat.searchSubagent", "model"]
];

/** @typedef {{ debug(message: string): void, info(message: string): void, error(message: string, error?: Error | string): void, dispose(): void }} FailClosedLogger */
/** @typedef {{ get(key: string): Thenable<string | undefined>, store(key: string, value: string): Thenable<void> }} FailClosedSecretStorage */
/** @typedef {{ subscriptions: { dispose(): void }[], secrets: FailClosedSecretStorage, globalState?: { get(key: string): unknown, update(key: string, value: readonly string[]): Thenable<void> } }} FailClosedContext */
/** @typedef {{ lm: { registerLanguageModelChatProvider(vendor: string, provider: import("vscode").LanguageModelChatProvider): { dispose(): void } }, LanguageModelTextPart: typeof import("vscode").LanguageModelTextPart, workspace: { getConfiguration(section?: string): { get(key: string, defaultValue: string): string } } }} FailClosedVscodeApi */

const noopLogger = /** @type {FailClosedLogger} */ ({
  debug() {},
  info() {},
  error() {},
  dispose() {}
});

/**
 * Register the provider boundary before any optional Cocopi modules are loaded.
 *
 * @param {FailClosedContext} context
 * @param {FailClosedVscodeApi} vscode
 * @param {{ logger?: FailClosedLogger }} [options]
 */
export function registerFailClosedCocopiLanguageModelProvider(context, vscode, options = {}) {
  const controller = createFailClosedCocopiLanguageModelProvider(context, vscode, options);
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(
    COCOPI_LANGUAGE_MODEL_VENDOR,
    controller.provider
  ));
  return controller;
}

/**
 * Keep Cocopi model IDs resolvable and routed through the Cocopi provider.
 * If model discovery rejects or forgets an ID, VS Code can silently substitute a
 * Copilot model before the selected provider receives the request. Once the full
 * provider is available, its request failures propagate unchanged so VS Code can
 * apply its normal error and retry handling.
 *
 * @param {FailClosedContext} context
 * @param {FailClosedVscodeApi} vscode
 * @param {{ logger?: FailClosedLogger }} [options]
 */
export function createFailClosedCocopiLanguageModelProvider(context, vscode, options = {}) {
  let logger = options.logger ?? noopLogger;
  const modelInformationChanged = createVoidEventEmitter();
  /** @type {Map<string, import("vscode").LanguageModelChatInformation>} */
  const protectedInformationById = new Map();
  /** @type {Set<string> | undefined} */
  let persistedProtectedModelIds;
  let protectedHistoryRead = false;
  /** @type {import("vscode").LanguageModelChatProvider | undefined} */
  let delegate;

  /**
   * @param {readonly import("vscode").LanguageModelChatInformation[]} current
   * @param {string} detail
   */
  const protectedModelInformation = async (current, detail) => {
    for (const information of current) {
      if (information?.id) {
        protectedInformationById.set(information.id, information);
      }
    }

    const configuredModelIds = cocopiConfiguredLanguageModelIds(vscode);
    if (!protectedHistoryRead) {
      protectedHistoryRead = true;
      persistedProtectedModelIds = new Set();
      try {
        for (const modelId of parseProtectedModelIds(context.globalState?.get(COCOPI_PROTECTED_MODEL_IDS_STORAGE_KEY))) {
          persistedProtectedModelIds.add(modelId);
        }
      } catch (error) {
        logFailClosedError(logger, "Cocopi protected model history could not be read from extension state; continuing with other identifier sources.", normalizeCaughtError(error));
      }
      try {
        for (const modelId of await readProtectedModelIds(context.secrets)) {
          persistedProtectedModelIds.add(modelId);
        }
        const storedCatalog = await context.secrets.get(COCOPI_MODEL_CATALOG_STORAGE_KEY);
        for (const information of modelInformationFromStoredCatalog(storedCatalog, detail)) {
          if (!protectedInformationById.has(information.id)) {
            protectedInformationById.set(information.id, information);
          }
        }
      } catch (error) {
        logFailClosedError(logger, "Cocopi protected model history could not be read from SecretStorage; continuing with extension-state and in-memory identifiers.", normalizeCaughtError(error));
      }
    }

    for (const modelId of [...configuredModelIds, ...(persistedProtectedModelIds ?? [])]) {
      if (!protectedInformationById.has(modelId)) {
        protectedInformationById.set(modelId, genericLanguageModelInformation(modelId, detail));
      }
    }

    if (protectedInformationById.size === 0) {
      protectedInformationById.set(DEFAULT_COCOPI_MODEL_ID, genericLanguageModelInformation(DEFAULT_COCOPI_MODEL_ID, detail));
    }

    const protectedIds = new Set(protectedInformationById.keys());
    const addedIds = [...protectedIds].filter((modelId) => !persistedProtectedModelIds?.has(modelId));
    if (addedIds.length > 0) {
      const sortedProtectedIds = [...protectedIds].toSorted();
      let stored = false;
      if (context.globalState) {
        try {
          await context.globalState.update(COCOPI_PROTECTED_MODEL_IDS_STORAGE_KEY, sortedProtectedIds);
          stored = true;
        } catch (error) {
          logFailClosedError(logger, "Cocopi protected model history could not be stored in extension state; current process remains fail-closed.", normalizeCaughtError(error));
        }
      }
      try {
        await context.secrets.store(COCOPI_PROTECTED_MODEL_IDS_STORAGE_KEY, JSON.stringify(sortedProtectedIds));
        stored = true;
      } catch (error) {
        logFailClosedError(logger, "Cocopi protected model history could not be stored in SecretStorage; current process remains fail-closed.", normalizeCaughtError(error));
      }
      if (stored) {
        persistedProtectedModelIds = protectedIds;
      }
    }

    return [...protectedInformationById.values()];
  };

  /** @type {import("vscode").LanguageModelChatProvider} */
  const provider = {
    onDidChangeLanguageModelChatInformation: modelInformationChanged.event,

    async provideLanguageModelChatInformation(requestOptions, token) {
      if (!delegate) {
        return protectedModelInformation([], "Cocopi provider unavailable; protected route");
      }

      try {
        const information = await delegate.provideLanguageModelChatInformation(requestOptions, token);
        if (!Array.isArray(information) || information.length === 0) {
          logFailClosedError(logger, "Cocopi provider returned no models; retaining protected model identifiers.");
          return protectedModelInformation([], "Cocopi model discovery returned no models; protected route");
        }
        return protectedModelInformation(information, "Protected Cocopi route");
      } catch (error) {
        logFailClosedError(logger, "Cocopi model discovery failed; retaining protected model identifiers.", normalizeCaughtError(error));
        return protectedModelInformation([], "Cocopi model discovery unavailable; protected route");
      }
    },

    async provideLanguageModelChatResponse(model, messages, requestOptions, progress, token) {
      if (!delegate) {
        reportLocalCocopiFailure(progress, vscode, model.id, "The Cocopi provider implementation is unavailable. No model request was sent.", logger);
        return;
      }

      await delegate.provideLanguageModelChatResponse(model, messages, requestOptions, progress, token);
    },

    async provideTokenCount(model, text, token) {
      try {
        if (delegate) {
          return await delegate.provideTokenCount(model, text, token);
        }
      } catch (error) {
        logFailClosedError(logger, "Cocopi token counting failed; using a local estimate.", normalizeCaughtError(error));
      }

      return approximateTokenCountFromCharacters(estimatedLanguageModelInputCharacters(text));
    }
  };

  return {
    provider,
    /** @param {FailClosedLogger} value */
    setLogger(value) {
      logger = value;
    },
    /** @param {import("vscode").LanguageModelChatProvider} value */
    setDelegate(value) {
      delegate = value;
      try {
        const subscription = delegate.onDidChangeLanguageModelChatInformation?.(() => {
          modelInformationChanged.fire();
        });
        if (subscription) {
          context.subscriptions.push(subscription);
        }
      } catch (error) {
        logFailClosedError(logger, "Cocopi provider model-change notifications are unavailable; the fail-closed provider remains active.", normalizeCaughtError(error));
      }
      modelInformationChanged.fire();
    }
  };
}

/**
 * @param {import("vscode").Progress<import("vscode").LanguageModelResponsePart>} progress
 * @param {FailClosedVscodeApi} vscode
 * @param {string} modelId
 * @param {string} detail
 * @param {FailClosedLogger} logger
 */
function reportLocalCocopiFailure(progress, vscode, modelId, detail, logger) {
  const text = `Cocopi local failure (not model-authored): ${detail} Cocopi did not invoke a replacement provider for ${modelId || "the selected model"}. See the Cocopi logs for details.`;
  try {
    progress.report(new vscode.LanguageModelTextPart(text));
  } catch (error) {
    logFailClosedError(logger, "Cocopi could not report its local fail-closed response to VS Code.", normalizeCaughtError(error));
  }
}

/** @param {FailClosedVscodeApi} vscode */
function cocopiConfiguredLanguageModelIds(vscode) {
  const modelIds = new Set();
  const configuredModel = readConfigurationString(vscode, "cocopi", "model");
  modelIds.add(configuredModel || DEFAULT_COCOPI_MODEL_ID);
  for (const [section, key] of COCOPI_QUALIFIED_MODEL_CONFIGURATION_KEYS) {
    const value = readConfigurationString(vscode, section, key);
    if (value.startsWith(`${COCOPI_LANGUAGE_MODEL_VENDOR}/`)) {
      const modelId = value.slice(COCOPI_LANGUAGE_MODEL_VENDOR.length + 1);
      if (modelId) {
        modelIds.add(modelId);
      }
    }
  }
  return [...modelIds];
}

/**
 * @param {FailClosedVscodeApi} vscode
 * @param {string} section
 * @param {string} key
 */
function readConfigurationString(vscode, section, key) {
  try {
    const value = vscode.workspace.getConfiguration(section).get(key, "");
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

/** @param {FailClosedSecretStorage} secrets */
async function readProtectedModelIds(secrets) {
  const stored = await secrets.get(COCOPI_PROTECTED_MODEL_IDS_STORAGE_KEY);
  return parseProtectedModelIds(stored);
}

// eslint-disable-next-line jsdoc/check-types -- Persisted extension state is external untyped data.
/** @param {unknown} stored */
function parseProtectedModelIds(stored) {
  if (!stored) {
    return new Set();
  }
  try {
    const parsed = typeof stored === "string" ? JSON.parse(stored) : stored;
    return new Set(Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string" && value.length > 0) : []);
  } catch {
    return new Set();
  }
}

/**
 * @param {string | undefined} stored
 * @param {string} detail
 */
function modelInformationFromStoredCatalog(stored, detail) {
  if (!stored) {
    return [];
  }
  try {
    const caches = JSON.parse(stored);
    if (!Array.isArray(caches)) {
      return [];
    }
    /** @type {Map<string, import("vscode").LanguageModelChatInformation>} */
    const informationById = new Map();
    for (const cache of caches) {
      if (!cache || typeof cache !== "object" || !Array.isArray(cache.models)) {
        continue;
      }
      for (const model of cache.models) {
        if (!model || typeof model !== "object") {
          continue;
        }
        const id = cleanString(model.id) ?? cleanString(model.slug);
        if (!id) {
          continue;
        }
        const name = cleanString(model.displayName) ?? cleanString(model.display_name) ?? cleanString(model.name) ?? id;
        informationById.set(id, genericLanguageModelInformation(id, detail, name));
      }
    }
    return [...informationById.values()];
  } catch {
    return [];
  }
}

/**
 * @param {string} model
 * @param {string} detail
 * @param {string} [name]
 * @returns {import("vscode").LanguageModelChatInformation}
 */
function genericLanguageModelInformation(model, detail, name = model) {
  return {
    id: model,
    name,
    family: "codex",
    tooltip: "Remote Codex through Cocopi",
    detail: `Cocopi - ${detail}`,
    version: model,
    isBYOK: true,
    isUserSelectable: true,
    maxInputTokens: Math.floor((DEFAULT_MODEL_CONTEXT_WINDOW - DEFAULT_MODEL_MAX_OUTPUT_TOKENS) * 0.9),
    maxOutputTokens: DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
    capabilities: /** @type {import("vscode").LanguageModelChatCapabilities & Record<string, unknown>} */ ({
      imageInput: false,
      toolCalling: true,
      agentMode: true
    })
  };
}

/** @param {string | import("vscode").LanguageModelChatRequestMessage} input */
function estimatedLanguageModelInputCharacters(input) {
  if (typeof input === "string") {
    return input.length;
  }
  let characters = 0;
  for (const part of input?.content ?? []) {
    if (part && typeof part === "object" && typeof Reflect.get(part, "value") === "string") {
      characters += Reflect.get(part, "value").length;
    }
  }
  return characters;
}

/** @param {number} characters */
function approximateTokenCountFromCharacters(characters) {
  return Math.max(1, Math.ceil(characters / 4));
}

// eslint-disable-next-line jsdoc/check-types -- Stored catalog JSON is external untyped data.
/** @param {unknown} value */
function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// eslint-disable-next-line jsdoc/check-types -- Provider and host failures can throw arbitrary values.
/** @param {unknown} error */
function normalizeCaughtError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * @param {FailClosedLogger} logger
 * @param {string} message
 * @param {Error} [error]
 */
function logFailClosedError(logger, message, error) {
  try {
    logger.error(message, error);
  } catch {
    // Diagnostics are best-effort inside the billing-sensitive boundary.
  }
}

function createVoidEventEmitter() {
  /** @type {Set<() => void>} */
  const listeners = new Set();
  return {
    /**
     * @param {() => void} listener
     * @returns {{ dispose(): void }}
     */
    event(listener) {
      listeners.add(listener);
      return {
        dispose() {
          listeners.delete(listener);
        }
      };
    },
    fire() {
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // A host listener must not break provider routing.
        }
      }
    }
  };
}
