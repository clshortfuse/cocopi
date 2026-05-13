import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

  if (options.replayEvents) {
    await runReplayMode(options);
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
      `compareJson: ${options.compareJson}`,
      `payloadBytes: ${client.payloadBytes}`,
      `promptBytes: ${client.promptBytes}`,
      `iterations: ${options.iterations}`,
      ""
    ].join("\n"));
  }

  /** @type {BenchmarkResult[]} */
  const results = [];
  /** @type {CapturedEventRecord[]} */
  const capturedEvents = [];
  for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
    const streamFirst = iteration % 2 === 1;
    const cases = options.compareJson ? (streamFirst ? [true, false] : [false, true]) : [true];
    for (const stream of cases) {
      const result = await runBenchmarkCase(client, {
        iteration,
        stream,
        rawEvents: options.rawEvents,
        onEvent: options.saveEvents ? (record) => capturedEvents.push(record) : undefined
      });
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

  if (options.saveEvents) {
    await saveCapturedEventRecords(options.saveEvents, capturedEvents);
    const message = `Saved ${capturedEvents.length} stream events to ${path.resolve(options.saveEvents)}\n`;
    if (options.json) {
      process.stderr.write(message);
    } else {
      process.stdout.write(`\n${message}`);
    }
  }
}

/**
 * @typedef {object} BenchmarkOptions
 * @property {boolean} help
 * @property {boolean} compareJson
 * @property {boolean} json
 * @property {string | undefined} model
 * @property {number} iterations
 * @property {number} payloadBytes
 * @property {boolean} rawEvents
 * @property {string | undefined} replayEvents
 * @property {number} replayRepeat
 * @property {string | undefined} saveEvents
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
    compareJson: false,
    json: false,
    model: undefined,
    iterations: DEFAULT_ITERATIONS,
    payloadBytes: DEFAULT_PAYLOAD_BYTES,
    rawEvents: false,
    replayEvents: undefined,
    replayRepeat: 1000,
    saveEvents: undefined,
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

      case "--compare-json": {
        options.compareJson = true;
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

      case "--replay-events": {
        options.replayEvents = args[index + 1] ?? "";
        index += 1;
        break;
      }

      case "--replay-repeat": {
        options.replayRepeat = positiveInteger(args[index + 1], "replay-repeat");
        index += 1;
        break;
      }

      case "--save-events": {
        options.saveEvents = args[index + 1] ?? "";
        index += 1;
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
 * @typedef {object} CapturedEventRecord
 * @property {"event"} kind
 * @property {1} version
 * @property {number} iteration
 * @property {string} mode
 * @property {string} transport
 * @property {number} receivedAtMs
 * @property {CodexResponseStreamEvent} event
 */

/**
 * @typedef {object} BenchmarkResult
 * @property {number} argumentDeltaChars
 * @property {number | undefined} argumentDeltaApproxTokensPerSecond
 * @property {number | undefined} argumentDeltaAverageChars
 * @property {number | undefined} argumentDeltaCharsPerSecond
 * @property {number | undefined} argumentDeltaDurationMs
 * @property {number} argumentDeltaEvents
 * @property {number | undefined} argumentDeltaMaxChars
 * @property {number | undefined} argumentDeltaMinChars
 * @property {"delta" | "done" | "none"} argumentDeliveryMode
 * @property {number | undefined} argumentsDoneMs
 * @property {number | undefined} completedMs
 * @property {number} eventCount
 * @property {string | undefined} error
 * @property {number | undefined} firstArgumentDeltaMs
 * @property {number | undefined} firstEventMs
 * @property {number | undefined} functionCallAddedMs
 * @property {number} functionCallItems
 * @property {number} iteration
 * @property {string} mode
 * @property {string} model
 * @property {number} payloadBytes
 * @property {number} promptBytes
 * @property {number | undefined} rawArgumentChars
 * @property {number | undefined} rawArgumentApproxTokensPerSecond
 * @property {number | undefined} rawArgumentCharsPerSecond
 * @property {number | undefined} rawArgumentDurationMs
 * @property {string | undefined} responseId
 * @property {boolean} sawCompleted
 * @property {boolean} stream
 * @property {number} streamReadyMs
 * @property {number | undefined} outputItemDoneMs
 * @property {number} totalMs
 * @property {string} transport
 */

