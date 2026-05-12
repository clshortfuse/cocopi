/** @typedef {import("../auth/oauth.js").CodexTokenSet} CodexTokenSet */
/** @typedef {import("../auth/token.js").CodexTokenMetadata} CodexTokenMetadata */

export const CODEX_SECRET_KEYS = Object.freeze({
  accessToken: "cocopi.auth.accessToken",
  refreshToken: "cocopi.auth.refreshToken",
  idToken: "cocopi.auth.idToken",
  chatgptAccountId: "cocopi.auth.chatgptAccountId",
  chatgptPlanType: "cocopi.auth.chatgptPlanType"
});

/**
 * @typedef {object} SecretStorageLike
 * @property {(key: string) => Thenable<string | undefined>} get
 * @property {(key: string, value: string) => Thenable<void>} store
 * @property {(key: string) => Thenable<void>} delete
 */

/**
 * @typedef {CodexTokenSet & CodexTokenMetadata} StoredCodexAuth
 */

/**
 * @param {SecretStorageLike} secrets
 * @param {StoredCodexAuth} auth
 */
export async function storeCodexAuth(secrets, auth) {
  await Promise.all([
    secrets.store(CODEX_SECRET_KEYS.accessToken, auth.accessToken),
    secrets.store(CODEX_SECRET_KEYS.refreshToken, auth.refreshToken),
    secrets.store(CODEX_SECRET_KEYS.idToken, auth.idToken),
    storeOptionalSecret(secrets, CODEX_SECRET_KEYS.chatgptAccountId, auth.chatgptAccountId),
    storeOptionalSecret(secrets, CODEX_SECRET_KEYS.chatgptPlanType, auth.chatgptPlanType)
  ]);
}

/**
 * @param {SecretStorageLike} secrets
 * @returns {Promise<StoredCodexAuth | undefined>}
 */
export async function readCodexAuth(secrets) {
  const [accessToken, refreshToken, idToken, chatgptAccountId, chatgptPlanType] = await Promise.all([
    secrets.get(CODEX_SECRET_KEYS.accessToken),
    secrets.get(CODEX_SECRET_KEYS.refreshToken),
    secrets.get(CODEX_SECRET_KEYS.idToken),
    secrets.get(CODEX_SECRET_KEYS.chatgptAccountId),
    secrets.get(CODEX_SECRET_KEYS.chatgptPlanType)
  ]);

  if (!accessToken || !refreshToken || !idToken) {
    return;
  }

  return {
    accessToken,
    refreshToken,
    idToken,
    chatgptAccountId,
    chatgptPlanType
  };
}

/**
 * @param {SecretStorageLike} secrets
 */
export async function deleteCodexAuth(secrets) {
  await Promise.all(Object.values(CODEX_SECRET_KEYS).map((key) => secrets.delete(key)));
}

/**
 * @param {SecretStorageLike} secrets
 * @param {string} key
 * @param {string | undefined} value
 */
async function storeOptionalSecret(secrets, key, value) {
  if (value) {
    await secrets.store(key, value);
    return;
  }

  await secrets.delete(key);
}
