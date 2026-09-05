/**
 * @typedef {{ id: string, model: string, reasoningEffort: string, label: string, description: string }} SubagentChoice
 * @typedef {{ enabled: boolean, defaultChoice: string, choices: SubagentChoice[], routes?: { parent: string, targets: string[] }[], preset?: "gpt6-ultra" }} SubagentMatrix
 */

/* eslint-disable jsdoc/check-types -- Settings and webview messages are untyped external data. */
/**
 * @param {unknown} value
 * @returns {SubagentMatrix}
 */
export function normalizeSubagentMatrix(value) {
  const record = /** @type {Partial<SubagentMatrix> | undefined} */ (value);
  if (record?.preset === "gpt6-ultra") {
    return { enabled: true, defaultChoice: "", choices: [], preset: "gpt6-ultra" };
  }
  const choices = (Array.isArray(record?.choices) ? record.choices : []).slice(0, 256).filter((choice, index, all) =>
    choice && typeof choice.id === "string" && /^[a-z0-9-]{1,48}$/u.test(choice.id)
    && typeof choice.model === "string" && /^[a-zA-Z0-9._-]+$/u.test(choice.model)
    && !choice.model.startsWith("subagent-") && !["auto", "utility", "utility-small", "autocomplete"].includes(choice.model)
    && typeof choice.reasoningEffort === "string" && /^[a-zA-Z0-9_-]{1,64}$/u.test(choice.reasoningEffort)
    && !["default", "lowest"].includes(choice.reasoningEffort)
    && (choice.reasoningEffort !== "ultra" || record?.routes?.some((row) => row.parent === choice.id))
    && all.findIndex((entry) => entry?.id === choice.id) === index
  ).map((choice) => ({
    id: choice.id, model: choice.model, reasoningEffort: choice.reasoningEffort,
    label: typeof choice.label === "string" ? choice.label.slice(0, 60) : choice.id,
    description: typeof choice.description === "string" ? choice.description.replaceAll(/\s+/gu, " ").slice(0, 240) : ""
  }));
  const defaultChoice = choices.some((choice) => choice.id === record?.defaultChoice) ? record?.defaultChoice ?? "" : "";
  const routes = Array.isArray(record?.routes) ? choices.filter((choice) => record.routes?.some((row) => row.parent === choice.id)).map((choice) => ({
    parent: choice.id,
    targets: choices.filter((target) => target.reasoningEffort !== "ultra" && record.routes?.some((row) => row.parent === choice.id && Array.isArray(row.targets) && row.targets.includes(target.id))).map((target) => target.id)
  })) : undefined;
  return { enabled: record?.enabled === true && (routes ? true : Boolean(defaultChoice)), defaultChoice, choices, ...(routes ? { routes } : {}) };
}
/* eslint-enable jsdoc/check-types */

/**
 * Expand the operating default from available catalog entries, never invented capabilities.
 * @param {SubagentMatrix | undefined} matrix
 * @param {readonly import('../../data/Codex.js').CodexModelSummary[]} models
 * @returns {SubagentMatrix}
 */
export function resolveSubagentMatrix(matrix, models) {
  matrix ??= normalizeSubagentMatrix({});
  if (matrix.preset !== "gpt6-ultra") return matrix;
  const eligible = models.filter((model) => /^gpt-(?:5\.6|6)(?:[.-]|$)/iu.test(model.id) && !/(?:^|[-:])(?:fast|ultra)(?:[-:]|$)/iu.test(model.id));
  const choices = eligible.flatMap((model) => (model.supportedReasoningLevels?.length === 0 ? ["not-applicable"] : (model.supportedReasoningLevels ?? []).map((level) => level.effort))
    .filter((effort) => !["ultra", "default", "lowest"].includes(effort))
    .map((effort) => ({ id: `${model.id.replaceAll(".", "-")}-${effort}`, model: model.id, reasoningEffort: effort, label: `${model.id}-${effort}`, description: "" })));
  const targets = choices.map((choice) => choice.id);
  const parents = eligible.filter((model) => /^gpt-6(?:[.-]|$)/iu.test(model.id)).map((model) => ({ id: `${model.id.replaceAll(".", "-")}-ultra`, model: model.id, reasoningEffort: "ultra", label: `${model.id}-ultra`, description: "" }));
  return { enabled: true, defaultChoice: targets[0] ?? "", choices: [...choices, ...parents], routes: parents.map((parent) => ({ parent: parent.id, targets: [...targets] })) };
}

