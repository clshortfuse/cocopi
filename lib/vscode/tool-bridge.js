/** @typedef {import("../../data/Codex.js").CodexJsonValue} CodexJsonValue */
/** @typedef {import("../../data/Codex.js").CodexTool} CodexTool */
/** @typedef {import("../../data/Codex.js").CodexToolChoice} CodexToolChoice */
/** @typedef {import("../../data/Codex.js").CodexResponseStreamEvent} CodexResponseStreamEvent */
/** @typedef {import("../../data/Codex.js").CodexResponseFunctionCallInputItem} CodexResponseFunctionCallInputItem */
/** @typedef {import("../../data/Codex.js").CodexResponseFunctionCallOutputInputItem} CodexResponseFunctionCallOutputInputItem */
/** @typedef {import("../../data/Codex.js").CodexResponseReasoningInputItem} CodexResponseReasoningInputItem */

/**
 * @typedef {object} CodexToolCall
 * @property {string} callId
 * @property {string} name
 * @property {Record<string, CodexJsonValue>} input
 * @property {string} [rawArguments]
 */

/**
 * @typedef {object} CodexToolOptions
 * @property {boolean} [strict]
 * @property {boolean} [stream]
 */

/** @typedef {'string' | 'number' | 'boolean' | 'integer' | 'object' | 'array' | 'null'} CodexJsonSchemaPrimitiveType */

/**
 * JSON Schema subset accepted by the Codex/OpenAI tool bridge.
 *
 * @typedef {object} CodexToolParametersSchema
 * @property {CodexJsonSchemaPrimitiveType | CodexJsonSchemaPrimitiveType[]} [type]
 * @property {string} [description]
 * @property {CodexJsonValue[]} [enum]
 * @property {CodexToolParametersSchema} [items]
 * @property {Record<string, CodexToolParametersSchema>} [properties]
 * @property {string[]} [required]
 * @property {boolean | CodexToolParametersSchema} [additionalProperties]
 * @property {CodexToolParametersSchema[]} [anyOf]
 */

const CODEX_TOOL_SCHEMA_TYPES = new Set(["string", "number", "boolean", "integer", "object", "array", "null"]);
const RUN_SUBAGENT_TOOL_NAME = "runSubagent";
const TOOL_PREFERRED_PROPERTY_ORDERS = /** @type {Readonly<Record<string, readonly string[]>>} */ (Object.freeze({
  create_file: Object.freeze(["filePath", "content"])
}));
const UNSUPPORTED_VSCODE_TOOL_SCHEMA_METADATA_KEYS = new Set([
  "deprecationMessage",
  "editPresentation",
  "enumDescriptions",
  "enumItemLabels",
  "markdownDescription",
  "markdownEnumDescriptions",
  "order",
  "scope",
  "tags"
]);

/**
 * VS Code/Copilot may compile these same per-request schemas when executing
 * returned tool calls. Remove VS Code UI metadata that strict JSON Schema
 * validators reject while keeping validation keywords intact.
 *
 * @param {import("vscode").ProvideLanguageModelChatResponseOptions["tools"] | readonly import("vscode").LanguageModelToolInformation[]} tools
 * @returns {number}
 */
export function stripUnsupportedLanguageModelToolSchemaMetadata(tools) {
  let stripped = 0;
  for (const tool of tools ?? []) {
    const result = languageModelToolSchemaWithoutUnsupportedMetadata(tool.inputSchema);
    stripped += result.stripped;
    if (result.stripped > 0 && !Reflect.set(tool, "inputSchema", result.value)) {
      stripped += stripUnsupportedSchemaMetadata(tool.inputSchema);
    }
  }
  return stripped;
}

/**
 * @param {{ id?: string, name?: string } | undefined} model
 * @param {string} vendor
 * @returns {string | undefined}
 */
export function languageModelQualifiedName(model, vendor) {
  const name = cleanString(model?.name) ?? cleanString(model?.id);
  const cleanVendor = cleanString(vendor);
  return name && cleanVendor ? `${name} (${cleanVendor})` : undefined;
}

