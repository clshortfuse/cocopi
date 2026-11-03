import test from "node:test";
import assert from "node:assert/strict";

import { fetchWithRetries, readJsonResponse, throwHttpError } from "../lib/utils/http.js";
import { encodeWorkerError, decodeWorkerError } from "../lib/codex-api/worker-protocol.js";
import { languageModelErrorFromCodexError } from "../lib/vscode/language-model-provider.js";

test("terminal HTTP retry timing survives worker and provider boundaries", async (context) => {
  const now = Date.UTC(2026, 9, 21);
  context.mock.method(Date, "now", () => now);
  for (const [header, expected] of [["120", 120_000], ["0", 0], [new Date(now + 120_000).toUTCString(), 120_000], [new Date(now - 1000).toUTCString(), 0], ["invalid", undefined], ["-1", undefined], ["9".repeat(400), undefined]]) {
    let failure;
    try {
      await throwHttpError(new Response("", { status: 429, headers: { "Retry-After": String(header) } }), "Codex");
    } catch (error) {
      assert.ok(error instanceof Error);
      failure = decodeWorkerError(encodeWorkerError(error));
    }
    assert.ok(failure instanceof Error);
    let retryAfter;
    const result = languageModelErrorFromCodexError(failure, new AbortController().signal, {
      LanguageModelError: Object.assign(class extends Error { code = ""; }, {
        NoPermissions: () => Object.assign(new Error("permissions"), { code: "NoPermissions" }),
        NotFound: () => Object.assign(new Error("missing"), { code: "NotFound" }),
        Blocked: () => Object.assign(new Error("blocked"), { code: "Blocked" }),
        RateLimited: (/** @type {string | undefined} */ message, /** @type {number | undefined} */ delay) => {
          retryAfter = delay;
          return Object.assign(new Error(message), { code: "RateLimited" });
        }
      })
    });
    assert.equal(result.code, "RateLimited");
    assert.equal(retryAfter, expected);
  }
});

test("readJsonResponse includes safe error fields", async () => {
  await assert.rejects(
    readJsonResponse(/** @type {Response} */ ({
      ok: false,
      status: 400,
      headers: new Headers({ "x-request-id": "req_123", "cf-ray": "ray_123" }),
      text: async () => JSON.stringify({ error: { code: "bad_request", message: "Missing account id" } })
    }), "Codex models request"),
    /Codex models request failed with status 400; code=bad_request; message=Missing account id; body=\{"error":\{"code":"bad_request","message":"Missing account id"\}\}; request_id=req_123; cf_ray=ray_123/u
  );
});

test("readJsonResponse truncates non-json error text", async () => {
  const longBody = "x".repeat(600);

  await assert.rejects(
    readJsonResponse(/** @type {Response} */ ({
      ok: false,
      status: 502,
      headers: new Headers(),
      text: async () => longBody
    }), "Codex request"),
    /message=x{500}\.\.\./u
  );
});

test("readJsonResponse includes nonstandard JSON error body preview", async () => {
  await assert.rejects(
    readJsonResponse(/** @type {Response} */ ({
      ok: false,
      status: 400,
      headers: new Headers(),
      text: async () => JSON.stringify({ detail: "invalid request", fields: [{ name: "input", reason: "too broad" }] })
    }), "Codex request"),
    /Codex request failed with status 400; message=invalid request; body=\{"detail":"invalid request","fields":\[\{"name":"input","reason":"too broad"\}\]\}/u
  );
});

test("readJsonResponse redacts secrets in body previews", async () => {
  await assert.rejects(
    readJsonResponse(/** @type {Response} */ ({
      ok: false,
      status: 401,
      headers: new Headers(),
      text: async () => JSON.stringify({ error: "bad token", access_token: "eyJheader.payload.signature" })
    }), "Codex request"),
    /body=\{"error":"bad token","access_token":"\[redacted\]"\}/u
  );
});

