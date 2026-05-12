import SseParseError from "./SseParseError.js";

export { default as SseParseError } from "./SseParseError.js";

/** @typedef {import("../../data/Codex.js").CodexJsonValue} CodexJsonValue */

/**
 * @template {Record<string, CodexJsonValue>} T
 * @returns {TransformStream<string | Uint8Array, T>}
 */
export function sseEventStream() {
  /** @type {InstanceType<typeof TextDecoder> | undefined} */
  let decoder;
  let lineBuffer = "";
  let dataBuffer = "";
  let hasData = false;

  return new TransformStream({
    /**
     * @param {string | Uint8Array} chunk
     * @param {TransformStreamDefaultController<T>} controller
     */
    transform(chunk, controller) {
      const text = typeof chunk === "string"
        ? chunk
        : (decoder ??= new TextDecoder()).decode(chunk, { stream: true });
      pushText(text, controller);
    },

    /**
     * @param {TransformStreamDefaultController<T>} controller
     */
    flush(controller) {
      if (decoder) {
        pushText(decoder.decode(), controller);
      }

      if (lineBuffer) {
        enqueueEvent(processLine(lineBuffer), controller);
        lineBuffer = "";
      }

      enqueueEvent(dispatchEvent(), controller);
    }
  });

  /**
   * @param {string} line
   * @returns {T | undefined}
   */
  function processLine(line) {
    if (!line) {
      return dispatchEvent();
    }

    if (line.startsWith("data:")) {
      const value = line.codePointAt(5) === 0x20 ? line.slice(6) : line.slice(5);
      dataBuffer = hasData ? `${dataBuffer}\n${value}` : value;
      hasData = true;
    }
  }

  /** @returns {T | undefined} */
  function dispatchEvent() {
    if (!hasData) {
      return;
    }

    const data = dataBuffer;
    dataBuffer = "";
    hasData = false;

    if (data === "[DONE]") {
      return;
    }

    return /** @type {T} */ (parseSseData(data));
  }

  /**
   * @param {string} text
   * @param {TransformStreamDefaultController<T>} controller
   */
  function pushText(text, controller) {
    const source = lineBuffer + text;
    lineBuffer = "";
    let lineStart = 0;

    for (let index = 0; index < source.length; index += 1) {
      const code = source.codePointAt(index);
      if (code !== 0x0A && code !== 0x0D) {
        continue;
      }

      enqueueEvent(processLine(source.slice(lineStart, index)), controller);

      if (code === 0x0D && source.codePointAt(index + 1) === 0x0A) {
        index += 1;
      }

      lineStart = index + 1;
    }

    lineBuffer = source.slice(lineStart);
  }
}

/**
 * @param {ReadableStream<string | Uint8Array>} stream
 * @template {Record<string, CodexJsonValue>} T
 * @returns {ReadableStream<T>}
 */
export function decodeSseStream(stream) {
  return stream.pipeThrough(sseEventStream());
}

/**
 * @template {Record<string, CodexJsonValue>} T
 * @param {T | undefined} event
 * @param {TransformStreamDefaultController<T>} controller
 */
function enqueueEvent(event, controller) {
  if (event) {
    controller.enqueue(event);
  }
}

/**
 * @param {string} data
 * @template {Record<string, CodexJsonValue>} T
 * @returns {T}
 */
function parseSseData(data) {
  /** @type {CodexJsonValue} */
  let event;
  try {
    event = JSON.parse(data);
  } catch (error) {
    throw new SseParseError("Codex SSE event contained invalid JSON.", {
      cause: error instanceof Error ? error : undefined,
      eventData: data
    });
  }

  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new SseParseError("Codex SSE event JSON must be an object.");
  }

  return /** @type {T} */ (event);
}