/**
 * VS Code 1.119's runSubagent tool falls back to Copilot when the inherited
 * internal modelId is blank. Pin blank/omitted explicit subagent model input to
 * the active Cocopi model so the tool resolves a concrete extension model.
 *
 * @param {CodexToolCall | undefined} toolCall
 * @param {string | undefined} defaultModel
 * @returns {CodexToolCall | undefined}
 */
export function withDefaultRunSubagentToolModel(toolCall, defaultModel) {
  if (!toolCall || toolCall.name !== RUN_SUBAGENT_TOOL_NAME || !defaultModel) {
    return toolCall;
  }

  const currentModel = toolCall.input.model;
  if (typeof currentModel === "string" && currentModel.trim()) {
    return toolCall;
  }

  const input = {
    ...toolCall.input,
    model: defaultModel
  };
  return {
    ...toolCall,
    input,
    rawArguments: stableCodexJsonString(input)
  };
}

/**
 * @param {import("vscode").ProvideLanguageModelChatResponseOptions["tools"]} tools
 * @param {CodexToolOptions} [options]
 * @returns {CodexTool[]}
 */
export function codexToolsFromLanguageModelTools(tools, options = {}) {
  if (!tools || tools.length === 0) {
    return [];
  }

  return [...tools]
    .map((tool, index) => ({ tool, index }))
    .toSorted((left, right) => left.tool.name.localeCompare(right.tool.name) || left.index - right.index)
    .map(({ tool }) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: codexToolParametersForLanguageModelTool(tool, options),
      ...(typeof options.strict === "boolean" ? { strict: options.strict } : {})
    }));
}

/**
 * Removes `null` values emitted for strict-mode optional tool arguments before
 * handing inputs back to VS Code's original tool schema.
 *
 * @param {CodexToolCall | undefined} toolCall
 * @param {import("vscode").ProvideLanguageModelChatResponseOptions["tools"] | readonly import("vscode").LanguageModelToolInformation[]} tools
 * @returns {CodexToolCall | undefined}
 */
export function withOptionalNullToolArgumentsRemoved(toolCall, tools) {
  if (!toolCall || !tools || tools.length === 0) {
    return toolCall;
  }

  const tool = [...tools].find((candidate) => candidate.name === toolCall.name);
  if (!tool?.inputSchema) {
    return toolCall;
  }

  const input = pruneOptionalNullsForSchema(toolCall.input, tool.inputSchema);
  if (input === toolCall.input) {
    return toolCall;
  }

  return {
    ...toolCall,
    input,
    rawArguments: stableCodexJsonString(input)
  };
}

/**
 * @param {number | undefined} toolMode
 * @param {boolean} hasTools
 * @param {number} requiredToolMode
 * @returns {CodexToolChoice}
 */
export function codexToolChoiceFromLanguageModelToolMode(toolMode, hasTools, requiredToolMode) {
  if (!hasTools) {
    return "none";
  }

  return toolMode === requiredToolMode ? "required" : "auto";
}

/**
 * @param {CodexResponseStreamEvent} event
 * @returns {CodexToolCall | undefined}
 */
export function readCodexToolCall(event) {
  if (event.type === "response.function_call_arguments.done") {
    return toolCallFromFunctionArgumentsDoneEvent(event);
  }

  if (event.type === "response.output_item.done") {
    return toolCallFromOutputItemDoneEvent(event);
  }
}

/**
 * @param {CodexResponseStreamEvent} event
 * @returns {{ callId: string, name: string, outputIndex: number, itemId?: string, sequenceNumber?: number } | undefined}
 */
export function readCodexToolCallStart(event) {
  if (event.type !== "response.output_item.added") {
    return;
  }

  const item = event.item;
  if (!item || typeof item !== "object" || Array.isArray(item) || item.type !== "function_call") {
    return;
  }

  const name = cleanString(item.name);
  const callId = cleanString(item.call_id) ?? cleanString(item.id);
  if (!name || !callId) {
    return;
  }

  return {
    callId,
    name,
    outputIndex: event.output_index,
    ...(typeof item.id === "string" ? { itemId: item.id } : {}),
    ...(typeof event.sequence_number === "number" ? { sequenceNumber: event.sequence_number } : {})
  };
}

