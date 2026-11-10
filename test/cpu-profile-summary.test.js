import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkerCpuProfile, summarizeCpuProfile } from "../scripts/cpu-profile-summary.js";

test("worker CPU profile decoding handles Node's unescaped Windows metadata paths", () => {
  const raw = String.raw`{"nodes":[{"id":1,"callFrame":{"functionName":"WebSocket","scriptId":"1","url":"C:\Users\fixture\lib.js","lineNumber":0,"columnNumber":0}}],"startTime":0,"endTime":1,"samples":[1]}`;
  assert.equal(summarizeCpuProfile(parseWorkerCpuProfile(raw)).topSelfSamples[0].frame, "WebSocket @ lib.js");
  assert.deepEqual(parseWorkerCpuProfile('{"nodes":[],"startTime":0,"endTime":0}').nodes, []);
  assert.throws(() => parseWorkerCpuProfile('{"nodes":broken}'), SyntaxError);
  const valid = { nodes: [], startTime: 0, endTime: 0, url: String.raw`C:\fixture\lib.js` };
  assert.deepEqual(parseWorkerCpuProfile(JSON.stringify(valid)), valid);
});

test("CPU profile summaries count self samples without exposing source directories", () => {
  const frame = { functionName: "encode", scriptId: "1", url: "file:///private/source/encoder.js", lineNumber: 0, columnNumber: 0 };
  const result = summarizeCpuProfile({
    nodes: [{ id: 1, callFrame: frame }, { id: 2, callFrame: { ...frame, functionName: "(idle)" } }],
    samples: [1, 2, 1, 1], startTime: 0, endTime: 10
  });
  assert.equal(result.samples, 4);
  assert.equal(result.idleSamples, 1);
  assert.equal(result.activeSamples, 3);
  assert.deepEqual(result.topSelfSamples, [{ frame: "encode @ encoder.js", samples: 3, activePercent: 100 }]);
  assert.doesNotMatch(JSON.stringify(result), /private|source\//u);
  assert.equal(summarizeCpuProfile({ nodes: [], startTime: 0, endTime: 0 }).activeSamples, 0);
});