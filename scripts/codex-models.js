import { readFile } from "node:fs/promises";

import { codexConfigFromEnv } from "../lib/codex-api/config.js";
import { fetchCodexModelsResponse } from "../lib/codex-api/models.js";
import { codexTokenMetadata } from "../lib/auth/token.js";
import { parseEnvFile } from "../lib/utils/env-file.js";

async function main() {
  const env = { ...(await readLocalEnv()), ...process.env };
  const config = codexConfigFromEnv(env);
  const accessToken = env.CODEX_CHATGPT_ACCESS_TOKEN ?? "";
  if (!accessToken) {
    throw new Error("Missing CODEX_CHATGPT_ACCESS_TOKEN. Run `npm run setup:codex-login` first.");
  }

  const metadata = codexTokenMetadata({
    idToken: env.CODEX_CHATGPT_ID_TOKEN,
    accessToken,
    explicitAccountId: config.chatgptAccountId
  });
  const result = await fetchCodexModelsResponse({
    apiBaseUrl: config.apiBaseUrl,
    accessToken,
    chatgptAccountId: metadata.chatgptAccountId,
    clientVersion: config.clientVersion
  });

  process.stdout.write(`${JSON.stringify({
    ...result.debug,
    count: result.models.length,
    accountHeaderAttached: Boolean(metadata.chatgptAccountId)
  }, null, 2)}\n`);
}

async function readLocalEnv() {
  try {
    return parseEnvFile(await readFile(".env", "utf8"));
  } catch {
    return {};
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}