/**
 * @typedef {object} ReplayBenchmarkResult
 * @property {"replay-json-parse" | "replay-parsed"} mode
 * @property {number} eventRecords
 * @property {number} repeatedEvents
 * @property {number} repeat
 * @property {number} totalMs
 * @property {number} eventsPerSecond
 * @property {number} argumentChars
 * @property {number} approximateArgumentTokens
 * @property {number} approximateArgumentTokensPerSecond
 * @property {BenchmarkResult} inspection
 */

/**
 * @param {BenchmarkClient} client
 * @param {{ iteration: number, stream: boolean, rawEvents: boolean, onEvent?: (record: CapturedEventRecord) => void }} options
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
    argumentDeltaApproxTokensPerSecond: undefined,
    argumentDeltaAverageChars: undefined,
    argumentDeltaCharsPerSecond: undefined,
    argumentDeltaDurationMs: undefined,
    argumentDeltaEvents: 0,
    argumentDeltaMaxChars: undefined,
    argumentDeltaMinChars: undefined,
    argumentDeliveryMode: "none",
    argumentsDoneMs: undefined,
    completedMs: undefined,
    error: undefined,
    eventCount: 0,
    firstArgumentDeltaMs: undefined,
    firstEventMs: undefined,
    functionCallAddedMs: undefined,
    functionCallItems: 0,
    iteration: options.iteration,
    mode,
    model: client.model,
    payloadBytes: client.payloadBytes,
    promptBytes: client.promptBytes,
    rawArgumentChars: undefined,
    rawArgumentApproxTokensPerSecond: undefined,
    rawArgumentCharsPerSecond: undefined,
    rawArgumentDurationMs: undefined,
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
      const eventMs = elapsedMs(startedAt);
      result.firstEventMs ??= eventMs;
      options.onEvent?.({
        kind: "event",
        version: 1,
        iteration: options.iteration,
        mode,
        transport,
        receivedAtMs: eventMs,
        event
      });
      if (options.rawEvents) {
        process.stderr.write(`${mode} event ${result.eventCount}: ${JSON.stringify(event)}\n`);
      }

      inspectEvent(event, result, startedAt);
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  result.totalMs = elapsedMs(startedAt);
  finalizeBenchmarkResult(result);
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
      "x-cocopi-benchmark-iteration": String(iteration)
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
export function inspectEvent(event, result, startedAt) {
  if (event.type === "response.function_call_arguments.delta") {
    const deltaChars = typeof event.delta === "string" ? event.delta.length : 0;
    result.argumentDeltaEvents += 1;
    result.argumentDeltaChars += deltaChars;
    result.argumentDeltaMinChars = Math.min(result.argumentDeltaMinChars ?? deltaChars, deltaChars);
    result.argumentDeltaMaxChars = Math.max(result.argumentDeltaMaxChars ?? deltaChars, deltaChars);
    result.firstArgumentDeltaMs ??= elapsedMs(startedAt);
    return;
  }

  if (event.type === "response.function_call_arguments.done") {
    result.argumentsDoneMs ??= elapsedMs(startedAt);
    result.rawArgumentChars = typeof event.arguments === "string" ? event.arguments.length : result.rawArgumentChars;
    return;
  }

  if (event.type === "response.output_item.added" && isRecord(event.item) && event.item.type === "function_call") {
    result.functionCallAddedMs ??= elapsedMs(startedAt);
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
 * @returns {BenchmarkResult}
 */
