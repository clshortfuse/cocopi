import { registerCocopiChatParticipant } from "./chat-participant.js";
import { registerCocopiCommands } from "./commands.js";
import { registerCocopiInlineCompletionProvider } from "./inline-completions.js";
import { activateCocopiCoreWithVscode } from "./activate-core.js";

/** @typedef {import("./runtime.js").CocopiSecretContext} CocopiSecretContext */
/** @typedef {import("./chat-participant.js").VscodeChatApi & import("./commands.js").VscodeCommandApi & import("./inline-completions.js").VscodeInlineCompletionApi & import("./language-model-provider.js").VscodeLanguageModelApi} VscodeActivationApi */

/**
 * @param {CocopiSecretContext & { subscriptions: { dispose(): void }[], logUri?: { fsPath?: string } }} context
 * @param {VscodeActivationApi} vscode
 */
export function activateWithVscode(context, vscode) {
  const logger = activateCocopiCoreWithVscode(context, vscode);
  activateCocopiOptionalFeaturesWithVscode(context, vscode, { logger });
}

/**
 * @param {CocopiSecretContext & { subscriptions: { dispose(): void }[], logUri?: { fsPath?: string } }} context
 * @param {VscodeActivationApi} vscode
 * @param {{ logger: import("./diagnostics.js").CocopiLogger }} options
 */
export function activateCocopiOptionalFeaturesWithVscode(context, vscode, options) {
  /** @type {Array<[string, () => void]>} */
  const features = [
    ["commands and status surfaces", () => registerCocopiCommands(context, vscode, options)],
    ["inline completions", () => registerCocopiInlineCompletionProvider(context, vscode, options)],
    ["chat participant", () => registerCocopiChatParticipant(context, vscode, options)]
  ];

  for (const [name, register] of features) {
    try {
      register();
    } catch (error) {
      options.logger.error(`Cocopi optional ${name} failed to initialize; language model provider remains active.`, error instanceof Error ? error : String(error));
    }
  }
}
