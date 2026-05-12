import * as vscode from "vscode";

import { closeCodexResponseWebSocketSessions } from "./lib/vscode/codex-request.js";
import { activateWithVscode } from "./lib/vscode/activate.js";

/**
 * @param {vscode.ExtensionContext} context
 */
export function activate(context) {
  activateWithVscode(context, vscode);
}

export function deactivate() {
  closeCodexResponseWebSocketSessions();
}