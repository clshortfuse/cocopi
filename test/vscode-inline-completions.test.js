// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";

import { createCocopiInlineCompletionProvider, inlineCompletionContextFromDocument, chooseInlineCompletionModel, registerCocopiInlineCompletionProvider, sanitizeInlineCompletionText } from "../lib/vscode/inline-completions.js";
import { CODEX_SECRET_KEYS } from "../lib/vscode/secret-storage.js";

class InlineCompletionItem {
  /**
   * @param {string} insertText
   * @param {Range} [range]
   */
  constructor(insertText, range) {
    this.insertText = insertText;
    this.range = range;
  }
}

class Range {
  /**
   * @param {object} start
   * @param {object} end
   */
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}

test("registerCocopiInlineCompletionProvider registers supported document schemes", () => {
  const context = fakeContext();
  const vscode = fakeVscode();

  registerCocopiInlineCompletionProvider(context, vscode);

  assert.deepEqual(vscode.inlineCompletionSelectors[0], [
    { scheme: "file" },
    { scheme: "untitled" },
    { scheme: "vscode-notebook-cell" }
  ]);
  assert.equal(context.subscriptions.length, 1);
});

test("inline completion provider stays quiet when disabled", async (testContext) => {
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => {
    throw new Error("fetch should not be called");
  }));
  const provider = createCocopiInlineCompletionProvider(fakeContext(), fakeVscode());

  const items = await provider.provideInlineCompletionItems(fakeDocument("const value =", 13), { line: 0, character: 13 }, {}, fakeCancellationToken());

  assert.equal(items, undefined);
});

test("inline completion provider builds a Codex request with the auto Spark model", async (testContext) => {
  /** @type {Array<{ url: string, options: RequestInit }>} */
  const calls = [];
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/models?client_version=0.125.0")) {
      return Response.json({
        models: [
          { slug: "gpt-main", display_name: "Main" },
          { slug: "gpt-5-spark-test", display_name: "Spark Test" }
        ]
      });
    }

    return new Response([
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\" 42;\"}",
      "",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"response-id\"}}",
      ""
    ].join("\n"), {
      headers: { "content-type": "text/event-stream" }
    });
  }));
  const provider = createCocopiInlineCompletionProvider(
    signedInContext(),
    fakeVscode(configurationValues({
      "inlineCompletions.enabled": true,
      "inlineCompletions.model": "auto",
      model: "gpt-main",
      transport: "sse"
    }))
  );

  const items = await provider.provideInlineCompletionItems(fakeDocument("const value =", 13), { line: 0, character: 13 }, {}, fakeCancellationToken());

  assert.equal(items?.[0]?.insertText, " 42;");
  assert.equal(items?.[0]?.range?.start.character, 13);
  assert.equal(calls.length, 2);
  const body = JSON.parse(String(calls[1].options.body));
  assert.equal(body.model, "gpt-5-spark-test");
  assert.equal(body.stream, true);
  assert.equal(body.tool_choice, "none");
  assert.equal(body.store, false);
  assert.equal(body.client_metadata["x-cocopi-request-kind"], "inline-completion");
  assert.match(body.input[0].content[0].text, /<prefix>\nconst value =\n<\/prefix>/u);
});

test("inline completion provider uses the configured inline model without catalog lookup", async (testContext) => {
  /** @type {Array<{ url: string, options: RequestInit }>} */
  const calls = [];
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return new Response([
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"configured\"}",
      "",
      "data: {\"type\":\"response.completed\",\"response\":{}}",
      ""
    ].join("\n"), {
      headers: { "content-type": "text/event-stream" }
    });
  }));
  const provider = createCocopiInlineCompletionProvider(
    signedInContext(),
    fakeVscode(configurationValues({
      "inlineCompletions.enabled": true,
      "inlineCompletions.model": "gpt-configured",
      transport: "sse"
    }))
  );

  await provider.provideInlineCompletionItems(fakeDocument("abc", 3), { line: 0, character: 3 }, {}, fakeCancellationToken());

  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(String(calls[0].options.body)).model, "gpt-configured");
});

test("inline completion provider logs verbose diagnostics when debug output is enabled", async (testContext) => {
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => new Response([
    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"diagnostic\"}",
    "",
    "data: {\"type\":\"response.completed\",\"response\":{}}",
    ""
  ].join("\n"), {
    headers: { "content-type": "text/event-stream" }
  })));
  const logger = fakeLogger();
  const provider = createCocopiInlineCompletionProvider(
    signedInContext(),
    fakeVscode(configurationValues({
      debugLevel: "events",
      "inlineCompletions.enabled": true,
      "inlineCompletions.model": "gpt-configured",
      transport: "sse"
    })),
    { logger }
  );

  await provider.provideInlineCompletionItems(fakeDocument("const value =", 13), { line: 0, character: 13 }, { triggerKind: 1 }, fakeCancellationToken());

  assert.ok(logger.debugMessages.some((message) => message.includes("Cocopi inline completion request.")
    && message.includes("source=inline-completion")
    && message.includes("model=gpt-configured")
    && message.includes("prefixChars=13")));
  assert.ok(logger.debugMessages.some((message) => message.includes("Codex request input.")
    && message.includes("source=inline-completion")
    && message.includes("model=gpt-configured")));
  assert.ok(logger.debugMessages.some((message) => message.includes("Codex stream event.")
    && message.includes("source=inline-completion")
    && message.includes("type=response.output_text.delta")));
  assert.ok(logger.debugMessages.some((message) => message.includes("Cocopi inline completion result.")
    && message.includes("outputChars=10")));
});