/**
 * @param {CodexResponseStreamEvent} event
 * @returns {CodexResponseReasoningInputItem | undefined}
 */
export function readCodexReasoningInputItem(event) {
  if (event.type !== "response.output_item.done") {
    return;
  }

  const item = event.item;
  if (!item || typeof item !== "object" || Array.isArray(item) || item.type !== "reasoning") {
    return;
  }

  return /** @type {CodexResponseReasoningInputItem} */ ({ ...item });
}

/**
 * @param {CodexToolCall} toolCall
 * @returns {CodexResponseFunctionCallInputItem}
 */
export function codexFunctionCallInputItemFromToolCall(toolCall) {
  return {
    type: "function_call",
    call_id: toolCall.callId,
    name: toolCall.name,
    arguments: toolCall.rawArguments ?? stableCodexJsonString(toolCall.input)
  };
}

/**
 * @param {CodexJsonValue} value
 * @returns {string}
 */
export function stableCodexJsonString(value) {
  return JSON.stringify(stableJsonValue(value));
}

/**
 * @param {string} callId
 * @param {import("vscode").LanguageModelToolResult} result
 * @returns {CodexResponseFunctionCallOutputInputItem}
 */
export function codexFunctionCallOutputInputItemFromToolResult(callId, result) {
  return {
    type: "function_call_output",
    call_id: callId,
    output: result.content.map((part) => textFromToolResultPart(part)).filter(Boolean).join("\n\n")
  };
}

/**
 * @param {{ name: string, inputSchema?: object }} tool
 * @param {CodexToolOptions} [options]
 * @returns {Record<string, CodexJsonValue>}
 */
function codexToolParametersForLanguageModelTool(tool, options = {}) {
  return withPreferredToolPropertyOrder(tool.name, codexToolParametersFromInputSchema(tool.inputSchema, options));
}

/**
 * @param {string} toolName
 * @param {Record<string, CodexJsonValue>} parameters
 * @returns {Record<string, CodexJsonValue>}
 */
function withPreferredToolPropertyOrder(toolName, parameters) {
  const preferredOrder = TOOL_PREFERRED_PROPERTY_ORDERS[toolName];
  const properties = parameters.properties;
  if (!preferredOrder || !isCodexRecord(properties) || !preferredOrder.every((key) => Object.hasOwn(properties, key))) {
    return parameters;
  }

  const required = preferredToolRequiredStrings(parameters.required, preferredOrder);
  if (required === null) {
    return parameters;
  }

  return {
    ...parameters,
    properties: orderedRecord(properties, preferredOrder),
    ...(required ? { required: orderedStrings(required, preferredOrder) } : {})
  };
}

/**
 * @param {CodexJsonValue | undefined} required
 * @param {readonly string[]} preferredOrder
 * @returns {string[] | undefined | null}
 */
function preferredToolRequiredStrings(required, preferredOrder) {
  if (required === undefined) {
    return;
  }

  if (!Array.isArray(required)) {
    return null;
  }

  const requiredStrings = required.filter((item) => typeof item === "string");
  if (requiredStrings.length !== required.length || !preferredOrder.every((key) => requiredStrings.includes(key))) {
    return null;
  }

  return requiredStrings;
}

/**
 * @param {Record<string, CodexJsonValue>} value
 * @param {readonly string[]} preferredOrder
 * @returns {Record<string, CodexJsonValue>}
 */
function orderedRecord(value, preferredOrder) {
  /** @type {Record<string, CodexJsonValue>} */
  const ordered = {};
  for (const key of preferredOrder) {
    if (Object.hasOwn(value, key)) {
      ordered[key] = value[key];
    }
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(ordered, key)) {
      ordered[key] = value[key];
    }
  }
  return ordered;
}

/**
 * @param {string[]} value
 * @param {readonly string[]} preferredOrder
 * @returns {string[]}
 */
function orderedStrings(value, preferredOrder) {
  const remaining = new Set(value);
  const ordered = preferredOrder.filter((key) => {
    if (!remaining.has(key)) {
      return false;
    }
    remaining.delete(key);
    return true;
  });
  return [...ordered, ...value.filter((key) => remaining.has(key))];
}

