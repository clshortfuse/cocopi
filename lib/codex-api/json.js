/** @typedef {import("../../data/Codex.js").CodexJsonValue} CodexJsonValue */

/* eslint-disable jsdoc/check-types -- Request bodies may contain optional undefined fields before wire serialization. */
/**
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalCodexJsonString(value) {
  return JSON.stringify(canonicalCodexJsonValue(value)) ?? "undefined";
}

/**
 * @param {unknown} value
 * @returns {CodexJsonValue | undefined}
 */
export function canonicalCodexJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalCodexJsonValue(item));
  }

  if (!value || typeof value !== "object") {
    return /** @type {CodexJsonValue | undefined} */ (value);
  }

  /** @type {Record<string, CodexJsonValue | undefined>} */
  const output = {};
  for (const key of Object.keys(value).toSorted()) {
    const field = Reflect.get(value, key);
    if (field !== undefined) {
      output[key] = canonicalCodexJsonValue(field);
    }
  }

  return output;
}
/* eslint-enable jsdoc/check-types */
