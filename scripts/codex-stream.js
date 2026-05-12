import { readFile } from "node:fs/promises";

import { codexConfigFromEnv } from "../lib/codex-api/config.js";
import { chooseCodexModel, listCodexModels } from "../lib/codex-api/models.js";
import { buildTextResponseBody } from "../lib/codex-api/response-body.js";
import { fetchCodexResponseStream, readCodexTextDelta } from "../lib/codex-api/responses.js";
import { codexTokenMetadata } from "../lib/auth/token.js";
import { parseEnvFile } from "../lib/utils/env-file.js";

const DEFAULT_PROMPT = [
  "Generate 80 numbered lines of concise plain text about how a VS Code extension should stream model output.",
  "Each line should be unique, practical, and no more than 14 words.",
  "Do not use Markdown tables."
].join(" ");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

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
  const prompt = options.prompt || DEFAULT_PROMPT;
  const models = await listCodexModels({
    apiBaseUrl: config.apiBaseUrl,
    accessToken,
    chatgptAccountId: metadata.chatgptAccountId,
    clientVersion: config.clientVersion
  });
  const model = chooseCodexModel(models, config.model);
  const startedAt = performance.now();
  let eventCount = 0;
  let deltaCount = 0;
  let outputLength = 0;

  process.stderr.write(`Streaming ${model} from ${config.apiBaseUrl}\n`);
  process.stderr.write(`Prompt: ${prompt}\n\n`);

  const events = await fetchCodexResponseStream({
    apiBaseUrl: config.apiBaseUrl,
    accessToken,
    chatgptAccountId: metadata.chatgptAccountId,
    body: buildTextResponseBody({
      model,
      input: prompt,
      promptCacheKey: "cocopi-live-smoke",
      clientMetadata: { "x-codex-installation-id": "cocopi-live-smoke" }
    })
  });

  for await (const event of events) {
    eventCount += 1;
    if (options.raw) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    }

    const delta = readCodexTextDelta(event);
    if (delta) {
      deltaCount += 1;
      outputLength += delta.length;
      if (!options.raw) {
        process.stdout.write(delta);
      }
    }

    if (event.type === "response.failed" || event.type === "response.incomplete") {
      process.stderr.write(`\n${JSON.stringify(event)}\n`);
    }
  }

  if (!options.raw) {
    process.stdout.write("\n");
  }

  const elapsedMs = Math.round(performance.now() - startedAt);
  process.stderr.write(`\nStream complete: ${eventCount} events, ${deltaCount} text deltas, ${outputLength} chars, ${elapsedMs}ms.\n`);
}

/**
 * @param {string[]} args
 */
function parseArgs(args) {
  /** @type {{ help: boolean, raw: boolean, prompt: string }} */
  const options = { help: false, raw: false, prompt: "" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--help":
      case "-h": {
        options.help = true;
        break;
      }

      case "--raw": {
        options.raw = true;
        break;
      }

      case "--prompt": {
        options.prompt = args[index + 1] ?? "";
        index += 1;
        break;
      }

      default: {
        options.prompt = [options.prompt, arg].filter(Boolean).join(" ");
      }
    }
  }

  return options;
}

async function readLocalEnv() {
  try {
    return parseEnvFile(await readFile(".env", "utf8"));
  } catch {
    return {};
  }
}

function printUsage() {
  process.stdout.write(`Usage: npm run codex:stream -- [--raw] [--prompt "prompt text"]\n\n`);
  process.stdout.write("Reads ChatGPT/Codex tokens from .env, streams response events, and prints text deltas as they arrive.\n");
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}