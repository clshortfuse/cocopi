/** @typedef {import('../../data/Codex.js').CodexResponseStreamEvent} ResponseEvent */

// Cocopi-local safety bound, not an upstream protocol limit or response timeout.
const MAX_OUTSIDE_STRING_WHITESPACE = 16_384;

/**
 * Reject runaway argument formatting without retaining or rewriting arguments.
 * @param {ReadableStream<ResponseEvent>} source
 * @returns {ReadableStream<ResponseEvent>}
 */
export function guardCodexToolArguments(source) {
  const reader = source.getReader();
  /** @type {Map<string, { inString: boolean, escaped: boolean, whitespace: number }>} */
  const items = new Map();
  return new ReadableStream({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          items.clear();
          reader.releaseLock();
          controller.close();
          return;
        }
        const event = result.value;
        /** @type {string | undefined} */
        let itemId;
        /** @type {string | undefined} */
        let delta;
        if (event.type === "response.function_call_arguments.delta") {
          itemId = event.item_id;
          delta = event.delta;
        } else if (event.type === "response.output_item.added" && event.item.type === "function_call" && typeof event.item.id === "string" && typeof event.item.arguments === "string") {
          itemId = event.item.id;
          delta = event.item.arguments;
        }
        if (itemId !== undefined && delta !== undefined) {
          let state = items.get(itemId);
          if (!state) {
            state = { inString: false, escaped: false, whitespace: 0 };
            items.set(itemId, state);
          }
          for (const character of delta) {
            if (state.inString) {
              if (state.escaped) state.escaped = false;
              else if (character === "\\") state.escaped = true;
              else if (character === '"') state.inString = false;
            } else if (character === " " || character === "\n" || character === "\r" || character === "\t") {
              state.whitespace += 1;
              if (state.whitespace > MAX_OUTSIDE_STRING_WHITESPACE) {
                throw new Error(`Codex tool arguments stalled: exceeded ${MAX_OUTSIDE_STRING_WHITESPACE} consecutive JSON whitespace characters outside a string; the unfinished generation was stopped without automatic replay.`);
              }
            } else {
              state.whitespace = 0;
              if (character === '"') state.inString = true;
            }
          }
        } else if (event.type === "response.function_call_arguments.done") {
          items.delete(event.item_id);
        } else if (event.type === "response.output_item.done") {
          if (typeof event.item.id === "string") items.delete(event.item.id);
        } else if (["response.completed", "response.failed", "response.incomplete"].includes(event.type)) {
          items.clear();
        }
        controller.enqueue(event);
      } catch (error) {
        items.clear();
        // Preserve the primary failure even if transport cleanup also fails.
        await reader.cancel(error).catch(() => {});
        reader.releaseLock();
        throw error;
      }
    },
    async cancel(reason) {
      items.clear();
      try { await reader.cancel(reason); }
      finally { reader.releaseLock(); }
    }
  }, { highWaterMark: 0 });
}