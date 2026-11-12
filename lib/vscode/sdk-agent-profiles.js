import { normalizeSubagentMatrix, resolveSubagentMatrix, subagentChoiceAvailable } from "./subagent-matrix.js";
import { COCOPI_PROPOSED_APIS_ENABLED } from "../../data/build-profile.js";

const SDK_AGENT_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export const COCOPI_SDK_PROFILE_WARNING = "SDK custom agents can fall back to the parent model when their model is unavailable. This does not guarantee Cocopi-only routing or quota isolation. Tools inherit host access and approvals; this profile does not enforce the Local parent/target matrix. Cached catalog data may be stale, and saving does not prove discovery.";

export const COCOPI_AGENT_FEATURE_COVERAGE = Object.freeze([
  { route: "Local runSubagent", status: "Matrix supported", detail: "The matrix guides only runSubagent with a model argument. Explicit selections and user restrictions remain authoritative." },
  { route: "SDK custom agents", status: "Opt-in profile preview", detail: "Save a catalog-validated profile explicitly, then verify host discovery and model routing. Parent-model fallback remains possible." },
  { route: "SDK task / execution subagents", status: "Host controlled", detail: "For task schemas enumerating matching agent_type names, Cocopi adds candidate-route guidance only. No schema/argument rewriting or Local matrix enforcement; execution subagents remain separate." },
  { route: "Session creation and messaging", status: "Host controlled", detail: "Uses host model identifiers, trust, approvals and lifetime. Not a runSubagent alias or a detached-service guarantee." },
  { route: "Utility requests", status: "Separate routing", detail: "Utility model overrides/defaults apply independently. Chat model selection does not force all utility traffic through Cocopi." },
  { route: "Skills, instructions, hooks and plugins", status: "Host supplied", detail: "Cocopi consumes the supplied prompt and tools. Discovery, enablement, hooks and policy belong to the host." },
  { route: "Runtime extensions / canvases", status: "Not implemented", detail: "No Cocopi joinSession companion is installed. It would add a separate process and would not gain SecretStorage access automatically." },
  { route: "Dynamic workflows", status: "Host excluded", detail: "The inspected host excludes workflow tools. Cocopi does not call workflow RPCs to bypass this gate." },
  { route: "Context Size", status: "Conservative default", detail: "Cocopi defaults to the lowest catalog tier and a fixed recommended input budget. Agent Host drops context choices/defaults; disabling cocopi.lowestContextWindow restores extended reporting, not bridge parity." },
  { route: "Remote / mobile / detached chat", status: "Not implemented", detail: "No independent Cocopi service. Current BYOK inference depends on a serving extension host; remote client BYOK is unsupported in the inspected host." }
]);

/**
 * @typedef {{ id: string, name: string, filename: string, model: string, content: string }} CocopiSdkAgentProfile
 */

/**
 * Generate only profiles whose aliases the current enabled matrix publishes.
 * Unsupported SDK efforts are reported, never dropped or converted silently.
 *
 * @param {import('./subagent-matrix.js').SubagentMatrix | undefined} settings
 * @param {readonly import('../../data/Codex.js').CodexModelSummary[]} models
 * @returns {{ profiles: CocopiSdkAgentProfile[], rejected: { id: string, reason: string }[] }}
 */
export function createCocopiSdkAgentProfiles(settings, models) {
  const matrix = resolveSubagentMatrix(normalizeSubagentMatrix(settings), models);
  /** @type {CocopiSdkAgentProfile[]} */
  const profiles = [];
  /** @type {{ id: string, reason: string }[]} */
  const rejected = [];
  for (const choice of matrix.choices) {
    let reason;
    if (!matrix.enabled) {
      reason = "The subagent matrix is disabled; its aliases are not published.";
    } else if (!subagentChoiceAvailable(choice, models)) {
      reason = "The model/effort route is unavailable in this catalog, or is a symbolic Ultra parent.";
    } else if (choice.reasoningEffort !== "not-applicable" && !SDK_AGENT_EFFORTS.has(choice.reasoningEffort)) {
      reason = `The SDK agent parser does not accept effort ${choice.reasoningEffort}.`;
    }
    if (reason) {
      rejected.push({ id: choice.id, reason });
      continue;
    }
    const name = `cocopi-${choice.id}`;
    const model = `cocopi/subagent-${choice.id}`;
    const description = `${choice.label}: ${choice.model}, ${choice.reasoningEffort}. ${choice.description}`.trim();
    const content = [
      "---",
      `name: ${JSON.stringify(name)}`,
      `description: ${JSON.stringify(description)}`,
      `model: ${JSON.stringify(model)}`,
      ...(choice.reasoningEffort === "not-applicable" ? [] : [`reasoning-effort: ${JSON.stringify(choice.reasoningEffort)}`]),
      // Deliberately omit tools: []: the pinned converter interprets it as ALL.
      "---",
      "",
      `Provider route: ${choice.model}; effort: ${choice.reasoningEffort}.`,
      "Use only the tools exposed and permitted by the host. Respect user instructions and approval requirements.",
      "Delegate only when the user permits it. This profile does not authorize delegation or enforce the Local routing matrix.",
      "",
      COCOPI_SDK_PROFILE_WARNING,
      ""
    ].join("\n");
    profiles.push({ id: choice.id, name, filename: `${name}.agent.md`, model, content });
  }
  return { profiles, rejected };
}

/**
 * The SDK task tool uses agent_type, not a Local runSubagent display name.
 * Only host-enumerated names can be candidates; do not infer saved file contents
 * or model identity from the name, and never change tool schema or arguments.
 * @template {{ name: string, description: string, inputSchema?: object }} T
 * @param {readonly T[]} tools
 * @param {import('./subagent-matrix.js').SubagentMatrix | undefined} settings
 * @param {readonly import('../../data/Codex.js').CodexModelSummary[]} models
 * @returns {T[]}
 */
export function withSdkCustomAgentGuidance(tools, settings, models) {
  if (!COCOPI_PROPOSED_APIS_ENABLED) return [...tools];
  return tools.map((tool) => {
    if (tool.name !== "task") return tool;
    const schema = /** @type {{ properties?: { agent_type?: { enum?: readonly unknown[] } } }} */ (tool.inputSchema);
    const names = schema?.properties?.agent_type?.enum;
    if (!Array.isArray(names) || names.length === 0) return tool;
    const candidates = createCocopiSdkAgentProfiles(settings, models).profiles.filter((profile) => names.includes(profile.name));
    if (candidates.length === 0) return tool;
    const menu = candidates.map((profile) => `- agent_type ${JSON.stringify(profile.name)}; expected profile model ${JSON.stringify(profile.model)}.`).join("\n");
    return {
      ...tool,
      description: `${tool.description}\n\nHost-listed agent names matching configured Cocopi SDK profile candidates:\n${menu}\nUse agent_type only when delegation is permitted and that agent suits the task. Names alone do not verify the saved profile's model or effort. Verify discovery and routing; SDK parent-model fallback remains possible. Do not use Local runSubagent display names here, add invented arguments, or treat the Local parent/target matrix as SDK enforcement. Explicit user choices and host permissions remain authoritative. No automatic agent selection or quota isolation is implied.`
    };
  });
}