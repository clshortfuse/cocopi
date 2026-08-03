export const COCOPI_WORKLOAD_ROUTE_NAMES = Object.freeze({
  utility: "utility",
  utilitySmall: "utility-small",
  autocomplete: "autocomplete"
});

export const COCOPI_WORKLOAD_ALIASES = Object.freeze({
  [COCOPI_WORKLOAD_ROUTE_NAMES.utility]: "cocopi/utility",
  [COCOPI_WORKLOAD_ROUTE_NAMES.utilitySmall]: "cocopi/utility-small",
  [COCOPI_WORKLOAD_ROUTE_NAMES.autocomplete]: "cocopi/autocomplete"
});

export const COCOPI_WORKLOAD_ROUTE_DEFAULTS = Object.freeze({
  utility: Object.freeze({ model: "auto", reasoningEffort: "low", serviceTier: "auto" }),
  utilitySmall: Object.freeze({ model: "auto", reasoningEffort: "lowest", serviceTier: "auto" }),
  autocomplete: Object.freeze({ model: "", reasoningEffort: "lowest", serviceTier: "auto" })
});

/** @type {Set<string>} */
const COCOPI_WORKLOAD_ROUTE_IDS = new Set(Object.values(COCOPI_WORKLOAD_ALIASES));
/** @type {Set<string>} */
const COCOPI_WORKLOAD_ROUTE_MODEL_IDS = new Set(Object.values(COCOPI_WORKLOAD_ALIASES).map((alias) => alias.slice("cocopi/".length)));
const KNOWN_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** @typedef {"utility" | "utility-small" | "autocomplete"} CocopiWorkloadRouteName */
/** @typedef {"chat" | "utility" | "autocomplete"} CocopiWorkload */
/** @typedef {"main" | "general" | "small" | "inline"} CocopiWorkloadSubtype */

/**
 * @typedef {object} CocopiResolvedWorkloadRoute
 * @property {string} alias
 * @property {string} targetModel
 * @property {string | undefined} reasoningEffort
 * @property {"auto" | "flex" | "priority"} serviceTier
 * @property {CocopiWorkload} workload
 * @property {CocopiWorkloadSubtype} workloadSubtype
 */

/**
 * Resolve one specialized Cocopi workload model to a concrete Codex request route.
 * Explicit targets are retained while the catalog is unavailable, but stale,
 * unsupported, automatic, and recursive targets fall back once a catalog is
 * available.
 *
 * @param {CocopiWorkloadRouteName} routeName
 * @param {import("./configuration.js").CocopiConfiguration} configuration
 * @param {readonly import("../../data/Codex.js").CodexModelSummary[]} [models]
 * @returns {CocopiResolvedWorkloadRoute}
 */
export function resolveCocopiWorkloadRoute(routeName, configuration, models = []) {
  const classification = cocopiWorkloadClassification(routeName);
  const routeConfiguration = workloadRouteConfiguration(routeName, configuration);
  const configuredTarget = configuredWorkloadTarget(routeName, routeConfiguration.model, configuration);
  const targetModel = resolveWorkloadTarget(routeName, configuredTarget, configuration.model, models);
  const target = models.find((model) => model.id === targetModel);
  return {
    alias: COCOPI_WORKLOAD_ALIASES[routeName],
    targetModel,
    reasoningEffort: resolveWorkloadReasoningEffort(routeConfiguration.reasoningEffort, target),
    serviceTier: normalizeWorkloadServiceTier(routeConfiguration.serviceTier),
    ...classification
  };
}

/**
 * Classify an ordinary, non-alias Cocopi chat request.
 *
 * @param {string} requestedModel
 * @param {string} [resolvedModel]
 * @returns {CocopiResolvedWorkloadRoute}
 */
export function ordinaryCocopiWorkloadRoute(requestedModel, resolvedModel = requestedModel) {
  return {
    alias: requestedModel,
    targetModel: resolvedModel,
    reasoningEffort: undefined,
    serviceTier: "auto",
    workload: "chat",
    workloadSubtype: "main"
  };
}

/**
 * @param {string} modelId
 * @returns {CocopiWorkloadRouteName | undefined}
 */
export function cocopiWorkloadRouteNameFromModelId(modelId) {
  const normalized = modelId.startsWith("cocopi/") ? modelId.slice("cocopi/".length) : modelId;
  switch (normalized) {
    case "utility":
    case "utility-small":
    case "autocomplete": {
      return normalized;
    }
    default: {
      return;
    }
  }
}

/** @param {string} modelId */
export function isCocopiWorkloadAlias(modelId) {
  return COCOPI_WORKLOAD_ROUTE_IDS.has(modelId) || COCOPI_WORKLOAD_ROUTE_MODEL_IDS.has(modelId);
}

/**
 * @param {CocopiWorkloadRouteName} routeName
 * @returns {{ workload: CocopiWorkload, workloadSubtype: CocopiWorkloadSubtype }}
 */
function cocopiWorkloadClassification(routeName) {
  switch (routeName) {
    case COCOPI_WORKLOAD_ROUTE_NAMES.utility: {
      return { workload: "utility", workloadSubtype: "general" };
    }
    case COCOPI_WORKLOAD_ROUTE_NAMES.utilitySmall: {
      return { workload: "utility", workloadSubtype: "small" };
    }
    case COCOPI_WORKLOAD_ROUTE_NAMES.autocomplete: {
      return { workload: "autocomplete", workloadSubtype: "inline" };
    }
  }
}

/**
 * @param {CocopiWorkloadRouteName} routeName
 * @param {import("./configuration.js").CocopiConfiguration} configuration
 */