/**
 * @param {CodexJsonValue | undefined} value
 * @returns {value is Record<string, CodexJsonValue>}
 */
function isCodexRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * @param {object | undefined} inputSchema
 * @param {CodexToolOptions} [options]
 * @returns {Record<string, CodexJsonValue>}
 */
function codexToolParametersFromInputSchema(inputSchema, options = {}) {
  if (inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema)) {
    const normalized = normalizeCodexToolParametersSchema(inputSchema);
    return /** @type {Record<string, CodexJsonValue>} */ (stableJsonValue(options.strict ? strictCodexToolParametersSchema(normalized) : normalized));
  }

  const fallback = codexToolObjectSchemaFallback();
  return /** @type {Record<string, CodexJsonValue>} */ (stableJsonValue(options.strict ? strictCodexToolParametersSchema(fallback) : fallback));
}

/* eslint-disable jsdoc/check-types -- VS Code tool schemas are external JSON-like data before metadata stripping. */
/**
 * @param {unknown} value
 * @returns {{ value: unknown, stripped: number }}
 */
function languageModelToolSchemaWithoutUnsupportedMetadata(value) {
  if (Array.isArray(value)) {
    let stripped = 0;
    const items = value.map((item) => {
      const result = languageModelToolSchemaWithoutUnsupportedMetadata(item);
      stripped += result.stripped;
      return result.value;
    });
    return { value: items, stripped };
  }

  if (!value || typeof value !== "object") {
    return { value, stripped: 0 };
  }

  /** @type {Record<string, unknown>} */
  const cleaned = {};
  let stripped = 0;
  for (const key of Object.keys(value)) {
    if (UNSUPPORTED_VSCODE_TOOL_SCHEMA_METADATA_KEYS.has(key)) {
      stripped += 1;
      continue;
    }

    const result = languageModelToolSchemaWithoutUnsupportedMetadata(Reflect.get(value, key));
    stripped += result.stripped;
    cleaned[key] = result.value;
  }

  return { value: cleaned, stripped };
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function stripUnsupportedSchemaMetadata(value) {
  if (!value || typeof value !== "object") {
    return 0;
  }

  let stripped = 0;
  for (const key of Object.keys(value)) {
    if (UNSUPPORTED_VSCODE_TOOL_SCHEMA_METADATA_KEYS.has(key)) {
      if (Reflect.deleteProperty(value, key)) {
        stripped += 1;
      }
      continue;
    }

    stripped += stripUnsupportedSchemaMetadata(Reflect.get(value, key));
  }

  return stripped;
}
/* eslint-enable jsdoc/check-types */

/** @returns {CodexToolParametersSchema} */
function codexToolObjectSchemaFallback() {
  return {
    type: "object",
    properties: {},
    additionalProperties: false
  };
}

/**
 * @param {object} inputSchema
 * @returns {CodexToolParametersSchema}
 */
function normalizeCodexToolParametersSchema(inputSchema) {
  const normalized = normalizeCodexJsonSchema(inputSchema);
  if (!schemaHasType(normalized, "object")) {
    normalized.type = "object";
  }
  if (!normalized.properties) {
    normalized.properties = {};
  }
  return normalized;
}

/**
 * @param {CodexToolParametersSchema} schema
 * @returns {CodexToolParametersSchema}
 */
function strictCodexToolParametersSchema(schema) {
  /** @type {CodexToolParametersSchema} */
  const strict = { ...schema };

  if (schema.items) {
    strict.items = strictCodexToolParametersSchema(schema.items);
  }

  if (schema.anyOf) {
    strict.anyOf = schema.anyOf.map((item) => strictCodexToolParametersSchema(item));
  }

  if (schemaHasType(schema, "object")) {
    const required = schema.required ? new Set(schema.required) : new Set();
    const properties = /** @type {Record<string, CodexToolParametersSchema>} */ ({});
    for (const key of Object.keys(schema.properties ?? {}).toSorted()) {
      const property = strictCodexToolParametersSchema(/** @type {Record<string, CodexToolParametersSchema>} */ (schema.properties)[key]);
      properties[key] = required.has(key) ? property : nullableCodexToolParametersSchema(property);
    }
    strict.properties = properties;
    strict.required = Object.keys(properties);
    strict.additionalProperties = false;
  }

  return strict;
}

/**
 * @param {CodexToolParametersSchema} schema
 * @returns {CodexToolParametersSchema}
 */
function nullableCodexToolParametersSchema(schema) {
  if (schemaAllowsNull(schema)) {
    return schema;
  }

  /** @type {CodexToolParametersSchema} */
  const nullable = { ...schema };
  if (schema.type) {
    nullable.type = Array.isArray(schema.type) ? [...schema.type, "null"] : [schema.type, "null"];
  } else if (schema.anyOf) {
    nullable.anyOf = [...schema.anyOf, { type: "null" }];
  } else {
    nullable.type = ["string", "null"];
  }
  if (schema.enum && !schema.enum.includes(null)) {
    nullable.enum = [...schema.enum, null];
  }
  return nullable;
}

/**
 * @param {CodexToolParametersSchema} schema
 * @returns {boolean}
 */
function schemaAllowsNull(schema) {
  return schemaHasType(schema, "null")
    || Boolean(schema.anyOf?.some((item) => schemaAllowsNull(item)))
    || Boolean(schema.enum?.includes(null));
}

/* eslint-disable jsdoc/check-types -- VS Code tool schemas are external JSON-like data before subset normalization. */
/**
 * @param {unknown} input
 * @returns {CodexToolParametersSchema}
 */
function normalizeCodexJsonSchema(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { type: "string" };
  }

  /** @type {Record<string, unknown>} */
  const raw = /** @type {Record<string, unknown>} */ (input);
  /** @type {CodexToolParametersSchema} */
  const schema = {};

  const description = stringProperty(raw, "description");
  if (description !== undefined) {
    schema.description = description;
  }

  const anyOf = schemaArrayProperty(raw, "anyOf");
  if (anyOf) {
    schema.anyOf = anyOf.map((item) => normalizeCodexJsonSchema(item));
  }

  const schemaTypes = normalizedSchemaTypes(raw.type);
  if (schemaTypes.length > 0) {
    schema.type = schemaTypes.length === 1 ? schemaTypes[0] : schemaTypes;
  } else if (!schema.anyOf) {
    schema.type = inferCodexJsonSchemaType(raw);
  }

  const enumValues = arrayProperty(raw, "enum");
  if (enumValues) {
    schema.enum = enumValues.map((item) => stableJsonValue(item));
  } else if (Object.hasOwn(raw, "const")) {
    schema.enum = [stableJsonValue(raw.const)];
  }

  if (schemaHasType(schema, "object")) {
    schema.properties = normalizeCodexJsonSchemaProperties(raw.properties);
    const required = stringArrayProperty(raw, "required");
    if (required) {
      schema.required = required;
    }
    const additionalProperties = normalizeCodexJsonSchemaAdditionalProperties(raw.additionalProperties);
    if (additionalProperties !== undefined) {
      schema.additionalProperties = additionalProperties;
    }
  }

  if (schemaHasType(schema, "array")) {
    schema.items = normalizeCodexJsonSchema(raw.items);
  }

  return schema;
}

