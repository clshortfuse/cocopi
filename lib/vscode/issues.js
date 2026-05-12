const MAX_COCOPI_ISSUES = 200;
const COCOPI_ISSUES_STORAGE_KEY = "cocopi.diagnostics.issues.v1";
const MAX_ISSUE_TITLE_LENGTH = 160;
const MAX_ISSUE_DETAILS_LENGTH = 500;
const MAX_ISSUE_METADATA_KEY_LENGTH = 80;
const MAX_ISSUE_METADATA_VALUE_LENGTH = 160;

/** @typedef {'info' | 'warning' | 'error'} CocopiIssueSeverity */
/** @typedef {'token-cache' | 'tool-replay' | 'response-stream' | 'websocket-continuation' | 'auth' | 'runtime'} CocopiIssueCategory */

/**
 * @typedef {object} CocopiIssue
 * @property {number} id
 * @property {string} recordedAt
 * @property {CocopiIssueSeverity} severity
 * @property {CocopiIssueCategory} category
 * @property {string} title
 * @property {string} details
 * @property {Record<string, string | number | boolean | undefined>} metadata
 */

/** @type {CocopiIssue[]} */
const cocopiIssues = [];

/** @type {number} */
let nextCocopiIssueId = 1;

/** @type {import("./secret-storage.js").SecretStorageLike | undefined} */
let cocopiIssueStorage;

/** @type {Promise<void>} */
let cocopiIssueStorageLoad = Promise.resolve();

/** @type {EventTarget} */
const cocopiIssueTarget = new EventTarget();

/**
 * @typedef {object} CocopiIssueChangeEvent
 * @property {'record' | 'update' | 'delete' | 'clear'} type
 * @property {CocopiIssue} [issue]
 * @property {number} [id]
 */

/**
 * @param {import("./secret-storage.js").SecretStorageLike} secrets
 * @returns {Promise<void>}
 */
export function initializeCocopiIssueStorage(secrets) {
  cocopiIssueStorage = secrets;
  cocopiIssueStorageLoad = loadCocopiIssuesFromStorage(secrets);
  return cocopiIssueStorageLoad;
}

/** @returns {Promise<void>} */
export function waitForCocopiIssueStorage() {
  return cocopiIssueStorageLoad;
}

/** @param {(event: CocopiIssueChangeEvent) => void} listener */
export function onCocopiIssueChange(listener) {
  /** @type {(event: Event) => void} */
  const handler = (event) => {
    if (event instanceof CustomEvent) {
      listener(/** @type {CocopiIssueChangeEvent} */ (event.detail));
    }
  };

  cocopiIssueTarget.addEventListener("change", handler);
  return () => {
    cocopiIssueTarget.removeEventListener("change", handler);
  };
}

/**
 * @param {Omit<CocopiIssue, "id" | "recordedAt">} issue
 */
export function recordCocopiIssue(issue) {
  const entry = {
    id: nextCocopiIssueId++,
    recordedAt: new Date().toISOString(),
    severity: issue.severity,
    category: issue.category,
    title: sanitizeIssueText(issue.title, MAX_ISSUE_TITLE_LENGTH),
    details: sanitizeIssueText(issue.details, MAX_ISSUE_DETAILS_LENGTH),
    metadata: sanitizeIssueMetadata(issue.metadata)
  };

  cocopiIssues.unshift(entry);

  if (cocopiIssues.length > MAX_COCOPI_ISSUES) {
    cocopiIssues.length = MAX_COCOPI_ISSUES;
  }

  persistCocopiIssues();
  dispatchCocopiIssueChange({ type: "record", issue: cloneCocopiIssue(entry) });
}

/** @returns {CocopiIssue[]} */
export function readCocopiIssues() {
  return cocopiIssues.map((issue) => cloneCocopiIssue(issue));
}

/**
 * @param {number} id
 * @param {Partial<Omit<CocopiIssue, "id" | "recordedAt">>} update
 */
export function updateCocopiIssue(id, update) {
  const index = cocopiIssues.findIndex((issue) => issue.id === id);
  if (index === -1) {
    return false;
  }

  const current = cocopiIssues[index];
  const next = {
    ...current,
    severity: update.severity ?? current.severity,
    category: update.category ?? current.category,
    title: update.title === undefined ? current.title : sanitizeIssueText(update.title, MAX_ISSUE_TITLE_LENGTH),
    details: update.details === undefined ? current.details : sanitizeIssueText(update.details, MAX_ISSUE_DETAILS_LENGTH),
    metadata: update.metadata === undefined ? current.metadata : sanitizeIssueMetadata(update.metadata)
  };
  cocopiIssues.splice(index, 1, next);
  persistCocopiIssues();
  dispatchCocopiIssueChange({ type: "update", issue: cloneCocopiIssue(next) });
  return true;
}

/** @param {number} id */
export function deleteCocopiIssue(id) {
  const index = cocopiIssues.findIndex((issue) => issue.id === id);
  if (index === -1) {
    return false;
  }

  cocopiIssues.splice(index, 1);
  persistCocopiIssues();
  dispatchCocopiIssueChange({ type: "delete", id });
  return true;
}

export function clearCocopiIssues() {
  cocopiIssues.length = 0;
  nextCocopiIssueId = 1;
  persistCocopiIssues();
  dispatchCocopiIssueChange({ type: "clear" });
}

