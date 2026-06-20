import { registerCocopiChatParticipant } from "./chat-participant.js";
import { closeCodexResponseWebSocketSessions } from "./codex-request.js";
import { registerCocopiCommands } from "./commands.js";
import { createCocopiLogger } from "./diagnostics.js";
import { registerCocopiInlineCompletionProvider } from "./inline-completions.js";
import { registerCocopiLanguageModelProvider } from "./language-model-provider.js";

/** @typedef {import("./runtime.js").CocopiSecretContext} CocopiSecretContext */
/** @typedef {import("./chat-participant.js").VscodeChatApi & import("./commands.js").VscodeCommandApi & import("./inline-completions.js").VscodeInlineCompletionApi & import("./language-model-provider.js").VscodeLanguageModelApi} VscodeActivationApi */

/**
 * @param {CocopiSecretContext & { subscriptions: { dispose(): void }[] }} context
 * @param {VscodeActivationApi} vscode
 */
export function activateWithVscode(context, vscode) {
  const logger = createCocopiLogger(vscode);
  registerCocopiCommands(context, vscode);
  registerCocopiLanguageModelProvider(context, vscode, { logger });
  registerCocopiInlineCompletionProvider(context, vscode, { logger });
  registerCocopiChatParticipant(context, vscode, { logger });
  context.subscriptions.push({ dispose: closeCodexResponseWebSocketSessions }, logger);
}