/**
 * @param {unknown} value
 * @returns {CodexJsonSchemaPrimitiveType[]}
 */
function normalizedSchemaTypes(value) {
  if (typeof value === "string" && CODEX_TOOL_SCHEMA_TYPES.has(value)) {
    return [/** @type {CodexJsonSchemaPrimitiveType} */ (value)];
  }

  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string" && CODEX_TOOL_SCHEMA_TYPES.has(item));
  }

  return [];
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {CodexJsonSchemaPrimitiveType}
 */
function inferCodexJsonSchemaType(raw) {
  if (Object.hasOwn(raw, "properties") || Object.hasOwn(raw, "required") || Object.hasOwn(raw, "additionalProperties")) {
    return "object";
  }
  if (Object.hasOwn(raw, "items") || Object.hasOwn(raw, "prefixItems")) {
    return "array";
  }
  if (Object.hasOwn(raw, "enum") || Object.hasOwn(raw, "const") || Object.hasOwn(raw, "format")) {
    return "string";
  }
  if (Object.hasOwn(raw, "minimum") || Object.hasOwn(raw, "maximum") || Object.hasOwn(raw, "exclusiveMinimum") || Object.hasOwn(raw, "exclusiveMaximum") || Object.hasOwn(raw, "multipleOf")) {
    return "number";
  }
  return "string";
}

