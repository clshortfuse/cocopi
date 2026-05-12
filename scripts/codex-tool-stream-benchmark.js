import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { codexTokenMetadata } from "../lib/auth/token.js";
import { codexConfigFromEnv } from "../lib/codex-api/config.js";
import { chooseCodexModel, listCodexModels } from "../lib/codex-api/models.js";
import { buildTextResponseBody } from "../lib/codex-api/response-body.js";
import { fetchCodexResponseStream } from "../lib/codex-api/responses.js";
import { fetchCodexResponseWebSocketStream } from "../lib/codex-api/websocket.js";
import { parseEnvFile } from "../lib/utils/env-file.js";

/** @typedef {import("../data/Codex.js").CodexJsonValue} CodexJsonValue */
/** @typedef {import("../data/Codex.js").CodexResponseCreateRequest} CodexResponseCreateRequest */
/** @typedef {import("../data/Codex.js").CodexResponseStreamEvent} CodexResponseStreamEvent */
/** @typedef {import("../data/Codex.js").CodexTool} CodexTool */

const DEFAULT_PAYLOAD_BYTES = 4096;
const DEFAULT_ITERATIONS = 2;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const BENCHMARK_INSTALLATION_ID = "cocopi-tool-stream-benchmark";

/** @type {CodexTool} */
const BENCHMARK_TOOL = {
  type: "function",
  name: "benchmark_echo",
  description: "Benchmark-only tool. Echo the exact requested payload and checksum.",
  strict: true,
  parameters: {
    type: "object",
    properties: {
      checksum: {
        type: "string",
        description: "The SHA-256 checksum provided by the prompt."
      },
      payload: {
        type: "string",
        description: "The exact payload string provided by the prompt."
      }
    },
    required: ["checksum", "payload"],
    additionalProperties: false
  }
};

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
  const models = await listCodexModels({
    apiBaseUrl: config.apiBaseUrl,
    accessToken,
    chatgptAccountId: metadata.chatgptAccountId,
    clientVersion: config.clientVersion
  });
  const model = chooseCodexModel(models, options.model || config.model);
  const payload = deterministicPayload(options.payloadBytes);
  const checksum = sha256(payload);
  const prompt = benchmarkPrompt(payload, checksum);
  const promptCacheKey = `cocopi-tool-bench-${sha256(`${model}\n${prompt}`).slice(0, 24)}`;
  const client = {
    apiBaseUrl: config.apiBaseUrl,
    accessToken,
    chatgptAccountId: metadata.chatgptAccountId,
    model,
    prompt,
    promptCacheKey,
    payloadBytes: new TextEncoder().encode(payload).byteLength,
    promptBytes: new TextEncoder().encode(prompt).byteLength,
    transport: options.transport
  };

  if (!options.json) {
    process.stdout.write([
      `Model: ${model}`,
      `API: ${config.apiBaseUrl}`,
      `stream transport: ${options.transport}`,
      `payloadBytes: ${client.payloadBytes}`,
      `promptBytes: ${client.promptBytes}`,
      `iterations: ${options.iterations}`,
      ""
    ].join("\n"));
  }

  /** @type {BenchmarkResult[]} */
  const results = [];
  for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
    const streamFirst = iteration % 2 === 1;
    const cases = streamFirst ? [true, false] : [false, true];
    for (const stream of cases) {
      const result = await runBenchmarkCase(client, { iteration, stream, rawEvents: options.rawEvents });
      results.push(result);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else {
        printResult(result);
      }
    }
  }

  if (!options.json) {
    printSummary(results);
  }
}

/**
 * @typedef {object} BenchmarkOptions
 * @property {boolean} help
 * @property {boolean} json
 * @property {string | undefined} model
 * @property {number} iterations
 * @property {number} payloadBytes
 * @property {boolean} rawEvents
 * @property {"sse" | "websocket"} transport
 */

/**
 * @param {string[]} args
 * @returns {BenchmarkOptions}
 */
