/** @typedef {import("../../data/Codex.js").CodexJsonValue} CodexJsonValue */
/** @typedef {import("../../data/Codex.js").CodexResponseCreateRequest} CodexResponseCreateRequest */
/** @typedef {import("../../data/Codex.js").CodexResponseInclude} CodexResponseInclude */
/** @typedef {import("../../data/Codex.js").CodexResponseInput} CodexResponseInput */
/** @typedef {import("../../data/Codex.js").CodexResponseInputItem} CodexResponseInputItem */
/** @typedef {import("../../data/Codex.js").CodexReasoning} CodexReasoning */
/** @typedef {import("../../data/Codex.js").CodexServiceTier | "auto"} CocopiServiceTier */
/** @typedef {import("../../data/Codex.js").CodexTool} CodexTool */
/** @typedef {import("../../data/Codex.js").CodexToolChoice} CodexToolChoice */

/**
 * @param {{
 *   model: string,
 *   input: string | CodexResponseInputItem[],
 *   instructions?: string,
 *   tools?: CodexTool[],
 *   toolChoice?: CodexToolChoice,
 *   parallelToolCalls?: boolean,
 *   stream?: boolean,
 *   serviceTier?: CocopiServiceTier,
 *   include?: CodexResponseInclude[],
 *   reasoning?: CodexReasoning | null,
 *   previousResponseId?: string,
 *   promptCacheKey?: string,
 *   clientMetadata?: Record<string, CodexJsonValue>
 * }} options
 * @returns {CodexResponseCreateRequest}
 */
export function buildTextResponseBody(options) {
  /** @type {CodexResponseCreateRequest} */
  const body = {
    model: options.model,
    input: normalizeResponseInput(options.input),
    tools: options.tools ?? [],
    tool_choice: options.toolChoice ?? "auto",
    parallel_tool_calls: options.parallelToolCalls ?? false,
    store: false,
    stream: options.stream ?? true,
    include: options.include ?? [],
    prompt_cache_key: options.promptCacheKey,
    client_metadata: options.clientMetadata
  };
  if (options.instructions) {
    body.instructions = options.instructions;
  }
  if (options.previousResponseId) {
    body.previous_response_id = options.previousResponseId;
  }
  if (Object.hasOwn(options, "reasoning")) {
    body.reasoning = options.reasoning ?? null;
  }

  const serviceTier = codexServiceTierForRequest(options.serviceTier);
  if (serviceTier) {
    body.service_tier = serviceTier;
  }

  return body;
}

/**
 * @param {CocopiServiceTier | undefined} serviceTier
 * @returns {import("../../data/Codex.js").CodexServiceTier | undefined}
 */
export function codexServiceTierForRequest(serviceTier) {
  if (!serviceTier || serviceTier === "auto") {
    return;
  }

  return serviceTier;
}

/**
 * @param {string | CodexResponseInputItem[]} input
 * @returns {CodexResponseInput}
 */
function normalizeResponseInput(input) {
  if (typeof input !== "string") {
    return input;
  }

  return [{
    role: "user",
    content: [{ type: "input_text", text: input }]
  }];
}