/**
 * @param {unknown} value
 * @returns {Record<string, CodexToolParametersSchema>}
 */
function normalizeCodexJsonSchemaProperties(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  /** @type {Record<string, CodexToolParametersSchema>} */
  const properties = {};
  for (const key of Object.keys(value).toSorted()) {
    properties[key] = normalizeCodexJsonSchema(Reflect.get(value, key));
  }
  return properties;
}

/**
 * @param {unknown} value
 * @returns {boolean | CodexToolParametersSchema | undefined}
 */
function normalizeCodexJsonSchemaAdditionalProperties(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return normalizeCodexJsonSchema(value);
  }
}

/**
 * @param {CodexToolParametersSchema} schema
 * @param {CodexJsonSchemaPrimitiveType} type
 */
function schemaHasType(schema, type) {
  return schema.type === type || (Array.isArray(schema.type) && schema.type.includes(type));
}

/**
 * @param {Record<string, unknown>} value
 * @param {string} key
 */
function stringProperty(value, key) {
  const property = value[key];
  return typeof property === "string" ? property : undefined;
}

/**
 * @param {Record<string, unknown>} value
 * @param {string} key
 * @returns {unknown[] | undefined}
 */
function arrayProperty(value, key) {
  const property = value[key];
  return Array.isArray(property) ? property : undefined;
}

/**
 * @param {Record<string, unknown>} value
 * @param {string} key
 * @returns {object[] | undefined}
 */
function schemaArrayProperty(value, key) {
  const property = value[key];
  return Array.isArray(property) ? property.filter((item) => item && typeof item === "object" && !Array.isArray(item)) : undefined;
}

/**
 * @param {Record<string, unknown>} value
 * @param {string} key
 * @returns {string[] | undefined}
 */
function stringArrayProperty(value, key) {
  const property = value[key];
  return Array.isArray(property) ? property.filter((item) => typeof item === "string") : undefined;
}
/* eslint-enable jsdoc/check-types */

/* eslint-disable jsdoc/check-types -- Tool schemas and arguments are external JSON-like values. */
/**
 * @param {Record<string, CodexJsonValue>} input
 * @param {unknown} schema
 * @returns {Record<string, CodexJsonValue>}
 */
function pruneOptionalNullsForSchema(input, schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return input;
  }

  const pruned = pruneOptionalNullsForSchemaValue(input, schema);
  return pruned && typeof pruned === "object" && !Array.isArray(pruned)
    ? /** @type {Record<string, CodexJsonValue>} */ (pruned)
    : input;
}

/**
 * @param {CodexJsonValue} value
 * @param {unknown} schema
 * @returns {CodexJsonValue}
 */
function pruneOptionalNullsForSchemaValue(value, schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return value;
  }

  const raw = /** @type {Record<string, unknown>} */ (schema);
  if (Array.isArray(value)) {
    const itemSchema = raw.items;
    if (!itemSchema) {
      return value;
    }

    let changed = false;
    const items = value.map((item) => {
      const next = pruneOptionalNullsForSchemaValue(item, itemSchema);
      changed ||= next !== item;
      return next;
    });
    return changed ? items : value;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const properties = raw.properties && typeof raw.properties === "object" && !Array.isArray(raw.properties)
    ? /** @type {Record<string, unknown>} */ (raw.properties)
    : {};
  const rawRequired = stringArrayProperty(raw, "required");
  const required = rawRequired ? new Set(rawRequired) : new Set();
  let changed = false;
  /** @type {Record<string, CodexJsonValue>} */
  const output = {};
  for (const [key, propertyValue] of Object.entries(/** @type {Record<string, CodexJsonValue>} */ (value))) {
    if (propertyValue === null && Object.hasOwn(properties, key) && !required.has(key)) {
      changed = true;
      continue;
    }

    const propertySchema = properties[key];
    const next = propertySchema ? pruneOptionalNullsForSchemaValue(propertyValue, propertySchema) : propertyValue;
    changed ||= next !== propertyValue;
    output[key] = next;
  }

  return changed ? output : value;
}
/* eslint-enable jsdoc/check-types */