function parseArgs(args) {
  /** @type {BenchmarkOptions} */
  const options = {
    help: false,
    json: false,
    model: undefined,
    iterations: DEFAULT_ITERATIONS,
    payloadBytes: DEFAULT_PAYLOAD_BYTES,
    rawEvents: false,
    transport: defaultStreamTransport()
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--help":
      case "-h": {
        options.help = true;
        break;
      }

      case "--iterations": {
        options.iterations = positiveInteger(args[index + 1], "iterations");
        index += 1;
        break;
      }

      case "--json": {
        options.json = true;
        break;
      }

      case "--model": {
        options.model = args[index + 1] ?? "";
        index += 1;
        break;
      }

      case "--payload-bytes": {
        options.payloadBytes = positiveInteger(args[index + 1], "payload-bytes");
        index += 1;
        break;
      }

      case "--raw-events": {
        options.rawEvents = true;
        break;
      }

      case "--transport": {
        options.transport = parseTransport(args[index + 1]);
        index += 1;
        break;
      }

      default: {
        throw new Error(`Unknown argument: ${arg}`);
      }
    }
  }

  return options;
}

/**
 * @typedef {object} BenchmarkClient
 * @property {string} apiBaseUrl
 * @property {string} accessToken
 * @property {string | undefined} chatgptAccountId
 * @property {string} model
 * @property {string} prompt
 * @property {string} promptCacheKey
 * @property {number} payloadBytes
 * @property {number} promptBytes
 * @property {"sse" | "websocket"} transport
 */

/**
 * @typedef {object} BenchmarkResult
 * @property {number} argumentDeltaChars
 * @property {number} argumentDeltaEvents
 * @property {number | undefined} argumentsDoneMs
 * @property {number | undefined} completedMs
 * @property {number} eventCount
 * @property {string | undefined} error
 * @property {number | undefined} firstArgumentDeltaMs
 * @property {number | undefined} firstEventMs
 * @property {number} functionCallItems
 * @property {number} iteration
 * @property {string} mode
 * @property {string} model
 * @property {number} payloadBytes
 * @property {number} promptBytes
 * @property {number | undefined} rawArgumentChars
 * @property {string | undefined} responseId
 * @property {boolean} sawCompleted
 * @property {boolean} stream
 * @property {number} streamReadyMs
 * @property {number | undefined} outputItemDoneMs
 * @property {number} totalMs
 * @property {string} transport
 */

/**
 * @param {BenchmarkClient} client
 * @param {{ iteration: number, stream: boolean, rawEvents: boolean }} options
 * @returns {Promise<BenchmarkResult>}
 */
