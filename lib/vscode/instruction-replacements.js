const MAX_REPLACEMENT_PREVIEW_CHARACTERS = 256_000;

/**
 * @typedef {object} CocopiInstructionReplacementSnapshot
 * @property {string} original
 * @property {string} rewritten
 * @property {string} capturedAt
 * @property {boolean} truncated
 * @property {{ label: string, original: string, rewritten: string }[]} [entries]
 */

/** @type {{ instructions?: CocopiInstructionReplacementSnapshot, toolDescriptions?: CocopiInstructionReplacementSnapshot }} */
const latestSnapshots = {};
/** @type {Set<(scope: "instructions" | "toolDescriptions", snapshot: CocopiInstructionReplacementSnapshot) => void>} */
const snapshotListeners = new Set();

/**
 * Keep only the latest host text in extension-host memory. This intentionally
 * does not persist prompts or tool descriptions to workspace or secret storage.
 *
 * @param {"instructions" | "toolDescriptions"} scope
 * @param {string} original
 * @param {string} rewritten
 * @param {{ entries?: { label: string, original: string, rewritten: string }[] }} [options]
 */
export function recordCocopiInstructionReplacementSnapshot(scope, original, rewritten, options = {}) {
  if (!original) {
    return;
  }

  const truncated = original.length > MAX_REPLACEMENT_PREVIEW_CHARACTERS
    || rewritten.length > MAX_REPLACEMENT_PREVIEW_CHARACTERS;
  const snapshot = {
    original: original.slice(0, MAX_REPLACEMENT_PREVIEW_CHARACTERS),
    rewritten: rewritten.slice(0, MAX_REPLACEMENT_PREVIEW_CHARACTERS),
    capturedAt: new Date().toISOString(),
    truncated,
    ...(options.entries?.length ? { entries: instructionReplacementSnapshotEntries(options.entries) } : {})
  };
  latestSnapshots[scope] = snapshot;
  for (const listener of snapshotListeners) {
    try {
      listener(scope, copyInstructionReplacementSnapshot(snapshot));
    } catch {
      // Dashboard notifications must not affect request construction.
    }
  }
}

/**
 * @param {(scope: "instructions" | "toolDescriptions", snapshot: CocopiInstructionReplacementSnapshot) => void} listener
 */
export function onCocopiInstructionReplacementSnapshot(listener) {
  snapshotListeners.add(listener);
  return () => snapshotListeners.delete(listener);
}

/**
 * @returns {{ instructions?: CocopiInstructionReplacementSnapshot, toolDescriptions?: CocopiInstructionReplacementSnapshot }}
 */
export function readCocopiInstructionReplacementSnapshots() {
  return {
    ...(latestSnapshots.instructions ? { instructions: copyInstructionReplacementSnapshot(latestSnapshots.instructions) } : {}),
    ...(latestSnapshots.toolDescriptions ? { toolDescriptions: copyInstructionReplacementSnapshot(latestSnapshots.toolDescriptions) } : {})
  };
}

/** @param {CocopiInstructionReplacementSnapshot} snapshot */
function copyInstructionReplacementSnapshot(snapshot) {
  return {
    ...snapshot,
    ...(snapshot.entries ? { entries: snapshot.entries.map((entry) => ({ ...entry })) } : {})
  };
}

export function clearCocopiInstructionReplacementSnapshots() {
  delete latestSnapshots.instructions;
  delete latestSnapshots.toolDescriptions;
}

/** @param {{ label: string, original: string, rewritten: string }[]} entries */
function instructionReplacementSnapshotEntries(entries) {
  let remainingOriginal = MAX_REPLACEMENT_PREVIEW_CHARACTERS;
  let remainingRewritten = MAX_REPLACEMENT_PREVIEW_CHARACTERS;
  return entries.map((entry) => {
    const original = entry.original.slice(0, remainingOriginal);
    const rewritten = entry.rewritten.slice(0, remainingRewritten);
    remainingOriginal -= original.length;
    remainingRewritten -= rewritten.length;
    return {
      label: entry.label.slice(0, 256),
      original,
      rewritten
    };
  });
}