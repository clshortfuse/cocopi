import test from "node:test";
import assert from "node:assert/strict";

import { CODEX_SECRET_KEYS, deleteCodexAuth, readCodexAuth, storeCodexAuth } from "../lib/vscode/secret-storage.js";

test("storeCodexAuth writes token set and metadata", async () => {
  const secrets = fakeSecretStorage();

  await storeCodexAuth(secrets, {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    idToken: "id-token",
    chatgptAccountId: "account-id",
    chatgptPlanType: "plus"
  });

  assert.deepEqual([...secrets.values.entries()], [
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"],
    [CODEX_SECRET_KEYS.chatgptAccountId, "account-id"],
    [CODEX_SECRET_KEYS.chatgptPlanType, "plus"]
  ]);
});

test("storeCodexAuth removes optional metadata when missing", async () => {
  const secrets = fakeSecretStorage(new Map([
    [CODEX_SECRET_KEYS.chatgptAccountId, "old-account"],
    [CODEX_SECRET_KEYS.chatgptPlanType, "old-plan"]
  ]));

  await storeCodexAuth(secrets, {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    idToken: "id-token",
    chatgptAccountId: undefined,
    chatgptPlanType: undefined
  });

  assert.equal(secrets.values.get(CODEX_SECRET_KEYS.chatgptAccountId), undefined);
  assert.equal(secrets.values.get(CODEX_SECRET_KEYS.chatgptPlanType), undefined);
});

test("readCodexAuth returns stored token state", async () => {
  const secrets = fakeSecretStorage(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"],
    [CODEX_SECRET_KEYS.chatgptAccountId, "account-id"],
    [CODEX_SECRET_KEYS.chatgptPlanType, "team"]
  ]));

  assert.deepEqual(await readCodexAuth(secrets), {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    idToken: "id-token",
    chatgptAccountId: "account-id",
    chatgptPlanType: "team"
  });
});

test("readCodexAuth returns undefined without a complete token set", async () => {
  const secrets = fakeSecretStorage(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ]));

  assert.equal(await readCodexAuth(secrets), undefined);
});

test("deleteCodexAuth removes every Codex auth secret", async () => {
  const secrets = fakeSecretStorage(new Map(Object.values(CODEX_SECRET_KEYS).map((key) => [key, "secret"])));

  await deleteCodexAuth(secrets);

  assert.deepEqual([...secrets.values.entries()], []);
});

/**
 * @param {Map<string, string>} [values]
 */
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