async function runBenchmarkCase(client, options) {
  const startedAt = performance.now();
  const mode = options.stream ? "stream" : "json";
  const transport = options.stream ? client.transport : "http-json";
  const body = benchmarkRequestBody(client, options.stream, options.iteration);
  /** @type {BenchmarkResult} */
  const result = {
    argumentDeltaChars: 0,
    argumentDeltaEvents: 0,
    argumentsDoneMs: undefined,
    completedMs: undefined,
    error: undefined,
    eventCount: 0,
    firstArgumentDeltaMs: undefined,
    firstEventMs: undefined,
    functionCallItems: 0,
    iteration: options.iteration,
    mode,
    model: client.model,
    payloadBytes: client.payloadBytes,
    promptBytes: client.promptBytes,
    rawArgumentChars: undefined,
    responseId: undefined,
    sawCompleted: false,
    stream: options.stream,
    streamReadyMs: 0,
    outputItemDoneMs: undefined,
    totalMs: 0,
    transport
  };

  try {
    const events = await fetchBenchmarkEvents(client, body, options.stream);
    result.streamReadyMs = elapsedMs(startedAt);

    for await (const event of events) {
      result.eventCount += 1;
      result.firstEventMs ??= elapsedMs(startedAt);
      if (options.rawEvents) {
        process.stderr.write(`${mode} event ${result.eventCount}: ${JSON.stringify(event)}\n`);
      }

      inspectEvent(event, result, startedAt);
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  result.totalMs = elapsedMs(startedAt);
  return result;
}

/**
 * @param {BenchmarkClient} client
 * @param {boolean} stream
 * @param {number} iteration
 * @returns {CodexResponseCreateRequest}
 */
function benchmarkRequestBody(client, stream, iteration) {
  return buildTextResponseBody({
    model: client.model,
    instructions: "Call the benchmark_echo tool exactly once. Do not produce assistant text.",
    input: client.prompt,
    tools: [BENCHMARK_TOOL],
    toolChoice: "required",
    stream,
    promptCacheKey: client.promptCacheKey,
    clientMetadata: {
      "x-codex-installation-id": BENCHMARK_INSTALLATION_ID,
      "x-cocopi-benchmark-mode": stream ? "stream" : "json",
      "x-cocopi-benchmark-iteration": iteration
    }
  });
}

/**
 * @param {BenchmarkClient} client
 * @param {CodexResponseCreateRequest} body
 * @param {boolean} stream
 * @returns {Promise<ReadableStream<CodexResponseStreamEvent>>}
 */
function fetchBenchmarkEvents(client, body, stream) {
  const common = {
    apiBaseUrl: client.apiBaseUrl,
    accessToken: client.accessToken,
    chatgptAccountId: client.chatgptAccountId,
    body,
    idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS
  };

  if (stream && client.transport === "websocket") {
    return fetchCodexResponseWebSocketStream(common);
  }

  return fetchCodexResponseStream(common);
}

/**
 * @param {CodexResponseStreamEvent} event
 * @param {BenchmarkResult} result
 * @param {number} startedAt
 */
function inspectEvent(event, result, startedAt) {
  if (event.type === "response.function_call_arguments.delta") {
    result.argumentDeltaEvents += 1;
    result.argumentDeltaChars += typeof event.delta === "string" ? event.delta.length : 0;
    result.firstArgumentDeltaMs ??= elapsedMs(startedAt);
    return;
  }

  if (event.type === "response.function_call_arguments.done") {
    result.argumentsDoneMs ??= elapsedMs(startedAt);
    result.rawArgumentChars = typeof event.arguments === "string" ? event.arguments.length : result.rawArgumentChars;
    return;
  }

  if (event.type === "response.output_item.done" && isRecord(event.item) && event.item.type === "function_call") {
    result.functionCallItems += 1;
    result.outputItemDoneMs ??= elapsedMs(startedAt);
    result.rawArgumentChars = typeof event.item.arguments === "string" ? event.item.arguments.length : result.rawArgumentChars;
    return;
  }

  if (event.type === "response.completed") {
    result.sawCompleted = true;
    result.completedMs = elapsedMs(startedAt);
    result.responseId = isRecord(event.response) && typeof event.response.id === "string" ? event.response.id : result.responseId;
  }
}

/**
 * @param {BenchmarkResult} result
 */
function printResult(result) {
  if (result.error) {
    process.stdout.write([
      `iter=${result.iteration}`,
      `mode=${result.mode}`,
      `transport=${result.transport}`,
      `errorAfter=${formatMs(result.totalMs)}`,
      `error=${JSON.stringify(result.error)}`
    ].join(" "));
    process.stdout.write("\n");
    return;
  }

  process.stdout.write([
    `iter=${result.iteration}`,
    `mode=${result.mode}`,
    `transport=${result.transport}`,
    `ready=${formatMs(result.streamReadyMs)}`,
    `first=${formatOptionalMs(result.firstEventMs)}`,
    `firstArg=${formatOptionalMs(result.firstArgumentDeltaMs)}`,
    `argsDone=${formatOptionalMs(result.argumentsDoneMs ?? result.outputItemDoneMs)}`,
    `completed=${formatOptionalMs(result.completedMs)}`,
    `events=${result.eventCount}`,
    `argDeltas=${result.argumentDeltaEvents}/${result.argumentDeltaChars}ch`,
    `rawArgs=${result.rawArgumentChars ?? "unknown"}ch`
  ].join(" "));
  process.stdout.write("\n");
}

/** @param {BenchmarkResult[]} results */
function printSummary(results) {
  process.stdout.write("\nSummary averages:\n");
  for (const mode of ["stream", "json"]) {
    const group = results.filter((result) => result.mode === mode);
    const successes = group.filter((result) => !result.error);
    const errors = group.length - successes.length;
    process.stdout.write([
      `mode=${mode}`,
      `n=${group.length}`,
      `errors=${errors}`,
      `ready=${formatOptionalMs(average(successes.map((result) => result.streamReadyMs)))}`,
      `first=${formatOptionalMs(averageDefined(successes.map((result) => result.firstEventMs)))}`,
      `argsDone=${formatOptionalMs(averageDefined(successes.map((result) => result.argumentsDoneMs ?? result.outputItemDoneMs)))}`,
      `completed=${formatOptionalMs(averageDefined(successes.map((result) => result.completedMs)))}`,
      `total=${formatOptionalMs(average(successes.map((result) => result.totalMs)))}`,
      `events=${formatOptionalNumber(average(successes.map((result) => result.eventCount)))}`,
      `argDeltaEvents=${formatOptionalNumber(average(successes.map((result) => result.argumentDeltaEvents)))}`
    ].join(" "));
    process.stdout.write("\n");
  }
}

/**
 * @param {number} bytes
 */
function deterministicPayload(bytes) {
  const lines = [];
  let index = 0;
  while (new TextEncoder().encode(lines.join("\n")).byteLength < bytes) {
    const id = String(index).padStart(4, "0");
    lines.push(`payload-line-${id}: deterministic benchmark content for tool argument transport.`);
    index += 1;
  }

  const text = lines.join("\n");
  return new TextDecoder().decode(new TextEncoder().encode(text).slice(0, bytes));
}

/**
 * @param {string} payload
 * @param {string} checksum
 */
function benchmarkPrompt(payload, checksum) {
  return [
    "Call benchmark_echo exactly once.",
    `Set checksum to: ${checksum}`,
    "Set payload to the exact text between <payload> and </payload>.",
    "Do not summarize, compress, transform, escape extra characters, or answer in natural language.",
    "<payload>",
    payload,
    "</payload>"
  ].join("\n");
}

/** @param {string} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readLocalEnv() {
  try {
    return parseEnvFile(await readFile(".env", "utf8"));
  } catch {
    return {};
  }
}

function defaultStreamTransport() {
  return typeof WebSocket === "function" ? "websocket" : "sse";
}

/** @param {string | undefined} value */
function parseTransport(value) {
  if (value === "sse" || value === "websocket") {
    return value;
  }

  throw new Error("--transport must be 'sse' or 'websocket'.");
}

/**
 * @param {string | undefined} value
 * @param {string} name
 */
function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`--${name} must be a positive integer.`);
  }

  return number;
}

