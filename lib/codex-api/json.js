import { createHash } from "node:crypto";

const UTF8_ENCODER = new TextEncoder();

/** @typedef {import("../../data/Codex.js").CodexJsonValue} CodexJsonValue */

/* eslint-disable jsdoc/check-types -- Canonicalization accepts optional undefined request fields and JSON test edge cases. */
/**
 * Hash JSON-domain request data without allocating a canonical object tree or
 * full container string. Optional undefined object fields are omitted.
 * @param {unknown} value
 * @param {Map<string, string>} [fields] Requested root fields; values receive canonical digests when present.
 * @returns {string}
 */
export function canonicalCodexJsonDigest(value, fields) {
  const hash = createHash("sha256");
  /** @type {import('node:crypto').Hash | undefined} */
  let fieldHash;
  /** @type {Uint8Array | undefined} */
  let scratch;
  /** @param {string} text */
  const update = (text) => {
    if (fieldHash) {
      scratch ??= new Uint8Array(65_536);
      let offset = 0;
      while (offset < text.length) {
        const { read, written } = UTF8_ENCODER.encodeInto(text.slice(offset), scratch);
        const bytes = scratch.subarray(0, written);
        hash.update(bytes);
        fieldHash.update(bytes);
        offset += read;
      }
    } else {
      hash.update(text);
    }
  };
  let buffer = "";
  const flush = () => {
    if (buffer.length > 0) {
      update(buffer);
      buffer = "";
    }
  };
  /** @param {string} text */
  const write = (text) => {
    if (buffer.length + text.length > 16_384) {
      flush();
    }
    if (text.length >= 16_384) {
      update(text);
    } else {
      buffer += text;
    }
  };
  /**
   * @param {unknown} item
   * @param {number} depth
   */
  const visit = (item, depth) => {
    if (Array.isArray(item)) {
      write("[");
      let index = 0;
      for (const field of item) {
        if (index > 0) write(",");
        visit(field === undefined ? null : field, depth + 1);
        index += 1;
      }
      write("]");
    } else if (item && typeof item === "object") {
      // JSON.stringify enumerates array-index keys numerically even after the
      // canonical object's keys were inserted in lexical order.
      const keys = Object.keys(item).toSorted((left, right) => {
        const leftIndex = String(Number(left)) === left && Number.isInteger(Number(left)) && Number(left) >= 0 && Number(left) < 4_294_967_295;
        const rightIndex = String(Number(right)) === right && Number.isInteger(Number(right)) && Number(right) >= 0 && Number(right) < 4_294_967_295;
        if (leftIndex && rightIndex) return Number(left) - Number(right);
        if (leftIndex !== rightIndex) return leftIndex ? -1 : 1;
        return left < right ? -1 : (left > right ? 1 : 0);
      });
      write("{");
      let first = true;
      for (const key of keys) {
        const field = Reflect.get(item, key);
        // The legacy canonical object's __proto__ setter does not create an
        // enumerable field; preserve its digest behavior without that setter.
        if (field !== undefined && key !== "__proto__") {
          if (!first) write(",");
          first = false;
          write(JSON.stringify(key));
          write(":");
          const collect = depth === 0 && fields?.has(key);
          if (collect) {
            flush();
            fieldHash = createHash("sha256");
          }
          visit(field, depth + 1);
          if (collect) {
            flush();
            fields?.set(key, /** @type {import('node:crypto').Hash} */ (fieldHash).digest("hex"));
            fieldHash = undefined;
          }
        }
      }
      write("}");
    } else {
      write(JSON.stringify(item) ?? "undefined");
    }
  };
  visit(value, 0);
  flush();
  return hash.digest("hex");
}
/* eslint-enable jsdoc/check-types */

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
