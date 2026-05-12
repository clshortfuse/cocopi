import test from "node:test";
import assert from "node:assert/strict";

import { parseEnvFile, upsertEnvValues } from "../lib/utils/env-file.js";

test("parseEnvFile reads simple dotenv values", () => {
  assert.deepEqual(
    parseEnvFile(`
      # local settings
      COCOPI_AUTH_MODE=chatgpt_browser
      CODEX_CHATGPT_ACCESS_TOKEN=access-token
    `),
    {
      COCOPI_AUTH_MODE: "chatgpt_browser",
      CODEX_CHATGPT_ACCESS_TOKEN: "access-token"
    }
  );
});

test("parseEnvFile handles quoted values and ignores invalid lines", () => {
  assert.deepEqual(
    parseEnvFile(`
      MESSAGE="hello${String.raw`\n`}world"
      NAME='Cocopi'
      not valid
      1_BAD=value
    `),
    {
      MESSAGE: "hello\nworld",
      NAME: "Cocopi"
    }
  );
});

test("upsertEnvValues updates existing keys and preserves comments", () => {
  assert.equal(
    upsertEnvValues(
      `# local settings
COCOPI_AUTH_MODE=chatgpt_browser
CODEX_CHATGPT_ACCESS_TOKEN=
`,
      {
        COCOPI_AUTH_MODE: "chatgpt_device_code",
        CODEX_CHATGPT_ACCESS_TOKEN: "access-token"
      }
    ),
    `# local settings
COCOPI_AUTH_MODE=chatgpt_device_code
CODEX_CHATGPT_ACCESS_TOKEN=access-token
`
  );
});

test("upsertEnvValues appends missing keys and quotes complex values", () => {
  assert.equal(
    upsertEnvValues("CODEX_CHATGPT_ACCESS_TOKEN=access-token\n", {
      CODEX_AUTH_ISSUER: "https://auth.openai.com",
      MESSAGE: "hello world"
    }),
    `CODEX_CHATGPT_ACCESS_TOKEN=access-token
CODEX_AUTH_ISSUER=https://auth.openai.com
MESSAGE="hello world"
`
  );
});