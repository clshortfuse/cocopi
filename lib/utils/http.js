/** @typedef {import("../../data/Codex.js").CodexJsonValue} CodexJsonValue */

/**
 * @param {CodexJsonValue | undefined} value
 */
function readString(value) {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * @param {number} status
 */
function isRetryableStatus(status) {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * @param {number} milliseconds
 * @param {AbortSignal | null | undefined} signal
 */
function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(signal.reason);
    }, { once: true });
  });
}

/**
 * @param {string | URL | Request} url
 * @param {RequestInit} init
 * @param {{ fetch?: typeof fetch, retries?: number, retryDelay?: (milliseconds: number) => Promise<void>, retryDelayMs?: number, maxRetryDelayMs?: number }} [options]
 */
export async function fetchWithRetries(url, init, options = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const retries = options.retries ?? 2;
  const retryDelay = options.retryDelay ?? ((milliseconds) => delay(milliseconds, init.signal));
  const retryDelayMs = options.retryDelayMs ?? 250;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 2000;

  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetchImpl(url, { ...init, redirect: "manual" });
      if (attempt >= retries || !isRetryableStatus(response.status) || init.signal?.aborted) {
        return response;
      }
    } catch (error) {
      if (attempt >= retries || init.signal?.aborted) {
        throw error;
      }
    }

    await retryDelay(Math.min(retryDelayMs * 2 ** attempt, maxRetryDelayMs));
  }
}

/**
 * @param {Response} response
 * @param {string} label
 * @returns {Promise<never>}
 */
export async function throwHttpError(response, label) {
  let text = "";
  try {
    text = await response.text();
  } catch {
    // Keep the original HTTP failure visible even if the error body cannot be read.
  }

  const location = response.headers?.get?.("location");
  /** @type {{ status: number, requestId: string | undefined, cfRay: string | undefined, location: string | undefined, errorCode: string | undefined, errorMessage: string | undefined, bodyPreview: string | undefined }} */
  const detail = {
    status: response.status,
    requestId: response.headers?.get?.("x-request-id")
      ?? response.headers?.get?.("openai-request-id")
      ?? undefined,
    cfRay: response.headers?.get?.("cf-ray") ?? undefined,
    location: response.status >= 300 && response.status < 400 && location ? previewBody(location) : undefined,
    errorCode: undefined,
    errorMessage: undefined,
    bodyPreview: undefined
  };

  if (text) {
    try {
      const body = JSON.parse(text);
      const record = body && typeof body === "object" && !Array.isArray(body) ? /** @type {Record<string, CodexJsonValue>} */ (body) : undefined;
      const error = record?.error && typeof record.error === "object" && !Array.isArray(record.error) ? /** @type {Record<string, CodexJsonValue>} */ (record.error) : record;
      detail.errorCode = readString(error?.code);
      detail.errorMessage = readString(error?.message) ?? readString(record?.message) ?? readString(record?.detail) ?? readString(record?.error);
      detail.bodyPreview = previewBody(JSON.stringify(redactJson(body)));
    } catch {
      detail.errorMessage = previewBody(text);
    }
  }

  throw new Error(formatHttpError(label, detail));
}

/**
 * @template T
 * @param {Response} response
 * @param {string} label
 * @returns {Promise<T>}
 */
export async function readJsonResponse(response, label) {
  if (response.ok) {
    return /** @type {Promise<T>} */ (response.json());
  }

  return throwHttpError(response, label);
}

/**
 * @param {string} label
 * @param {{ status: number, requestId: string | undefined, cfRay: string | undefined, location: string | undefined, errorCode: string | undefined, errorMessage: string | undefined, bodyPreview: string | undefined }} detail
 */
function formatHttpError(label, detail) {
  const parts = [`${label} failed with status ${detail.status}`];
  if (detail.errorCode) parts.push(`code=${detail.errorCode}`);
  if (detail.errorMessage) parts.push(`message=${detail.errorMessage}`);
  if (detail.bodyPreview && detail.bodyPreview !== detail.errorMessage) parts.push(`body=${detail.bodyPreview}`);
  if (detail.location) parts.push(`location=${detail.location}`);
  if (detail.requestId) parts.push(`request_id=${detail.requestId}`);
  if (detail.cfRay) parts.push(`cf_ray=${detail.cfRay}`);
  return parts.join("; ");
}

/**
 * @param {string} text
 */
function previewBody(text) {
  const redacted = redactSecrets(text);
  return redacted.length <= 500 ? redacted : `${redacted.slice(0, 500)}...`;
}

/**
 * @param {CodexJsonValue} value
 * @returns {CodexJsonValue}
 */
function redactJson(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactJson(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  /** @type {Record<string, CodexJsonValue>} */
  const output = {};
  for (const [key, field] of Object.entries(value)) {
    output[key] = /authorization|token|secret|credential|api[-_]?key|cookie|session/iu.test(key) ? "[redacted]" : redactJson(field);
  }

  return output;
}

/**
 * @param {string} text
 */
function redactSecrets(text) {
  return text
    .replaceAll(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gu, "Bearer [redacted]")
    .replaceAll(/sk-[A-Za-z0-9_-]+/gu, "sk-[redacted]")
    .replaceAll(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "jwt-[redacted]")
    .replaceAll(/([?&][^=&#]*(?:authorization|token|secret|credential|api[-_]?key|cookie|session)[^=&#]*=)[^&#\s]+/giu, "$1[redacted]");
}