export function finalizeBenchmarkResult(result) {
  if (result.argumentDeltaEvents > 0) {
    result.argumentDeliveryMode = "delta";
  } else if (result.rawArgumentChars === undefined) {
    result.argumentDeliveryMode = "none";
  } else {
    result.argumentDeliveryMode = "done";
  }

  if (result.argumentDeltaEvents > 0) {
    result.argumentDeltaAverageChars = roundTenth(result.argumentDeltaChars / result.argumentDeltaEvents);
    const endMs = firstNumber(result.argumentsDoneMs, result.outputItemDoneMs, result.completedMs, result.totalMs);
    if (result.firstArgumentDeltaMs !== undefined && endMs !== undefined) {
      result.argumentDeltaDurationMs = positiveDurationMs(endMs - result.firstArgumentDeltaMs);
      result.argumentDeltaCharsPerSecond = charsPerSecond(result.argumentDeltaChars, result.argumentDeltaDurationMs);
      result.argumentDeltaApproxTokensPerSecond = approxTokensPerSecond(result.argumentDeltaCharsPerSecond);
    }
  }

  if (result.rawArgumentChars !== undefined) {
    const startMs = firstNumber(result.functionCallAddedMs, result.firstArgumentDeltaMs, result.firstEventMs, result.streamReadyMs);
    const endMs = firstNumber(result.argumentsDoneMs, result.outputItemDoneMs, result.completedMs, result.totalMs);
    if (startMs !== undefined && endMs !== undefined) {
      result.rawArgumentDurationMs = positiveDurationMs(endMs - startMs);
      result.rawArgumentCharsPerSecond = charsPerSecond(result.rawArgumentChars, result.rawArgumentDurationMs);
      result.rawArgumentApproxTokensPerSecond = approxTokensPerSecond(result.rawArgumentCharsPerSecond);
    }
  }

  return result;
}

/**
 * @param {BenchmarkResult} result
 * @returns {number | undefined}
 */
export function benchmarkArgumentDeliveryDurationMs(result) {
  return result.argumentDeliveryMode === "delta"
    ? result.argumentDeltaDurationMs
    : result.rawArgumentDurationMs;
}

/**
 * @param {BenchmarkResult} result
 * @returns {number | undefined}
 */
export function benchmarkArgumentDeliveryApproxTokensPerSecond(result) {
  return result.argumentDeliveryMode === "delta"
    ? result.argumentDeltaApproxTokensPerSecond
    : result.rawArgumentApproxTokensPerSecond;
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
    `toolStart=${formatOptionalMs(result.functionCallAddedMs)}`,
    `firstArg=${formatOptionalMs(result.firstArgumentDeltaMs)}`,
    `argsDone=${formatOptionalMs(result.argumentsDoneMs ?? result.outputItemDoneMs)}`,
    `argDuration=${formatOptionalMs(benchmarkArgumentDeliveryDurationMs(result))}`,
    `completed=${formatOptionalMs(result.completedMs)}`,
    `events=${result.eventCount}`,
    `delivery=${result.argumentDeliveryMode}`,
    `argRate=${formatOptionalRate(benchmarkArgumentDeliveryApproxTokensPerSecond(result))}`,
    `argDeltas=${result.argumentDeltaEvents}/${result.argumentDeltaChars}ch`,
    `deltaRate=${formatOptionalRate(result.argumentDeltaApproxTokensPerSecond)}`,
    `deltaAvg=${formatOptionalNumber(result.argumentDeltaAverageChars)}ch`,
    `rawArgs=${result.rawArgumentChars ?? "unknown"}ch`,
    `rawRate=${formatOptionalRate(result.rawArgumentApproxTokensPerSecond)}`
  ].join(" "));
  process.stdout.write("\n");
}

/** @param {BenchmarkResult[]} results */
function printSummary(results) {
  process.stdout.write("\nSummary averages:\n");
  for (const mode of ["stream", "json"]) {
    const group = results.filter((result) => result.mode === mode);
    if (group.length === 0) {
      continue;
    }
    const successes = group.filter((result) => !result.error);
    const errors = group.length - successes.length;
    process.stdout.write([
      `mode=${mode}`,
      `n=${group.length}`,
      `errors=${errors}`,
      `ready=${formatOptionalMs(average(successes.map((result) => result.streamReadyMs)))}`,
      `first=${formatOptionalMs(averageDefined(successes.map((result) => result.firstEventMs)))}`,
      `toolStart=${formatOptionalMs(averageDefined(successes.map((result) => result.functionCallAddedMs)))}`,
      `argsDone=${formatOptionalMs(averageDefined(successes.map((result) => result.argumentsDoneMs ?? result.outputItemDoneMs)))}`,
      `argDuration=${formatOptionalMs(averageDefined(successes.map((result) => benchmarkArgumentDeliveryDurationMs(result))))}`,
      `completed=${formatOptionalMs(averageDefined(successes.map((result) => result.completedMs)))}`,
      `total=${formatOptionalMs(average(successes.map((result) => result.totalMs)))}`,
      `events=${formatOptionalNumber(average(successes.map((result) => result.eventCount)))}`,
      `argDeltaEvents=${formatOptionalNumber(average(successes.map((result) => result.argumentDeltaEvents)))}`,
      `argTps=${formatOptionalRate(averageDefined(successes.map((result) => benchmarkArgumentDeliveryApproxTokensPerSecond(result))))}`,
      `deltaTps=${formatOptionalRate(averageDefined(successes.map((result) => result.argumentDeltaApproxTokensPerSecond)))}`,
      `rawTps=${formatOptionalRate(averageDefined(successes.map((result) => result.rawArgumentApproxTokensPerSecond)))}`
    ].join(" "));
    process.stdout.write("\n");
  }
}

