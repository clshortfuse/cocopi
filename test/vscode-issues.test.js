import test from "node:test";
import assert from "node:assert/strict";

import {
  clearCocopiIssues,
  deleteCocopiIssue,
  initializeCocopiIssueStorage,
  readCocopiIssues,
  recordCocopiIssue,
  updateCocopiIssue
} from "../lib/vscode/issues.js";

const COCOPI_ISSUES_STORAGE_KEY = "cocopi.diagnostics.issues.v1";

test("issue tracker persists records and deletion in private storage", async () => {
  const secrets = fakeSecretStorage();
  await initializeCocopiIssueStorage(secrets);
  clearCocopiIssues();

  recordCocopiIssue(issue({ title: "First issue" }));
  await Promise.resolve();
  const persisted = JSON.parse(secrets.values.get(COCOPI_ISSUES_STORAGE_KEY) ?? "[]");
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].title, "First issue");

  assert.equal(deleteCocopiIssue(persisted[0].id), true);
  await Promise.resolve();
  assert.deepEqual(JSON.parse(secrets.values.get(COCOPI_ISSUES_STORAGE_KEY) ?? "[]"), []);
});

test("issue tracker loads stored records and continues ids", async () => {
  const secrets = fakeSecretStorage(new Map([[COCOPI_ISSUES_STORAGE_KEY, JSON.stringify([{
    id: 7,
    recordedAt: "2026-04-29T00:00:00.000Z",
    severity: "warning",
    category: "token-cache",
    title: "Stored issue",
    details: "Stored details",
    metadata: { model: "gpt-test" }
  }])]]));

  await initializeCocopiIssueStorage(secrets);
  assert.equal(readCocopiIssues()[0]?.title, "Stored issue");

  recordCocopiIssue(issue({ title: "Next issue" }));
  assert.equal(readCocopiIssues()[0]?.id, 8);

  clearCocopiIssues();
});

test("issue tracker updates records without deleting diagnostic history", async () => {
  const secrets = fakeSecretStorage();
  await initializeCocopiIssueStorage(secrets);
  clearCocopiIssues();

  recordCocopiIssue(issue({ title: "Cache miss" }));
  const [recorded] = readCocopiIssues();

  assert.equal(updateCocopiIssue(recorded.id, {
    details: "Cache miss, later hit observed.",
    metadata: { ...recorded.metadata, recovered: true, recoveredCachedTokens: 90 }
  }), true);
  assert.equal(updateCocopiIssue(9999, { title: "Missing" }), false);

  const [updated] = readCocopiIssues();
  assert.equal(updated.id, recorded.id);
  assert.equal(updated.title, "Cache miss");
  assert.equal(updated.details, "Cache miss, later hit observed.");
  assert.equal(updated.metadata.recovered, true);
  assert.equal(updated.metadata.recoveredCachedTokens, 90);
  assert.match(secrets.values.get(COCOPI_ISSUES_STORAGE_KEY) ?? "", /later hit observed/u);

  clearCocopiIssues();
});

test("issue tracker redacts and truncates sensitive metadata", async () => {
  const secrets = fakeSecretStorage();
  await initializeCocopiIssueStorage(secrets);
  clearCocopiIssues();

  recordCocopiIssue({
    severity: "error",
    category: "runtime",
    title: `Failed with Bearer ${fakeJwt()}`,
    details: `access_token=${fakeJwt()} ${"x".repeat(600)}`,
    metadata: {
      token: fakeJwt(),
      refresh_token: fakeJwt(),
      payload: "plain-value"
    }
  });

  const [issue] = readCocopiIssues();
  const serialized = JSON.stringify(issue);
  assert.match(serialized, /\[redacted-jwt\]/u);
  assert.match(serialized, /access_token=\[redacted\]/u);
  assert.doesNotMatch(serialized, /eyJhbGci/u);
  assert.ok(issue.details.length <= 501);
  assert.ok(String(issue.metadata.token).length <= 160);
});

test("issue tracker drops retired websocket continuation state-change records", async () => {
  clearCocopiIssues();
  const secrets = fakeSecretStorage(new Map([[COCOPI_ISSUES_STORAGE_KEY, JSON.stringify([{
    id: 9,
    recordedAt: "2026-04-29T00:00:00.000Z",
    severity: "info",
    category: "websocket-continuation",
    title: "Stored continuation issue",
    details: "Stored details",
    metadata: { reason: "request-state-changed" }
  }, {
    id: 10,
    recordedAt: "2026-04-29T00:01:00.000Z",
    severity: "info",
    category: "websocket-continuation",
    title: "Stored continuation mismatch",
    details: "Stored details",
    metadata: { reason: "input-prefix-mismatch" }
  }])]]));

  await initializeCocopiIssueStorage(secrets);
  await Promise.resolve();

  assert.equal(readCocopiIssues()[0]?.category, "websocket-continuation");
  assert.equal(readCocopiIssues()[0]?.metadata.reason, "input-prefix-mismatch");
  const stored = /** @type {{ metadata: { reason: string } }[]} */ (JSON.parse(secrets.values.get(COCOPI_ISSUES_STORAGE_KEY) ?? "[]"));
  assert.deepEqual(stored.map((issue) => issue.metadata.reason), ["input-prefix-mismatch"]);
  clearCocopiIssues();
});

/** @param {{ title: string }} options */
function issue(options) {
  return {
    severity: /** @type {"warning"} */ ("warning"),
    category: /** @type {"token-cache"} */ ("token-cache"),
    title: options.title,
    details: "Issue details",
    metadata: { model: "gpt-test" }
  };
}

function fakeJwt() {
  return "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyIiwidG9rZW4iOiJzZWNyZXQifQ.signature123";
}

/** @param {Map<string, string>} [values] */
function fakeSecretStorage(values = new Map()) {
  return {
    values,
    /** @param {string} key */
    async get(key) {
      return values.get(key);
    },
    /**
     * @param {string} key
     * @param {string} value
     */
    async store(key, value) {
      values.set(key, value);
    },
    /** @param {string} key */
    async delete(key) {
      values.delete(key);
    }
  };
}
