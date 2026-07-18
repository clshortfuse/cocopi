import { closeCodexResponseWebSocketSessions } from "./codex-request.js";
import { createCocopiLogger, noopCocopiLogger } from "./diagnostics.js";
import { registerCocopiLanguageModelProvider } from "./language-model-provider.js";

/** @typedef {import("./runtime.js").CocopiSecretContext} CocopiSecretContext */
/** @typedef {import("./language-model-provider.js").VscodeLanguageModelApi & { window: import("./language-model-provider.js").VscodeLanguageModelApi["window"] & { createOutputChannel(name: string): { appendLine(value: string): void, dispose(): void } } }} VscodeCoreActivationApi */

/**
 * Register the billing-sensitive provider boundary before importing or initializing optional features.
 *
 * @param {CocopiSecretContext & { subscriptions: { dispose(): void }[], logUri?: { fsPath?: string } }} context
 * @param {VscodeCoreActivationApi} vscode
 */
export function activateCocopiCoreWithVscode(context, vscode) {
  let logger = noopCocopiLogger;
  try {
    logger = createCocopiLogger(vscode, context);
  } catch {
    // Provider registration must not depend on diagnostics UI availability.
  }

  registerCocopiLanguageModelProvider(context, vscode, { logger });
  context.subscriptions.push({ dispose: closeCodexResponseWebSocketSessions }, logger);
  return logger;
}
