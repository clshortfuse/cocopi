/**
 * @param {string} text
 * @returns {import('node:inspector').Profiler.Profile}
 */
export function parseWorkerCpuProfile(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Node 24.11.1's native worker profiler emits raw Windows paths in url
    // metadata. Do not apply this workaround to transport events or payloads.
    return JSON.parse(text.replaceAll(/"url":"([A-Za-z]:\\[^"]*)"/gu,
      (_match, path) => `"url":${JSON.stringify(path)}`));
  }
}

/**
 * @param {import('node:inspector').Profiler.Profile} profile
 */
export function summarizeCpuProfile(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  /** @type {Map<string, number>} */
  const counts = new Map();
  let idleSamples = 0;
  for (const id of profile.samples ?? []) {
    const frame = nodes.get(id)?.callFrame;
    if (frame?.functionName === "(idle)") {
      idleSamples += 1;
      continue;
    }
    const file = frame?.url.split(/[\\/]/u).at(-1) ?? "";
    const key = `${frame?.functionName || "(anonymous)"}${file ? ` @ ${file}` : ""}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const samples = profile.samples?.length ?? 0;
  const activeSamples = samples - idleSamples;
  return {
    samples, idleSamples, activeSamples,
    topSelfSamples: [...counts].toSorted((left, right) => right[1] - left[1]).slice(0, 15)
      .map(([frame, count]) => ({ frame, samples: count, activePercent: activeSamples > 0 ? count * 100 / activeSamples : 0 })),
    note: "Sample counts, not exact CPU duration; idle excluded from percentages. Anonymous/native work and benchmark accounting can dominate. No inclusive-stack attribution."
  };
}