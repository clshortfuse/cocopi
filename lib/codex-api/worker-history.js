import { createHash } from "node:crypto";

/** @typedef {{ base: number, revision: number, keep: number, suffix: readonly string[] }} HistoryPatch */

// Serialized snapshots never alias mutable host input. Revision mismatch is a
// local pre-execution failure; automatic cache-miss recovery is separate.
export class WorkerHistory {
  /**
   * @param {number} maxBytes
   * @param {boolean} [fingerprintsOnly]
   */
  constructor(maxBytes, fingerprintsOnly = false) {
    this.maxBytes = maxBytes;
    this.revision = 0;
    /** @type {readonly string[]} */
    this.items = Object.freeze([]);
    this.bytes = 0;
    this.fingerprintsOnly = fingerprintsOnly;
    /** @type {readonly number[]} */
    this.sizes = Object.freeze([]);
  }

  /**
   * Preparation is read-only; a failed send must not advance the base.
   * @param {readonly import('../../data/Codex.js').CodexJsonValue[]} input
   * @returns {HistoryPatch}
   */
  prepare(input) {
    const items = input.map((item) => JSON.stringify(item));
    if (items.reduce((total, item) => total + Buffer.byteLength(item), 0) > this.maxBytes) {
      throw new Error("Worker retained history budget exceeded.");
    }
    let keep = 0;
    while (keep < items.length && keep < this.items.length
      && (this.fingerprintsOnly ? createHash("sha256").update(items[keep]).digest("hex") : items[keep]) === this.items[keep]) keep += 1;
    return Object.freeze({ base: this.revision, revision: this.revision + 1, keep, suffix: Object.freeze(items.slice(keep)) });
  }

  /**
   * Atomically apply a known base; reject stale work before changing state.
   * The returned snapshot remains valid after later rewrites.
   * @param {HistoryPatch} patch
   * @returns {readonly string[]}
   */
  apply(patch) {
    if (patch.base !== this.revision || patch.revision !== this.revision + 1
      || !Number.isSafeInteger(patch.keep) || patch.keep < 0 || patch.keep > this.items.length) {
      throw new Error("Worker history base mismatch; full replacement required before execution.");
    }
    const sizes = Object.freeze([...this.sizes.slice(0, patch.keep), ...patch.suffix.map((item) => Buffer.byteLength(item))]);
    const bytes = sizes.reduce((total, size) => total + size, 0);
    if (bytes > this.maxBytes) throw new Error("Worker retained history budget exceeded.");
    const items = Object.freeze([...this.items.slice(0, patch.keep), ...patch.suffix.map((item) =>
      this.fingerprintsOnly ? createHash("sha256").update(item).digest("hex") : item)]);
    this.items = items;
    this.sizes = sizes;
    this.bytes = bytes;
    this.revision = patch.revision;
    return items;
  }
}