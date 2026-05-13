import assert from "node:assert/strict";
import test from "node:test";

import { benchmarkArgumentDeliveryApproxTokensPerSecond, benchmarkArgumentDeliveryDurationMs, finalizeBenchmarkResult, replayCapturedEventLinesForBenchmark, replayCapturedEventsForBenchmark } from "../scripts/codex-tool-stream-benchmark.js";

test("finalizeBenchmarkResult reports delta argument throughput", () => {
  const result = benchmarkResult({
    argumentDeltaChars: 8,
    argumentDeltaEvents: 2,
    firstArgumentDeltaMs: 100,
    functionCallAddedMs: 50,
    argumentsDoneMs: 300,
    rawArgumentChars: 8,
    totalMs: 350
  });

  finalizeBenchmarkResult(result);

  assert.equal(result.argumentDeliveryMode, "delta");
  assert.equal(result.argumentDeltaAverageChars, 4);
  assert.equal(result.argumentDeltaDurationMs, 200);
  assert.equal(result.argumentDeltaCharsPerSecond, 40);
  assert.equal(result.argumentDeltaApproxTokensPerSecond, 10);
  assert.equal(result.rawArgumentDurationMs, 250);
  assert.equal(result.rawArgumentCharsPerSecond, 32);
  assert.equal(result.rawArgumentApproxTokensPerSecond, 8);
  assert.equal(benchmarkArgumentDeliveryDurationMs(result), 200);
  assert.equal(benchmarkArgumentDeliveryApproxTokensPerSecond(result), 10);
});

test("finalizeBenchmarkResult reports done-only argument throughput", () => {
  const result = benchmarkResult({
    functionCallAddedMs: 500,
    argumentsDoneMs: 1900,
    rawArgumentChars: 1128,
    totalMs: 1905
  });

  finalizeBenchmarkResult(result);

  assert.equal(result.argumentDeliveryMode, "done");
  assert.equal(result.argumentDeltaCharsPerSecond, undefined);
  assert.equal(result.argumentDeltaApproxTokensPerSecond, undefined);
  assert.equal(result.rawArgumentDurationMs, 1400);
  assert.equal(result.rawArgumentCharsPerSecond, 805.7);
  assert.equal(result.rawArgumentApproxTokensPerSecond, 201.4);
  assert.equal(benchmarkArgumentDeliveryDurationMs(result), 1400);
  assert.equal(benchmarkArgumentDeliveryApproxTokensPerSecond(result), 201.4);
});

test("replayCapturedEventsForBenchmark reports JS handling throughput for delta events", () => {
  /** @type {import("../data/Codex.js").CodexResponseStreamEvent[]} */
  const events = [
    { type: "response.output_item.added", item: { id: "fc-1", type: "function_call", name: "tool", call_id: "call-1", arguments: "" }, output_index: 0, sequence_number: 1 },
    { type: "response.function_call_arguments.delta", item_id: "fc-1", output_index: 0, sequence_number: 2, delta: "{\"" },
    { type: "response.function_call_arguments.delta", item_id: "fc-1", output_index: 0, sequence_number: 3, delta: "x" },
    { type: "response.function_call_arguments.done", item_id: "fc-1", output_index: 0, call_id: "call-1", name: "tool", arguments: "{\"x\":1}" },
    { type: "response.output_item.done", item_id: "fc-1", item: { id: "fc-1", type: "function_call", name: "tool", call_id: "call-1", arguments: "{\"x\":1}" }, output_index: 0 }
  ];

  const result = replayCapturedEventsForBenchmark(events, { repeat: 3 });

  assert.equal(result.mode, "replay-parsed");
  assert.equal(result.eventRecords, 5);
  assert.equal(result.repeatedEvents, 15);
  assert.equal(result.argumentChars, 9);
  assert.equal(result.inspection.argumentDeliveryMode, "delta");
  assert.ok(result.approximateArgumentTokensPerSecond > 0);
});

test("replayCapturedEventLinesForBenchmark includes JSON parse throughput for saved records", () => {
  const lines = [
    { type: "response.output_item.added", item: { id: "fc-1", type: "function_call", name: "tool", call_id: "call-1", arguments: "" }, output_index: 0, sequence_number: 1 },
    { type: "response.function_call_arguments.done", item_id: "fc-1", output_index: 0, sequence_number: 2, arguments: "{\"x\":1}" },
    { type: "response.output_item.done", item: { id: "fc-1", type: "function_call", name: "tool", call_id: "call-1", arguments: "{\"x\":1}" }, output_index: 0, sequence_number: 3 }
  ].map((event, index) => JSON.stringify({
    kind: "event",
    version: 1,
    iteration: 1,
    mode: "stream",
    transport: "websocket",
    receivedAtMs: index,
    event
  }));

  const result = replayCapturedEventLinesForBenchmark(lines, { repeat: 2 });

  assert.equal(result.mode, "replay-json-parse");
  assert.equal(result.eventRecords, 3);
  assert.equal(result.repeatedEvents, 6);
  assert.equal(result.argumentChars, 14);
  assert.equal(result.inspection.argumentDeliveryMode, "done");
  assert.ok(result.approximateArgumentTokensPerSecond > 0);
});

/**
 * @param {Partial<import("../scripts/codex-tool-stream-benchmark.js").BenchmarkResult>} overrides
 * @returns {import("../scripts/codex-tool-stream-benchmark.js").BenchmarkResult}
 */
function benchmarkResult(overrides = {}) {
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
    mode: "stream",
    model: "gpt-test",
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
    transport: "websocket",
    ...overrides
  };
}