test("inline completion provider skips unsupported schemes and cancelled tokens", async (testContext) => {
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => {
    throw new Error("fetch should not be called");
  }));
  const provider = createCocopiInlineCompletionProvider(
    signedInContext(),
    fakeVscode(configurationValues({ "inlineCompletions.enabled": true }))
  );
  const token = fakeCancellationToken();
  token.cancel();

  assert.equal(await provider.provideInlineCompletionItems(fakeDocument("abc", 3, { scheme: "git" }), { line: 0, character: 3 }, {}, fakeCancellationToken()), undefined);
  assert.equal(await provider.provideInlineCompletionItems(fakeDocument("abc", 3), { line: 0, character: 3 }, {}, token), undefined);
});

test("inline completion helpers normalize context, model preference, and fenced output", () => {
  const snippet = inlineCompletionContextFromDocument(fakeDocument("0123456789", 5), { line: 0, character: 5 }, {
    maxPrefixCharacters: 3,
    maxSuffixCharacters: 2
  });

  assert.deepEqual(snippet, {
    prefix: "234",
    suffix: "56",
    languageId: "javascript",
    fileName: String.raw`C:\test\file.js`
  });
  assert.equal(chooseInlineCompletionModel([
    { id: "gpt-main", displayName: "Main" },
    { id: "gpt-5-spark-test", displayName: "Spark Test" }
  ], "gpt-main"), "gpt-5-spark-test");
  assert.equal(sanitizeInlineCompletionText("```js\nreturn value;\n```"), "return value;");
  assert.equal(sanitizeInlineCompletionText("   \n"), "");
});

function signedInContext() {
  return fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"],
    [CODEX_SECRET_KEYS.chatgptAccountId, "account-id"]
  ]));
}

/** @param {Map<string, string>} [secrets] */
function fakeContext(secrets = new Map()) {
  return {
    subscriptions: [],
    secrets: {
      /** @param {string} key */
      async get(key) {
        return secrets.get(key);
      },
      /**
       * @param {string} key
       * @param {string} value
       */
      async store(key, value) {
        secrets.set(key, value);
      },
      /** @param {string} key */
      async delete(key) {
        secrets.delete(key);
      }
    }
  };
}

/**
 * @param {Map<string, string | number | boolean>} [configuration]
 */
function fakeVscode(configuration = new Map()) {
  const vscode = {
    /** @type {import("vscode").DocumentSelector[]} */
    inlineCompletionSelectors: [],
    languages: {
      /**
       * @param {import("vscode").DocumentSelector} selector
       * @param {import("vscode").InlineCompletionItemProvider} provider
       */
      registerInlineCompletionItemProvider(selector, provider) {
        void provider;
        vscode.inlineCompletionSelectors.push(selector);
        return { dispose() {} };
      }
    },
    workspace: {
      getConfiguration() {
        return {
          /**
           * @template T
           * @param {string} key
           * @param {T} defaultValue
           * @returns {T}
           */
          get(key, defaultValue) {
            return /** @type {T} */ (configuration.get(key) ?? defaultValue);
          }
        };
      }
    },
    InlineCompletionItem,
    Range
  };

  return vscode;
}

function fakeLogger() {
  return {
    debugMessages: [],
    debug(message) {
      this.debugMessages.push(message);
    },
    info() {},
    error() {},
    dispose() {}
  };
}

/**
 * @param {Record<string, string | number | boolean>} record
 */
function configurationValues(record) {
  /** @type {Map<string, string | number | boolean>} */
  const values = new Map();
  for (const [key, value] of Object.entries(record)) {
    values.set(key, value);
  }

  return values;
}

/**
 * @param {string} text
 * @param {number} cursorOffset
 * @param {{ scheme?: string }} [options]
 * @returns {import("vscode").TextDocument}
 */
function fakeDocument(text, cursorOffset, options = {}) {
  void cursorOffset;
  return /** @type {import("vscode").TextDocument} */ ({
    uri: {
      scheme: options.scheme ?? "file",
      fsPath: String.raw`C:\test\file.js`,
      toString: () => "file:///C:/test/file.js"
    },
    fileName: String.raw`C:\test\file.js`,
    languageId: "javascript",
    getText() {
      return text;
    },
    /** @param {{ character: number }} position */
    offsetAt(position) {
      return position.character;
    }
  });
}

function fakeCancellationToken() {
  /** @type {Set<() => void>} */
  const listeners = new Set();
  return /** @type {import("vscode").CancellationToken & { cancel(): void }} */ ({
    isCancellationRequested: false,
    /** @param {() => void} listener */
    onCancellationRequested(listener) {
      listeners.add(listener);
      return {
        dispose() {
          listeners.delete(listener);
        }
      };
    },
    cancel() {
      this.isCancellationRequested = true;
      for (const listener of listeners) {
        listener();
      }
    }
  });
}