/** @param {number} startedAt */
function elapsedMs(startedAt) {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

/** @param {number} value */
function formatMs(value) {
  return `${Math.round(value)}ms`;
}

/** @param {number | undefined} value */
function formatOptionalMs(value) {
  return typeof value === "number" && Number.isFinite(value) ? formatMs(value) : "n/a";
}

/** @param {number | undefined} value */
function formatOptionalNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(1).replace(/\.0$/u, "") : "n/a";
}

/** @param {number[]} values */
function average(values) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

/** @param {Array<number | undefined>} values */
function averageDefined(values) {
  return average(values.filter((value) => typeof value === "number"));
}

/* eslint-disable jsdoc/check-types -- Response stream event fields are untyped external JSON data. */
/** @param {unknown} value */
function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, CodexJsonValue>} */ (value) : undefined;
}
/* eslint-enable jsdoc/check-types */

function printUsage() {
  process.stdout.write(`Usage: npm run codex:bench:tools -- [options]\n\n`);
  process.stdout.write("Benchmarks streamed tool-call argument delivery against non-stream completed JSON.\n\n");
  process.stdout.write("Options:\n");
  process.stdout.write("  --iterations <n>       Timed pairs to run. Default: 2.\n");
  process.stdout.write("  --payload-bytes <n>    Deterministic tool argument payload size. Default: 4096.\n");
  process.stdout.write("  --transport <kind>     Stream transport for stream=true: websocket or sse. Default: websocket when available.\n");
  process.stdout.write("  --model <id>           Override CODEX_MODEL/.env model selection.\n");
  process.stdout.write("  --json                 Emit one JSON result per case.\n");
  process.stdout.write("  --raw-events           Write raw response events to stderr.\n");
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