/**
 * @param {BenchmarkOptions} options
 */
async function runReplayMode(options) {
  const eventLines = await readCapturedEventLines(options.replayEvents ?? "");
  const events = parseCapturedEventLines(eventLines);
  const parseResult = replayCapturedEventLinesForBenchmark(eventLines, { repeat: options.replayRepeat });
  const parsedResult = replayCapturedEventsForBenchmark(events, { repeat: options.replayRepeat });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(parseResult)}\n`);
    process.stdout.write(`${JSON.stringify(parsedResult)}\n`);
    return;
  }

  process.stdout.write([
    `Replay file: ${path.resolve(options.replayEvents ?? "")}`,
    `eventRecords: ${events.length}`,
    `repeat: ${options.replayRepeat}`,
    ""
  ].join("\n"));
  printReplayResult(parseResult);
  printReplayResult(parsedResult);
}

/**
 * Replays captured JSONL records and includes JSON.parse in the measured loop.
 *
 * @param {string[]} lines
 * @param {{ repeat?: number }} [options]
 * @returns {ReplayBenchmarkResult}
 */
export function replayCapturedEventLinesForBenchmark(lines, options = {}) {
  const repeat = options.repeat ?? 1;
  const events = parseCapturedEventLines(lines);
  const argumentCharsPerPass = argumentDeliveryCharsForEvents(events);
  const inspection = createReplayInspectionResult("replay-json-parse");
  const startedAt = performance.now();
  let repeatedEvents = 0;

  for (let iteration = 0; iteration < repeat; iteration += 1) {
    for (const line of lines) {
      const event = eventFromCapturedLine(line);
      if (!event) {
        continue;
      }

      repeatedEvents += 1;
      inspection.eventCount += 1;
      inspection.firstEventMs ??= elapsedMs(startedAt);
      inspectEvent(event, inspection, startedAt);
    }
  }

  inspection.totalMs = elapsedMs(startedAt);
  finalizeBenchmarkResult(inspection);
  return replayResultFromInspection({
    mode: "replay-json-parse",
    eventRecords: events.length,
    repeatedEvents,
    repeat,
    argumentChars: argumentCharsPerPass * repeat,
    inspection
  });
}

/**
 * Replays already-parsed event objects and measures JS event handling without
 * JSON.parse overhead.
 *
 * @param {CodexResponseStreamEvent[]} events
 * @param {{ repeat?: number }} [options]
 * @returns {ReplayBenchmarkResult}
 */
export function replayCapturedEventsForBenchmark(events, options = {}) {
  const repeat = options.repeat ?? 1;
  const argumentCharsPerPass = argumentDeliveryCharsForEvents(events);
  const inspection = createReplayInspectionResult("replay-parsed");
  const startedAt = performance.now();
  let repeatedEvents = 0;

  for (let iteration = 0; iteration < repeat; iteration += 1) {
    for (const event of events) {
      repeatedEvents += 1;
      inspection.eventCount += 1;
      inspection.firstEventMs ??= elapsedMs(startedAt);
      inspectEvent(event, inspection, startedAt);
    }
  }

  inspection.totalMs = elapsedMs(startedAt);
  finalizeBenchmarkResult(inspection);
  return replayResultFromInspection({
    mode: "replay-parsed",
    eventRecords: events.length,
    repeatedEvents,
    repeat,
    argumentChars: argumentCharsPerPass * repeat,
    inspection
  });
}

/**
 * @param {string} file
 * @returns {Promise<string[]>}
 */
async function readCapturedEventLines(file) {
  if (!file) {
    throw new Error("--replay-events requires a file path.");
  }

  const text = await readFile(file, "utf8");
  return text.split(/\r?\n/u).filter((line) => line.trim());
}

/**
 * @param {string} file
 * @param {CapturedEventRecord[]} records
 */
async function saveCapturedEventRecords(file, records) {
  if (!file) {
    throw new Error("--save-events requires a file path.");
  }

  const resolvedPath = path.resolve(file);
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

/**
 * @param {string[]} lines
 * @returns {CodexResponseStreamEvent[]}
 */
function parseCapturedEventLines(lines) {
  return lines.map((line) => eventFromCapturedLine(line)).filter((event) => event !== undefined);
}

/**
 * @param {string} line
 * @returns {CodexResponseStreamEvent | undefined}
 */
function eventFromCapturedLine(line) {
  const value = JSON.parse(line);
  if (!isRecord(value)) {
    return;
  }

  if (value.kind === "event" && isRecord(value.event)) {
    return /** @type {CodexResponseStreamEvent} */ (value.event);
  }

  if (typeof value.type === "string") {
    return /** @type {CodexResponseStreamEvent} */ (value);
  }
}

/**
 * @param {CodexResponseStreamEvent[]} events
 * @returns {number}
 */
function argumentDeliveryCharsForEvents(events) {
  /** @type {Map<string, { deltaChars: number, doneChars: number }>} */
  const toolArguments = new Map();
  for (const event of events) {
    if (event.type === "response.function_call_arguments.delta") {
      argumentStatsForEvent(toolArguments, event).deltaChars += typeof event.delta === "string" ? event.delta.length : 0;
      continue;
    }

    if (event.type === "response.function_call_arguments.done") {
      argumentStatsForEvent(toolArguments, event).doneChars = typeof event.arguments === "string" ? event.arguments.length : 0;
      continue;
    }

    if (event.type === "response.output_item.done" && isRecord(event.item) && event.item.type === "function_call") {
      argumentStatsForEvent(toolArguments, event).doneChars = typeof event.item.arguments === "string" ? event.item.arguments.length : 0;
    }
  }

  let chars = 0;
  for (const stats of toolArguments.values()) {
    chars += stats.deltaChars > 0 ? stats.deltaChars : stats.doneChars;
  }
  return chars;
}

/**
 * @param {Map<string, { deltaChars: number, doneChars: number }>} toolArguments
 * @param {CodexResponseStreamEvent} event
 */
function argumentStatsForEvent(toolArguments, event) {
  const record = /** @type {Record<string, CodexJsonValue>} */ (event);
  const item = isRecord(record.item);
  const outputIndex = typeof record.output_index === "number" ? record.output_index : "unknown";
  let itemId = "unknown";
  if (typeof record.item_id === "string") {
    itemId = record.item_id;
  } else if (item && typeof item.id === "string") {
    itemId = item.id;
  }
  const key = `${outputIndex}:${itemId}`;
  let stats = toolArguments.get(key);
  if (!stats) {
    stats = { deltaChars: 0, doneChars: 0 };
    toolArguments.set(key, stats);
  }
  return stats;
}

/**
 * @param {string} mode
 * @returns {BenchmarkResult}
 */
function createReplayInspectionResult(mode) {
  return {
    argumentDeltaChars: 0,
    argumentDeltaApproxTokensPerSecond: undefined,
    argumentDeltaAverageChars: undefined,
    argumentDeltaCharsPerSecond: undefined,
    argumentDeltaDurationMs: undefined,
    argumentDeltaEvents: 0,
    argumentDeltaMaxChars: undefined,
    argumentDeltaMinChars: undefined,
    argumentDeliveryMode: "none",
    argumentsDoneMs: undefined,
    completedMs: undefined,
    error: undefined,
    eventCount: 0,
    firstArgumentDeltaMs: undefined,
    firstEventMs: undefined,
    functionCallAddedMs: undefined,
    functionCallItems: 0,
    iteration: 1,
    mode,
    model: "replay",
    outputItemDoneMs: undefined,
    payloadBytes: 0,
    promptBytes: 0,
    rawArgumentChars: undefined,
    rawArgumentApproxTokensPerSecond: undefined,
    rawArgumentCharsPerSecond: undefined,
    rawArgumentDurationMs: undefined,
    responseId: undefined,
    sawCompleted: false,
    stream: true,
    streamReadyMs: 0,
    totalMs: 0,
    transport: "local"
  };
}

/**
 * @param {{ mode: "replay-json-parse" | "replay-parsed", eventRecords: number, repeatedEvents: number, repeat: number, argumentChars: number, inspection: BenchmarkResult }} options
 * @returns {ReplayBenchmarkResult}
 */
function replayResultFromInspection(options) {
  const totalMs = positiveDurationMs(options.inspection.totalMs);
  const eventsPerSecond = roundTenth(options.repeatedEvents / (totalMs / 1000));
  const approximateArgumentTokens = roundTenth(options.argumentChars / 4);
  const approximateArgumentTokensPerSecond = roundTenth(approximateArgumentTokens / (totalMs / 1000));
  return {
    mode: options.mode,
    eventRecords: options.eventRecords,
    repeatedEvents: options.repeatedEvents,
    repeat: options.repeat,
    totalMs,
    eventsPerSecond,
    argumentChars: options.argumentChars,
    approximateArgumentTokens,
    approximateArgumentTokensPerSecond,
    inspection: options.inspection
  };
}

/**
 * @param {ReplayBenchmarkResult} result
 */
function printReplayResult(result) {
  process.stdout.write([
    `mode=${result.mode}`,
    `repeat=${result.repeat}`,
    `events=${result.repeatedEvents}`,
    `total=${formatMs(result.totalMs)}`,
    `eventsRate=${formatOptionalNumber(result.eventsPerSecond)}/s`,
    `delivery=${result.inspection.argumentDeliveryMode}`,
    `argChars=${result.argumentChars}`,
    `jsRate=${formatOptionalRate(result.approximateArgumentTokensPerSecond)}`
  ].join(" "));
  process.stdout.write("\n");
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
function roundTenth(value) {
  return Math.round(value * 10) / 10;
}

/** @param {number} value */
function positiveDurationMs(value) {
  return Math.max(0.1, roundTenth(value));
}

/**
 * @param {number} chars
 * @param {number | undefined} durationMs
 */
function charsPerSecond(chars, durationMs) {
  return durationMs && durationMs > 0 ? roundTenth(chars / (durationMs / 1000)) : undefined;
}

/** @param {number | undefined} charsPerSecondValue */
function approxTokensPerSecond(charsPerSecondValue) {
  return charsPerSecondValue === undefined ? undefined : roundTenth(charsPerSecondValue / 4);
}

/** @param {Array<number | undefined>} values */
function firstNumber(...values) {
  return values.find((value) => typeof value === "number" && Number.isFinite(value));
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

/** @param {number | undefined} value */
function formatOptionalRate(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${formatOptionalNumber(value)}t/s` : "n/a";
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
  process.stdout.write("Benchmarks streamed tool-call argument delivery.\n\n");
  process.stdout.write("Options:\n");
  process.stdout.write("  --iterations <n>       Timed pairs to run. Default: 2.\n");
  process.stdout.write("  --compare-json         Also run a stream=false control request. Current Codex backends may reject it.\n");
  process.stdout.write("  --payload-bytes <n>    Deterministic tool argument payload size. Default: 4096.\n");
  process.stdout.write("  --transport <kind>     Stream transport for stream=true: websocket or sse. Default: websocket when available.\n");
  process.stdout.write("  --model <id>           Override CODEX_MODEL/.env model selection.\n");
  process.stdout.write("  --json                 Emit one JSON result per case.\n");
  process.stdout.write("  --raw-events           Write raw response events to stderr.\n");
  process.stdout.write("  --save-events <file>   Save streamed Responses events as JSONL for offline JS replay.\n");
  process.stdout.write("  --replay-events <file> Replay saved JSONL events locally instead of calling Codex.\n");
  process.stdout.write("  --replay-repeat <n>    Repeat saved events during replay. Default: 1000.\n");
}

if (isCurrentScript(import.meta.url, process.argv[1])) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

/**
 * @param {string} moduleUrl
 * @param {string | undefined} argvPath
 */
function isCurrentScript(moduleUrl, argvPath) {
  if (!argvPath) {
    return false;
  }

  return fileURLToPath(moduleUrl) === path.resolve(argvPath);
}
