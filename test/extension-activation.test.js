import test from "node:test";
import assert from "node:assert/strict";

import { activateWithVscode } from "../lib/vscode/activate.js";
import { COCOPI_CHAT_PARTICIPANT_ID } from "../lib/vscode/chat-participant.js";
import { COCOPI_COMMANDS } from "../lib/vscode/commands.js";
import { COCOPI_OUTPUT_CHANNEL_NAME } from "../lib/vscode/diagnostics.js";
import { COCOPI_LANGUAGE_MODEL_VENDOR } from "../lib/vscode/language-model-provider.js";

class LanguageModelTextPart {
  /** @param {string} value */
  constructor(value) {
    this.value = value;
  }
}

class LanguageModelToolCallPart {
  /**
   * @param {string} callId
   * @param {string} name
   * @param {object} input
   */
  constructor(callId, name, input) {
    this.callId = callId;
    this.name = name;
    this.input = input;
  }
}

class LanguageModelDataPart {
  /**
   * @param {Uint8Array} data
   * @param {string} mime
   */
  static image(data, mime) {
    return new LanguageModelDataPart(data, mime);
  }

  /**
   * @param {object} value
   * @param {string} [mime]
   */
  static json(value, mime = "application/json") {
    return new LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(value)), mime);
  }

  /**
   * @param {string} value
   * @param {string} [mime]
   */
  static text(value, mime = "text/plain") {
    return new LanguageModelDataPart(new TextEncoder().encode(value), mime);
  }

  /**
   * @param {Uint8Array} data
   * @param {string} mimeType
   */
  constructor(data, mimeType) {
    this.data = data;
    this.mimeType = mimeType;
  }
}

test("activateWithVscode wires commands, provider, participant, and diagnostics", () => {
  const context = fakeContext();
  const vscode = fakeVscode();

  activateWithVscode(context, vscode);

  assert.deepEqual(vscode.registeredCommands, [
    COCOPI_COMMANDS.manage,
    COCOPI_COMMANDS.showDiagnostics,
    COCOPI_COMMANDS.showTokenTracker,
    COCOPI_COMMANDS.signIn,
    COCOPI_COMMANDS.selectModel,
    COCOPI_COMMANDS.selectInlineCompletionModel,
    COCOPI_COMMANDS.showInlineCompletionOptions,
    COCOPI_COMMANDS.toggleInlineCompletions,
    COCOPI_COMMANDS.status,
    COCOPI_COMMANDS.signOut
  ]);
  assert.equal(vscode.languageModelVendor, COCOPI_LANGUAGE_MODEL_VENDOR);
  assert.equal(vscode.inlineCompletionProviders, 1);
  assert.deepEqual(vscode.selectedModelSelectors, [{ vendor: COCOPI_LANGUAGE_MODEL_VENDOR }]);
  assert.equal(vscode.chatParticipantId, COCOPI_CHAT_PARTICIPANT_ID);
  assert.equal(vscode.outputChannelName, COCOPI_OUTPUT_CHANNEL_NAME);
  assert.equal(context.subscriptions.length, 15);
});

function fakeContext() {
  return {
    subscriptions: [],
    secrets: {
      /** @returns {Promise<string | undefined>} */
      async get() {
        return;
      },
      async store() {},
      async delete() {}
    }
  };
}

function fakeVscode() {
  const vscode = {
    /** @type {string[]} */
    registeredCommands: [],
    /** @type {Array<{ vendor?: string } | undefined>} */
    selectedModelSelectors: [],
    languageModelVendor: "",
    inlineCompletionProviders: 0,
    chatParticipantId: "",
    outputChannelName: "",
    commands: {
      /**
       * @param {string} command
       * @param {() => void | Thenable<void>} callback
       */
      registerCommand(command, callback) {
        void callback;
        vscode.registeredCommands.push(command);
        return { dispose() {} };
      }
    },
    env: {
      async openExternal() {
        return true;
      }
    },
    Uri: {
      /** @param {string} value */
      parse(value) {
        return {
          toString() {
            return value;
          }
        };
      }
    },
    lm: {
      tools: [],
      /**
       * @param {string} vendor
       * @param {import("vscode").LanguageModelChatProvider} provider
       */
      registerLanguageModelChatProvider(vendor, provider) {
        void provider;
        vscode.languageModelVendor = vendor;
        return { dispose() {} };
      },
      /** @param {{ vendor?: string }} [selector] */
      async selectChatModels(selector) {
        vscode.selectedModelSelectors.push(selector);
        return [];
      },
      async invokeTool() {
        return { content: [] };
      }
    },
    languages: {
      /**
       * @param {import("vscode").DocumentSelector} selector
       * @param {import("vscode").InlineCompletionItemProvider} provider
       */
      registerInlineCompletionItemProvider(selector, provider) {
        void selector;
        void provider;
        vscode.inlineCompletionProviders += 1;
        return { dispose() {} };
      }
    },
    chat: {
      /**
       * @param {string} id
       * @param {import("vscode").ChatRequestHandler} handler
       */
      createChatParticipant(id, handler) {
        void handler;
        vscode.chatParticipantId = id;
        return { dispose() {} };
      }
    },
    workspace: {
      getConfiguration() {
        return {
          /**
           * @template T
           * @param {string} _key
           * @param {T} defaultValue
           * @returns {T}
           */
          get(_key, defaultValue) {
            return defaultValue;
          }
        };
      }
    },
    window: {
      async showInformationMessage() {},
      /** @returns {Promise<string | undefined>} */
      async showWarningMessage() {
        return;
      },
      /** @returns {Promise<string | { label: string, modelId?: string } | undefined>} */
      async showQuickPick() {
        return;
      },
      /** @param {string} name */
      createOutputChannel(name) {
        vscode.outputChannelName = name;
        return {
          appendLine() {},
          dispose() {}
        };
      },
      /**
       * @param {string} viewType
       * @param {string} title
       * @param {number} showOptions
       */
      createWebviewPanel(viewType, title, showOptions) {
        void viewType;
        void title;
        void showOptions;
        return {
          webview: { html: "" }
        };
      },
      setStatusBarMessage() {
        return { dispose() {} };
      }
    },
    LanguageModelTextPart,
    LanguageModelToolCallPart,
    LanguageModelDataPart,
    LanguageModelChatToolMode: Object.freeze({ Auto: 1, Required: 2 }),
    LanguageModelChatMessageRole: Object.freeze({ User: 1, Assistant: 2 }),
    LanguageModelError: class extends Error {
      code = "Unknown";

      /** @param {string} [message] */
      static NoPermissions(message) {
        const error = new this(message);
        error.code = "NoPermissions";
        return error;
      }

      /** @param {string} [message] */
      static Blocked(message) {
        const error = new this(message);
        error.code = "Blocked";
        return error;
      }

      /** @param {string} [message] */
      static NotFound(message) {
        const error = new this(message);
        error.code = "NotFound";
        return error;
      }
    }
  };

  return vscode;
}