/* eslint-disable jsdoc/check-types -- Tool schemas are external JSON-like values before canonicalization. */
/**
 * @param {unknown} value
 * @returns {CodexJsonValue}
 */
function stableJsonValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (Array.isArray(value)) {
    return value.map((item) => stableJsonValue(item));
  }

  if (value && typeof value === "object") {
    /** @type {Record<string, CodexJsonValue>} */
    const stable = {};
    for (const key of Object.keys(value).toSorted()) {
      const property = Reflect.get(value, key);
      if (property !== undefined) {
        stable[key] = stableJsonValue(property);
      }
    }
    return stable;
  }

  return null;
}
/* eslint-enable jsdoc/check-types */

/**
 * @param {import("../../data/Codex.js").CodexResponseFunctionCallArgumentsDoneEvent} event
 */
function toolCallFromFunctionArgumentsDoneEvent(event) {
  const name = cleanString(event.name);
  if (!name) {
    return;
  }

  return {
    callId: cleanString(event.call_id) ?? event.item_id,
    name,
    input: parseToolArguments(event.arguments),
    rawArguments: event.arguments
  };
}

/**
 * @param {import("../../data/Codex.js").CodexResponseOutputItemDoneEvent} event
 */
function toolCallFromOutputItemDoneEvent(event) {
  const item = event.item;
  if (!item || typeof item !== "object" || Array.isArray(item) || item.type !== "function_call") {
    return;
  }

  const name = cleanString(item.name);
  const callId = cleanString(item.call_id) ?? cleanString(item.id) ?? event.item_id;
  if (!name || !callId) {
    return;
  }

  return {
    callId,
    name,
    input: parseToolArguments(typeof item.arguments === "string" ? item.arguments : "{}"),
    rawArguments: typeof item.arguments === "string" ? item.arguments : undefined
  };
}

/**
 * @param {string} value
 * @returns {Record<string, CodexJsonValue>}
 */
function parseToolArguments(value) {
  if (!value.trim()) {
    return {};
  }

  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Codex tool call arguments must be a JSON object.");
  }

  return /** @type {Record<string, CodexJsonValue>} */ (parsed);
}

/**
 * @param {import("vscode").LanguageModelToolResult["content"][number]} part
 */
function textFromToolResultPart(part) {
  if (!part || typeof part !== "object") {
    return "";
  }

  if ("value" in part && typeof part.value === "string") {
    return part.value;
  }

  if ("value" in part && part.value && typeof part.value === "object") {
    return stringifyToolResultValue(part.value);
  }

  if ("data" in part && "mimeType" in part) {
    return textFromToolResultDataPart(part);
  }

  return "";
}

/**
 * @param {object} value
 */
function stringifyToolResultValue(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/**
 * @param {object} part
 */
function textFromToolResultDataPart(part) {
  const mimeType = "mimeType" in part ? String(part.mimeType) : "application/octet-stream";
  const data = "data" in part && part.data instanceof Uint8Array ? part.data : undefined;
  if (!data) {
    return `[${mimeType} data]`;
  }

  if (isTextLikeMimeType(mimeType)) {
    return new TextDecoder().decode(data);
  }

  return `[${mimeType} data, ${data.byteLength} bytes]`;
}

/**
 * @param {string} mimeType
 */
function isTextLikeMimeType(mimeType) {
  return mimeType.startsWith("text/") || mimeType === "application/json" || mimeType.endsWith("+json");
}

/**
 * @param {CodexJsonValue | undefined} value
 */
function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
