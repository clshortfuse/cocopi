import * as vscode from "vscode";

import { COCOPI_LANGUAGE_MODEL_VENDOR, registerFailClosedCocopiLanguageModelProvider } from "./lib/vscode/fail-closed-language-model-provider.js";

let closeCodexSessions = () => {};

/**
 * @param {vscode.ExtensionContext} context
 */
export async function activate(context) {
  const boundary = registerFailClosedCocopiLanguageModelProvider(context, vscode);
  /** @type {import("./lib/vscode/diagnostics.js").CocopiLogger | undefined} */
  let logger;

  try {
    const { createCocopiLogger, noopCocopiLogger } = await import("./lib/vscode/diagnostics.js");
    logger = noopCocopiLogger;
    boundary.setLogger(logger);
    try {
      logger = createCocopiLogger(vscode, context);
      boundary.setLogger(logger);
      context.subscriptions.push(logger);
    } catch (error) {
      reportBootstrapFailure(logger, "Cocopi diagnostics output could not be initialized; fail-closed provider remains active.", error instanceof Error ? error : String(error));
    }
  } catch (error) {
    reportBootstrapFailure(undefined, "Cocopi diagnostics module could not be loaded; fail-closed provider remains active.", error instanceof Error ? error : String(error));
  }

  try {
    const { createCocopiLanguageModelProvider } = await import("./lib/vscode/language-model-provider.js");
    boundary.setDelegate(createCocopiLanguageModelProvider(context, vscode, { logger }));
    void Promise.resolve(vscode.lm.selectChatModels({ vendor: COCOPI_LANGUAGE_MODEL_VENDOR })).catch((error) => {
      reportBootstrapFailure(logger, "Cocopi language model startup resolution failed; fail-closed provider remains active.", error instanceof Error ? error : String(error));
    });
  } catch (error) {
    reportBootstrapFailure(logger, "Cocopi provider implementation could not be loaded; fail-closed provider remains active.", error instanceof Error ? error : String(error));
  }

  try {
    const codexRequest = await import("./lib/vscode/codex-request.js");
    closeCodexSessions = codexRequest.closeCodexResponseWebSocketSessions;
    context.subscriptions.push({ dispose: closeCodexSessions });
  } catch (error) {
    reportBootstrapFailure(logger, "Cocopi transport lifecycle cleanup could not be loaded.", error instanceof Error ? error : String(error));
  }

  try {
    const { activateCocopiOptionalFeaturesWithVscode } = await import("./lib/vscode/activate.js");
    if (logger) {
      activateCocopiOptionalFeaturesWithVscode(context, vscode, { logger });
    }
  } catch (error) {
    reportBootstrapFailure(logger, "Cocopi optional features could not be loaded; fail-closed provider remains active.", error instanceof Error ? error : String(error));
  }
}

export function deactivate() {
  closeCodexSessions();
}

/**
 * @param {import("./lib/vscode/diagnostics.js").CocopiLogger | undefined} logger
 * @param {string} message
 * @param {Error | string} error
 */
function reportBootstrapFailure(logger, message, error) {
  if (logger) {
    try {
      logger.error(message, error);
      return;
    } catch {
      // Fall through to the extension host console.
    }
  }
  console.error(message, error);
}