function workloadRouteConfiguration(routeName, configuration) {
  switch (routeName) {
    case COCOPI_WORKLOAD_ROUTE_NAMES.utility: {
      return configuration.routes.utility;
    }
    case COCOPI_WORKLOAD_ROUTE_NAMES.utilitySmall: {
      return configuration.routes.utilitySmall;
    }
    case COCOPI_WORKLOAD_ROUTE_NAMES.autocomplete: {
      return configuration.routes.autocomplete;
    }
  }
}

/**
 * @param {CocopiWorkloadRouteName} routeName
 * @param {string} target
 * @param {import("./configuration.js").CocopiConfiguration} configuration
 */
function configuredWorkloadTarget(routeName, target, configuration) {
  if (target.trim()) {
    return target.trim();
  }

  return routeName === COCOPI_WORKLOAD_ROUTE_NAMES.autocomplete
    ? configuration.inlineCompletions.model.trim()
    : "auto";
}

/**
 * @param {CocopiWorkloadRouteName} routeName
 * @param {string} configuredTarget
 * @param {string} fallbackModel
 * @param {readonly import("../../data/Codex.js").CodexModelSummary[]} models
 */
function resolveWorkloadTarget(routeName, configuredTarget, fallbackModel, models) {
  const normalizedTarget = normalizeWorkloadTarget(configuredTarget);
  const available = models.filter((model) => !isCocopiWorkloadAlias(model.id));
  if (normalizedTarget && normalizedTarget !== "auto" && (models.length === 0 || available.some((model) => model.id === normalizedTarget))) {
    return normalizedTarget;
  }

  return recommendedWorkloadTarget(routeName, fallbackModel, available, models.length > 0);
}

/** @param {string} target */
function normalizeWorkloadTarget(target) {
  const normalized = target.startsWith("cocopi/") ? target.slice("cocopi/".length) : target;
  if (!normalized || isCocopiWorkloadAlias(normalized) || normalized.endsWith(":fast")) {
    return;
  }
  return normalized;
}

/**
 * @param {CocopiWorkloadRouteName} routeName
 * @param {string} fallbackModel
 * @param {readonly import("../../data/Codex.js").CodexModelSummary[]} available
 * @param {boolean} catalogAvailable
 */
function recommendedWorkloadTarget(routeName, fallbackModel, available, catalogAvailable) {
  const preferredId = routeName === COCOPI_WORKLOAD_ROUTE_NAMES.utility
    ? "gpt-5.6-terra"
    : (routeName === COCOPI_WORKLOAD_ROUTE_NAMES.utilitySmall ? "gpt-5.6-luna" : undefined);
  const preferred = preferredId ? available.find((model) => model.id === preferredId) : undefined;
  const spark = routeName === COCOPI_WORKLOAD_ROUTE_NAMES.utility ? undefined : available.find((model) => /spark/iu.test(`${model.id}\n${model.displayName}`));
  const autocompleteFallback = routeName === COCOPI_WORKLOAD_ROUTE_NAMES.autocomplete
    ? available.find((model) => model.id === "gpt-5.6-luna")
    : undefined;
  const normalizedFallback = normalizeWorkloadTarget(fallbackModel);
  const fallback = normalizedFallback ? available.find((model) => model.id === normalizedFallback) : undefined;
  return preferred?.id
    ?? spark?.id
    ?? autocompleteFallback?.id
    ?? fallback?.id
    ?? available[0]?.id
    ?? (catalogAvailable ? undefined : (routeName === COCOPI_WORKLOAD_ROUTE_NAMES.autocomplete ? "gpt-5.6-luna" : normalizedFallback))
    ?? "gpt-5.5";
}

/**
 * @param {string} configuredEffort
 * @param {import("../../data/Codex.js").CodexModelSummary | undefined} model
 * @returns {string | undefined}
 */
function resolveWorkloadReasoningEffort(configuredEffort, model) {
  const supported = model?.supportedReasoningLevels?.map((level) => level.effort).filter(Boolean);
  if (supported?.length === 0) {
    return;
  }
  if (configuredEffort === "lowest") {
    return supported ? nearestReasoningEffort("none", supported) : undefined;
  }
  if (configuredEffort === "default") {
    if (model?.defaultReasoningLevel && (!supported || supported.includes(model.defaultReasoningLevel))) {
      return model.defaultReasoningLevel;
    }
    return supported ? nearestReasoningEffort("max", supported) : undefined;
  }

  if (!supported || supported.includes(configuredEffort)) {
    return configuredEffort;
  }

  return nearestReasoningEffort(configuredEffort, supported)
    ?? (model?.defaultReasoningLevel && supported.includes(model.defaultReasoningLevel) ? model.defaultReasoningLevel : supported[0]);
}

/**
 * @param {string} effort
 * @param {readonly string[]} supported
 */
function nearestReasoningEffort(effort, supported) {
  const targetRank = KNOWN_REASONING_EFFORTS.indexOf(effort);
  const ranked = supported.filter((candidate) => KNOWN_REASONING_EFFORTS.includes(candidate));
  if (targetRank === -1 || ranked.length === 0) {
    return;
  }
  let nearest = ranked[0];
  for (const candidate of ranked.slice(1)) {
    const nearestDistance = Math.abs(KNOWN_REASONING_EFFORTS.indexOf(nearest) - targetRank);
    const candidateDistance = Math.abs(KNOWN_REASONING_EFFORTS.indexOf(candidate) - targetRank);
    if (candidateDistance < nearestDistance) {
      nearest = candidate;
    }
  }
  return nearest;
}

/** @param {string} value */
function normalizeWorkloadServiceTier(value) {
  return value === "flex" || value === "priority" ? value : "auto";
}