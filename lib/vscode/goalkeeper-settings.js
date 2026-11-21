import { writeGoalkeeperSettings } from "../../plugins/goalkeeper/settings.mjs";

/**
 * @param {typeof import("vscode").workspace} workspace
 * @param {import("./diagnostics.js").CocopiLogger} logger
 */
export function syncGoalkeeperSettings(workspace, logger) {
  let pending = Promise.resolve();
  const publish = () => {
    const config = workspace.getConfiguration("cocopi.goalkeeper");
    const settings = {
      prependInstructions: config.get("prependInstructions", ""),
      appendInstructions: config.get("appendInstructions", "")
    };
    pending = pending.then(() => writeGoalkeeperSettings(settings)).catch(() => {
      logger.error("Could not publish Cocopi Goalkeeper settings to the local hook.");
    });
  };
  const subscription = workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("cocopi.goalkeeper")) publish();
  });
  publish();
  return { subscription, ready: pending };
}