test("throwHttpError includes visible redirect locations", async () => {
  await assert.rejects(
    throwHttpError(/** @type {Response} */ ({
      ok: false,
      status: 302,
      headers: new Headers({ location: "https://chatgpt.com/auth/login?token=secret" }),
      text: async () => ""
    }), "Codex request"),
    /Codex request failed with status 302; location=https:\/\/chatgpt.com\/auth\/login\?token=\[redacted\]/u
  );
});

test("fetchWithRetries keeps redirects visible", async () => {
  /** @type {RequestInit["redirect"]} */
  let redirect;

  const response = await fetchWithRetries("https://chatgpt.example.test/backend-api/codex/responses", {
    method: "POST"
  }, {
    fetch: /** @type {typeof fetch} */ (async (_url, options = {}) => {
      redirect = options.redirect;
      return new Response("", {
        status: 302,
        headers: { location: "https://chatgpt.com/auth/login" }
      });
    })
  });

  assert.equal(response.status, 302);
  assert.equal(redirect, "manual");
});

test("fetchWithRetries retries transient failures", async () => {
  let calls = 0;
  /** @type {number[]} */
  const delays = [];

  const response = await fetchWithRetries("https://chatgpt.example.test/backend-api/codex/models", {
    method: "GET"
  }, {
    retryDelay: async (milliseconds) => {
      delays.push(milliseconds);
    },
    fetch: /** @type {typeof fetch} */ (async () => {
      calls += 1;
      return Response.json({ models: [{ slug: "gpt-5-codex" }] }, { status: calls === 1 ? 503 : 200 });
    })
  });

  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [250]);
});

test("fetchWithRetries uses exponential backoff for rate limits", async () => {
  let calls = 0;
  /** @type {number[]} */
  const delays = [];

  const response = await fetchWithRetries("https://chatgpt.example.test/backend-api/codex/models", {
    method: "GET"
  }, {
    retryDelay: async (milliseconds) => {
      delays.push(milliseconds);
    },
    fetch: /** @type {typeof fetch} */ (async () => {
      calls += 1;
      return Response.json({ models: [{ slug: "gpt-5-codex" }] }, { status: calls < 3 ? 429 : 200 });
    })
  });

  assert.equal(response.status, 200);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [250, 500]);
});

test("fetchWithRetries honors bounded Retry-After seconds and dates", async () => {
  /** @type {number[]} */
  const delays = [];
  let calls = 0;
  const response = await fetchWithRetries("https://chatgpt.example.test/backend-api/codex/models", { method: "GET" }, {
    retryDelay: async (milliseconds) => { delays.push(milliseconds); },
    fetch: /** @type {typeof fetch} */ (async () => {
      calls += 1;
      return Response.json({}, {
        status: calls < 3 ? 429 : 200,
        headers: calls === 1
          ? { "Retry-After": "3" }
          : { "Retry-After": new Date(Date.now() + 60_000).toUTCString() }
      });
    })
  });

  assert.equal(response.status, 200);
  assert.deepEqual(delays, [3000, 30_000]);
});

test("fetchWithRetries ignores malformed Retry-After advice", async () => {
  /** @type {number[]} */
  const delays = [];
  let calls = 0;
  await fetchWithRetries("https://chatgpt.example.test/backend-api/codex/models", { method: "GET" }, {
    retryDelay: async (milliseconds) => { delays.push(milliseconds); },
    fetch: /** @type {typeof fetch} */ (async () => Response.json({}, {
      status: ++calls < 3 ? 503 : 200,
      headers: { "Retry-After": calls === 1 ? "not a date" : "1.5" }
    }))
  });

  assert.deepEqual(delays, [250, 500]);
});

test("fetchWithRetries caps Retry-After seconds and never waits after its final attempt", async () => {
  /** @type {number[]} */
  const delays = [];
  const response = await fetchWithRetries("https://chatgpt.example.test/backend-api/codex/models", { method: "GET" }, {
    retries: 1,
    retryDelay: async (milliseconds) => { delays.push(milliseconds); },
    fetch: /** @type {typeof fetch} */ (async () => Response.json({}, {
      status: 429,
      headers: { "Retry-After": "999999999999999999999" }
    }))
  });

  assert.equal(response.status, 429);
  assert.deepEqual(delays, [30_000]);
});