/** @param {import("./secret-storage.js").SecretStorageLike} secrets */
async function loadCocopiIssuesFromStorage(secrets) {
  const stored = await secrets.get(COCOPI_ISSUES_STORAGE_KEY);
  if (!stored) {
    return;
  }

  const current = [...cocopiIssues];
  const parsed = parseStoredIssues(stored);
  const merged = mergeStoredCocopiIssues(current, parsed);
  const filtered = merged.filter((issue) => !isRetiredStoredIssue(issue));
  cocopiIssues.length = 0;
  cocopiIssues.push(...filtered.slice(0, MAX_COCOPI_ISSUES));
  nextCocopiIssueId = Math.max(0, ...cocopiIssues.map((issue) => issue.id)) + 1;
  if (filtered.length !== merged.length) {
    persistCocopiIssues();
  }
}

/** @param {CocopiIssue} issue */
function isRetiredStoredIssue(issue) {
  return issue.category === "websocket-continuation" && issue.metadata.reason === "request-state-changed";
}

/**
 * @param {CocopiIssue[]} current
 * @param {CocopiIssue[]} stored
 * @returns {CocopiIssue[]}
 */
function mergeStoredCocopiIssues(current, stored) {
  /** @type {Set<string>} */
  const exactKeys = new Set();
  /** @type {Set<number>} */
  const usedIds = new Set();
  let nextId = Math.max(0, ...current.map((issue) => issue.id), ...stored.map((issue) => issue.id)) + 1;
  /** @type {CocopiIssue[]} */
  const merged = [];

  for (const issue of [...current, ...stored]) {
    const exactKey = `${issue.id}\0${issue.recordedAt}\0${issue.title}`;
    if (exactKeys.has(exactKey)) {
      continue;
    }

    exactKeys.add(exactKey);
    const entry = usedIds.has(issue.id) ? { ...issue, id: nextId++ } : issue;
    usedIds.add(entry.id);
    merged.push(entry);
  }

  return merged.toSorted((left, right) => right.recordedAt.localeCompare(left.recordedAt));
}

/**
 * @param {string} stored
 * @returns {CocopiIssue[]}
 */
function parseStoredIssues(stored) {
  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.map((issue) => sanitizeStoredIssue(issue)).filter((issue) => issue !== undefined);
  } catch {
    return [];
  }
}

/* eslint-disable jsdoc/check-types -- Stored JSON is untyped external data. */
/**
 * @param {unknown} value
 * @returns {CocopiIssue | undefined}
 */
function sanitizeStoredIssue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  const issue = /** @type {Record<string, unknown>} */ (value);
  const id = typeof issue.id === "number" && Number.isInteger(issue.id) && issue.id > 0 ? issue.id : undefined;
  const recordedAt = typeof issue.recordedAt === "string" ? issue.recordedAt : undefined;
  const severity = isIssueSeverity(issue.severity) ? issue.severity : undefined;
  const category = isIssueCategory(issue.category) ? issue.category : undefined;
  const title = typeof issue.title === "string" ? issue.title : undefined;
  const details = typeof issue.details === "string" ? issue.details : undefined;
  if (!id || !recordedAt || !severity || !category || title === undefined || details === undefined) {
    return;
  }

  return {
    id,
    recordedAt,
    severity,
    category,
    title: sanitizeIssueText(title, MAX_ISSUE_TITLE_LENGTH),
    details: sanitizeIssueText(details, MAX_ISSUE_DETAILS_LENGTH),
    metadata: sanitizeIssueMetadata(issue.metadata)
  };
}

/** @param {unknown} value */
function isIssueSeverity(value) {
  return value === "info" || value === "warning" || value === "error";
}

/** @param {unknown} value */
function isIssueCategory(value) {
  return value === "token-cache" || value === "tool-replay" || value === "response-stream" || value === "websocket-continuation" || value === "auth" || value === "runtime";
}

/** @param {unknown} value */
function sanitizeIssueMetadata(value) {
  /** @type {Record<string, string | number | boolean | undefined>} */
  const metadata = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return metadata;
  }

  for (const [key, field] of Object.entries(value)) {
    const sanitizedKey = sanitizeIssueText(key, MAX_ISSUE_METADATA_KEY_LENGTH);
    if (typeof field === "string") {
      metadata[sanitizedKey] = sanitizeIssueText(field, MAX_ISSUE_METADATA_VALUE_LENGTH);
    } else if (typeof field === "number" || typeof field === "boolean" || field === undefined) {
      metadata[sanitizedKey] = field;
    }
  }

  return metadata;
}
/* eslint-enable jsdoc/check-types */

/**
 * @param {string} value
 * @param {number} maxLength
 */
function sanitizeIssueText(value, maxLength) {
  const redacted = replaceControlCharacters(redactIssueText(value));
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted;
}

/** @param {string} value */
function replaceControlCharacters(value) {
  return [...value].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1F || (codePoint >= 0x7F && codePoint <= 0x9F) ? "�" : character;
  }).join("");
}

/** @param {string} value */
function redactIssueText(value) {
  return value
    .replaceAll(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]")
    .replaceAll(/\b((?:access|refresh|id)_token)=([^\s&]+)/giu, "$1=[redacted]")
    .replaceAll(/"(?:access|refresh|id)_token"\s*:\s*"[^"]*"/giu, (match) => match.replaceAll(/:\s*"[^"]*"/gu, ':"[redacted]"'))
    .replaceAll(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/gu, "[redacted-jwt]")
    .replaceAll(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, "sk-[redacted]");
}

function persistCocopiIssues() {
  if (!cocopiIssueStorage) {
    return;
  }

  void cocopiIssueStorage.store(COCOPI_ISSUES_STORAGE_KEY, JSON.stringify(cocopiIssues));
}

/** @param {CocopiIssueChangeEvent} event */
function dispatchCocopiIssueChange(event) {
  cocopiIssueTarget.dispatchEvent(new CustomEvent("change", { detail: event }));
}

/** @param {CocopiIssue} issue */
function cloneCocopiIssue(issue) {
  return {
    ...issue,
    metadata: { ...issue.metadata }
  };
}
