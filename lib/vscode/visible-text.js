/* eslint-disable jsdoc/check-types -- VS Code chat and language model parts are external proposed API shapes. */

const HIDDEN_PROGRESS_EVENT_TYPES = new Set([
  "response.reasoning_summary_text.delta",
  "response.reasoning_text.delta"
]);
const STANDALONE_REASONING_SUMMARY_HTML_COMMENT = "<!-- -->";
const REASONING_SUMMARY_HTML_COMMENT_PARAGRAPH_BREAKS = ["\n\n", "\r\n\r\n"];

/**
 * @param {unknown} part
 */
export function isCocopiHiddenProgressPart(part) {
  return Boolean(cocopiHiddenProgressMetadataReason(vscodePartMetadata(part)));
}

/**
 * @param {unknown} part
 * @returns {Record<string, unknown> | undefined}
 */
export function vscodePartMetadata(part) {
  if (!part || typeof part !== "object" || !("metadata" in part)) {
    return;
  }

  return metadataRecord(/** @type {{ metadata?: unknown }} */ (part).metadata);
}

/**
 * @param {unknown} metadata
 */
export function cocopiHiddenProgressMetadataReason(metadata) {
  const record = metadataRecord(metadata);
  if (!record) {
    return "";
  }

  const eventType = record.openai_event_type;
  if (typeof eventType === "string" && HIDDEN_PROGRESS_EVENT_TYPES.has(eventType)) {
    return `event:${eventType}`;
  }
  if (record.vscode_reasoning_done === true) {
    return "vscode-reasoning-done";
  }
  if (typeof record.cocopi_tool_progress === "string") {
    return "tool-progress";
  }

  return "";
}

/**
 * @template T
 * @param {(text: string, options: T) => void} emit
 */
export function createReasoningSummaryHtmlCommentSanitizer(emit) {
  /** @type {{ text: string, artifact: string, options: T, complete: boolean, dropOnlyWhenTrailing: boolean } | undefined} */
  let pending;

  /**
   * @param {boolean} trailing
   */
  const flushPending = (trailing) => {
    if (!pending) {
      return;
    }

    const value = pending;
    pending = undefined;
    if (value.complete && value.dropOnlyWhenTrailing && trailing) {
      return;
    }
    emit(value.text, value.options);
  };

  /**
   * @param {string} text
   * @param {T} options
   */
  const append = (text, options) => {
    if (!text) {
      return;
    }

    if (pending) {
      const combined = pending.text + text;
      if (combined === pending.artifact) {
        pending.text = combined;
        pending.options = options;
        pending.complete = true;
        if (!pending.dropOnlyWhenTrailing) {
          pending = undefined;
        }
        return;
      }
      if (pending.artifact.startsWith(combined)) {
        pending.text = combined;
        pending.options = options;
        return;
      }
      if (combined.startsWith(pending.artifact)) {
        const remainder = combined.slice(pending.artifact.length);
        if (pending.dropOnlyWhenTrailing) {
          emit(pending.artifact, pending.options);
        }
        pending = undefined;
        append(remainder, options);
        return;
      }

      flushPending(false);
    }

    if (text === STANDALONE_REASONING_SUMMARY_HTML_COMMENT) {
      return;
    }
    if (isStandaloneReasoningSummaryHtmlCommentPrefix(text)) {
      pending = {
        text,
        artifact: STANDALONE_REASONING_SUMMARY_HTML_COMMENT,
        options,
        complete: false,
        dropOnlyWhenTrailing: false
      };
      return;
    }

    const trailingComment = trailingStandaloneReasoningSummaryHtmlCommentParagraph(text);
    if (trailingComment) {
      emit(text.slice(0, -trailingComment.text.length), options);
      pending = {
        text: trailingComment.text,
        artifact: trailingComment.artifact,
        options,
        complete: trailingComment.complete,
        dropOnlyWhenTrailing: true
      };
      return;
    }

    emit(text, options);
  };

  return {
    append,

    flush() {
      flushPending(false);
    },

    finish() {
      flushPending(true);
    }
  };
}

/** @param {string} text */
function isStandaloneReasoningSummaryHtmlCommentPrefix(text) {
  return text.length > 0
    && text.length < STANDALONE_REASONING_SUMMARY_HTML_COMMENT.length
    && STANDALONE_REASONING_SUMMARY_HTML_COMMENT.startsWith(text);
}

/** @param {string} text */
function trailingStandaloneReasoningSummaryHtmlCommentParagraph(text) {
  let match;
  for (const paragraphBreak of REASONING_SUMMARY_HTML_COMMENT_PARAGRAPH_BREAKS) {
    if (text.endsWith(`${paragraphBreak}${STANDALONE_REASONING_SUMMARY_HTML_COMMENT}`)) {
      return {
        text: STANDALONE_REASONING_SUMMARY_HTML_COMMENT,
        artifact: STANDALONE_REASONING_SUMMARY_HTML_COMMENT,
        complete: true
      };
    }
    for (let length = STANDALONE_REASONING_SUMMARY_HTML_COMMENT.length - 1; length > 0; length -= 1) {
      const prefix = STANDALONE_REASONING_SUMMARY_HTML_COMMENT.slice(0, length);
      if (prefix.includes("<!--") && text.endsWith(`${paragraphBreak}${prefix}`) && (!match || prefix.length > match.text.length)) {
        match = { text: prefix, artifact: STANDALONE_REASONING_SUMMARY_HTML_COMMENT, complete: false };
      }
    }
  }

  return match;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | undefined}
 */
function metadataRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : undefined;
}

/* eslint-enable jsdoc/check-types */