/**
 * Select the current parent's directed row without changing the global alias catalog.
 * @param {SubagentMatrix | undefined} matrix
 * @param {string} model
 * @param {string} [effort]
 * @returns {SubagentMatrix | undefined}
 */
export function subagentMatrixForParent(matrix, model, effort) {
  if (!matrix?.routes) {
    return matrix;
  }
  const parent = matrix.choices.find((choice) => choice.model === model && choice.reasoningEffort === (effort ?? "not-applicable"));
  const targets = matrix.routes.find((row) => row.parent === parent?.id)?.targets ?? [];
  const choices = matrix.choices.filter((choice) => targets.includes(choice.id));
  return { enabled: matrix.enabled, choices, defaultChoice: choices.some((choice) => choice.id === matrix.defaultChoice) ? matrix.defaultChoice : choices[0]?.id ?? "" };
}

/** @param {SubagentChoice} choice */
export function subagentChoiceName(choice) {
  return `Cocopi Subagent ${choice.id}`;
}

/**
 * @param {SubagentChoice} choice
 * @param {readonly import('../../data/Codex.js').CodexModelSummary[]} models
 */
export function subagentChoiceAvailable(choice, models) {
  if (choice.reasoningEffort === "ultra") return false;
  const model = models.find((candidate) => candidate.id === choice.model);
  return Boolean(model?.supportedReasoningLevels && (model.supportedReasoningLevels.length === 0
    ? choice.reasoningEffort === "not-applicable"
    : model.supportedReasoningLevels.some((level) => level.effort === choice.reasoningEffort)));
}

/**
 * @param {string} id
 * @param {SubagentMatrix | undefined} matrix
 * @param {readonly import('../../data/Codex.js').CodexModelSummary[]} models
 */
export function resolveSubagentChoice(id, matrix, models) {
  const normalized = id.replace(/^cocopi\//u, "");
  if (!normalized.startsWith("subagent-")) {
    return;
  }
  const choice = matrix?.choices.find((entry) => `subagent-${entry.id}` === normalized);
  if (!matrix?.enabled || !choice || !subagentChoiceAvailable(choice, models)) {
    throw new Error(`Cocopi subagent route ${normalized} is unavailable. Configure an available model and effort in the Subagents matrix.`);
  }
  return choice;
}

/** @param {readonly { name: string, inputSchema?: object }[]} tools */
function supportsSubagentModel(tools) {
  return tools.some((tool) => tool.name === "runSubagent" && Object.hasOwn(
    /** @type {{ properties?: object }} */ (tool.inputSchema ?? {}).properties ?? {}, "model"
  ));
}

/**
 * @param {SubagentMatrix | undefined} matrix
 * @param {readonly { name: string, inputSchema?: object }[]} tools
 * @param {string | undefined} inherited
 */
export function subagentDefaultModel(matrix, tools, inherited) {
  const choice = matrix?.enabled && supportsSubagentModel(tools)
    ? matrix.choices.find((entry) => entry.id === matrix.defaultChoice) : undefined;
  return choice ? `${subagentChoiceName(choice)} (cocopi)` : inherited;
}

/**
 * Copy only the model-facing tool; preserve the host argument contract.
 * @template {{ name: string, description: string, inputSchema?: object }} T
 * @param {readonly T[]} tools
 * @param {SubagentMatrix | undefined} matrix
 * @returns {T[]}
 */
export function withSubagentMatrixGuidance(tools, matrix) {
  if (matrix?.enabled && matrix.choices.length === 0) {
    return tools.filter((tool) => tool.name !== "runSubagent");
  }
  if (!matrix?.enabled || !supportsSubagentModel(tools)) {
    return [...tools];
  }
  const menu = matrix.choices.map((choice) => `- ${JSON.stringify(`${subagentChoiceName(choice)} (cocopi)`)}: ${choice.model}, effort ${choice.reasoningEffort}${choice.id === matrix.defaultChoice ? " (default)" : ""}. ${JSON.stringify(choice.label)}: ${JSON.stringify(choice.description)}`).join("\n");
  return tools.map((tool) => tool.name === "runSubagent" ? {
    ...tool,
    description: `${tool.description}\n\nUser-configured Cocopi model overrides (set model to the exact qualified name):\n${menu}\nPrefer the least intensive configured choice adequate for a concrete, bounded task. Keep trivial or immediate blocking work local; avoid duplicate work. Choose agent role separately and avoid elaborate workflows for simple tasks. Return concise findings. This menu does not authorize delegation against user restrictions. Blank model uses the configured default, not parent inheritance. Explicit model selections remain allowed. These are model/effort routes, not total token budgets.`
  } : tool);
}