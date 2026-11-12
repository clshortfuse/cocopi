import { COCOPI_PROPOSED_APIS_ENABLED } from "../../data/build-profile.js";
import { readCocopiCachedModels } from "./language-model-provider.js";
import { readCocopiRuntime } from "./runtime.js";
import { COCOPI_SDK_PROFILE_WARNING, createCocopiSdkAgentProfiles } from "./sdk-agent-profiles.js";

/**
 * @param {import('./commands.js').CocopiSecretContext} context
 * @param {import('./commands.js').VscodeCommandApi} vscode
 */
function exportUnavailableReason(context, vscode) {
  if (!COCOPI_PROPOSED_APIS_ENABLED || !context.extension?.packageJSON.enabledApiProposals?.includes("chatProvider")) {
    return "SDK agent profiles require the full Cocopi build with chatProvider authorization; Marketplace does not publish the BYOK aliases.";
  }
  const policy = vscode.workspace.getConfiguration("chat.customizations");
  if (!policy.inspect?.("strictPluginOnlyCustomization")) {
    return "Standalone agent discovery policy is unavailable. SDK profile export is not offered without this policy check.";
  }
  if (policy.get("strictPluginOnlyCustomization", false) === true) {
    return "Strict plugin-only customization policy blocks standalone agent profiles. Cocopi will not change policy or package a workaround plugin.";
  }
  return;
}

/**
 * Open an untitled document, leaving all actual writing/overwrite confirmation
 * to the user's native Save As action. No workspace file is written here.
 * @param {import('./commands.js').CocopiSecretContext} context
 * @param {import('./commands.js').VscodeCommandApi} vscode
 */
export async function previewCocopiSdkAgentProfile(context, vscode) {
  try {
    const unavailable = exportUnavailableReason(context, vscode);
    if (unavailable) {
      await vscode.window.showWarningMessage(unavailable);
      return;
    }
    if (!vscode.workspace.openTextDocument || !vscode.window.showTextDocument) {
      await vscode.window.showWarningMessage("SDK profile preview requires a text editor. No file was written.");
      return;
    }
    const runtime = await readCocopiRuntime(context, vscode, { refreshAuth: false });
    const models = await readCocopiCachedModels(context, runtime);
    const generated = createCocopiSdkAgentProfiles(runtime.configuration.subagents, models);
    if (generated.profiles.length === 0) {
      await vscode.window.showWarningMessage(`No SDK-compatible cached model routes are available. Sign in, load the model catalog and enable supported matrix choices first. ${generated.rejected.map((entry) => `${entry.id}: ${entry.reason}`).join(" ")}`);
      return;
    }
    if (generated.rejected.length > 0) {
      await vscode.window.showInformationMessage(`Some routes cannot be exported: ${generated.rejected.map((entry) => `${entry.id}: ${entry.reason}`).join(" ")}`);
    }
    const selection = await vscode.window.showQuickPick(generated.profiles.map((profile) => ({
      label: profile.name,
      description: profile.model,
      detail: `.github/agents/${profile.filename}`,
      modelId: profile.id
    })), { placeHolder: "Preview one SDK agent profile from cached catalog routes (not a routing guarantee)" });
    if (!selection || typeof selection === "string") {
      return;
    }
    const profile = generated.profiles.find((entry) => entry.id === selection.modelId);
    if (!profile) {
      return;
    }
    const unchanged = async () => {
      const reason = exportUnavailableReason(context, vscode);
      if (reason) {
        await vscode.window.showWarningMessage(reason);
        return false;
      }
      const current = await readCocopiRuntime(context, vscode, { refreshAuth: false });
      const currentModels = await readCocopiCachedModels(context, current);
      const currentProfile = createCocopiSdkAgentProfiles(current.configuration.subagents, currentModels).profiles.find((entry) => entry.id === profile.id);
      const finalPolicyReason = exportUnavailableReason(context, vscode);
      if (finalPolicyReason) {
        await vscode.window.showWarningMessage(finalPolicyReason);
        return false;
      }
      if (current.auth?.chatgptAccountId !== runtime.auth?.chatgptAccountId || current.auth?.accessToken !== runtime.auth?.accessToken || current.configuration.apiBaseUrl !== runtime.configuration.apiBaseUrl || current.clientVersion !== runtime.clientVersion || currentProfile?.content !== profile.content) {
        await vscode.window.showWarningMessage("The account, catalog or route changed. Preview the SDK profile again before saving.");
        return false;
      }
      return true;
    };
    if (!await unchanged()) {
      return;
    }
    const document = await vscode.workspace.openTextDocument({ language: "markdown", content: profile.content });
    await vscode.window.showTextDocument(document, { preview: false });
    const save = await vscode.window.showInformationMessage(`Preview only; no file written. Suggested destination: .github/agents/${profile.filename}. ${COCOPI_SDK_PROFILE_WARNING}`, "Save As");
    if (save === "Save As" && await unchanged()) {
      await vscode.window.showTextDocument(document, { preview: false });
      await vscode.commands.executeCommand?.("workbench.action.files.saveAs");
    }
  } catch {
    await vscode.window.showWarningMessage("SDK agent profile preview could not be prepared. No automatic file write, SDK reload or setting change was performed.");
  }
}