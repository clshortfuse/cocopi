import { Buffer } from "node:buffer";
import SseParseError from "./SseParseError.js";

export { default as SseParseError } from "./SseParseError.js";

/** @typedef {import("../../data/Codex.js").CodexJsonValue} CodexJsonValue */

/**
 * @template {Record<string, CodexJsonValue>} T
 * @param {{ maxEventBytes?: number }} [options]
 * @returns {TransformStream<string | Uint8Array, T>}
 */
export function sseEventStream(options = {}) {
  /** @type {InstanceType<typeof TextDecoder> | undefined} */
  let decoder;
  let lineBuffer = "";
  let lineBytes = 0;
  let lineLastCodeUnit = 0;
  let dataBuffer = "";
  let dataBytes = 0;
  let hasData = false;
  let skipLf = false;

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
      const valueBytes = options.maxEventBytes ? Buffer.byteLength(value) : 0;
      if (options.maxEventBytes && dataBytes + valueBytes + 1 > options.maxEventBytes) {
        throw new Error("Codex local transport event buffer limit exceeded.");
      }
      dataBytes += valueBytes + (hasData ? 1 : 0);
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
    dataBytes = 0;
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
    let lineStart = 0;

    for (let index = 0; index < text.length; index += 1) {
      const code = text.codePointAt(index);
      if (skipLf) {
        skipLf = false;
        if (code === 0x0A) {
          lineStart = index + 1;
          continue;
        }
      }
      if (code !== 0x0A && code !== 0x0D) {
        continue;
      }

      enqueueEvent(processLine(lineBuffer + text.slice(lineStart, index)), controller);
      lineBuffer = "";
      lineBytes = 0;
      lineLastCodeUnit = 0;
      skipLf = code === 0x0D;

      lineStart = index + 1;
    }

    const tail = text.slice(lineStart);
    if (options.maxEventBytes) {
      // eslint-disable-next-line unicorn/prefer-code-point -- A low surrogate must be inspected as a code unit, not a code point.
      const next = tail.charCodeAt(0);
      // Two separately counted surrogate halves encode to 6 replacement bytes;
      // joined as a valid pair they encode to 4 UTF-8 bytes.
      const correction = lineLastCodeUnit >= 0xD8_00 && lineLastCodeUnit <= 0xDB_FF && next >= 0xDC_00 && next <= 0xDF_FF ? 2 : 0;
      lineBytes += Buffer.byteLength(tail) - correction;
      if (tail.length > 0) {
        // eslint-disable-next-line unicorn/prefer-code-point -- Remember the final UTF-16 unit without accessing the accumulated rope.
        lineLastCodeUnit = tail.charCodeAt(tail.length - 1);
      }
    }
    lineBuffer += tail;
    if (options.maxEventBytes && lineBytes + dataBytes > options.maxEventBytes) {
      throw new Error("Codex local transport event buffer limit exceeded.");
    }
  }
}

/**
 * @param {ReadableStream<string | Uint8Array>} stream
 * @param {{ maxEventBytes?: number }} [options]
 * @template {Record<string, CodexJsonValue>} T
 * @returns {ReadableStream<T>}
 */
export function decodeSseStream(stream, options = {}) {
  return stream.pipeThrough(sseEventStream(options));
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
