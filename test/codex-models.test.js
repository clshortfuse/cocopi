import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { COCOPI_ORIGINATOR, codexUserAgent } from "../lib/codex-api/codex-headers.js";
import { chooseCodexModel, fetchCodexModelsResponse, listCodexModels, parseModelsResponse } from "../lib/codex-api/models.js";

const chatgptProCatalogFixture = JSON.parse(await readFile(new URL("fixtures/codex-models/chatgpt-pro-catalog.json", import.meta.url), "utf8"));

test("chatgpt pro catalog fixture uses captured server model ids", () => {
  const rawModels = chatgptProCatalogFixture.models;

  assert.ok(Array.isArray(rawModels), "expected captured catalog fixture to include models");
  assert.deepEqual(rawModels.map((model) => model.slug), ["gpt-5.3-codex-spark", "gpt-5.5"]);
  assert.equal(rawModels.some((model) => /fixture/u.test(`${model.slug ?? ""} ${model.display_name ?? ""}`)), false);
});

test("parseModelsResponse reads Codex backend model catalog", () => {
  assert.deepEqual(parseModelsResponse({
    models: [
      {
        slug: "gpt-5-codex",
        display_name: "GPT-5 Codex",
        description: "Coding model.",
        supported_in_api: true,
        priority: 1,
        context_window: 272_000,
        max_context_window: 1_000_000,
        auto_compact_token_limit: null,
        additional_speed_tiers: ["fast"],
        default_reasoning_level: "xhigh",
        supported_reasoning_levels: [
          { effort: "low", description: "Quick scan" },
          { effort: "xhigh", description: "Deep work" }
        ],
        supports_reasoning_summaries: true,
        default_reasoning_summary: "detailed",
        available_in_plans: ["pro", "business"],
        capabilities: { image_input: false }
      },
      { slug: "gpt-5.2", display_name: "GPT-5.2", supports_images: true }
    ]
  }), [
    {
      id: "gpt-5-codex",
      displayName: "GPT-5 Codex",
      description: "Coding model.",
      supportedInApi: true,
      priority: 1,
      contextWindow: 272_000,
      maxContextWindow: 1_000_000,
      autoCompactTokenLimit: null,
      additionalSpeedTiers: ["fast"],
      defaultReasoningLevel: "xhigh",
      supportedReasoningLevels: [
        { effort: "low", description: "Quick scan" },
        { effort: "xhigh", description: "Deep work" }
      ],
      supportsReasoningSummaries: true,
      defaultReasoningSummary: "detailed",
      availableInPlans: ["pro", "business"],
      imageInput: false
    },
    { id: "gpt-5.2", displayName: "GPT-5.2", imageInput: true }
  ]);
});

test("parseModelsResponse also accepts OpenAI-compatible data arrays", () => {
  assert.deepEqual(parseModelsResponse({ data: [{ id: "gpt-test" }] }), [{ id: "gpt-test", displayName: "gpt-test" }]);
});

test("parseModelsResponse preserves empty supported reasoning levels", () => {
  assert.deepEqual(parseModelsResponse({
    models: [{ slug: "gpt-no-reasoning", supported_reasoning_levels: [] }]
  }), [{ id: "gpt-no-reasoning", displayName: "gpt-no-reasoning", supportedReasoningLevels: [] }]);
});

test("parseModelsResponse preserves explicit false reasoning summary support", () => {
  assert.deepEqual(parseModelsResponse({
    models: [{
      slug: "gpt-no-summary",
      supports_reasoning_summaries: false,
      default_reasoning_summary: "detailed"
    }]
  }), [{
    id: "gpt-no-summary",
    displayName: "gpt-no-summary",
    supportsReasoningSummaries: false,
    defaultReasoningSummary: "detailed"
  }]);
});

test("parseModelsResponse preserves live catalog external API support metadata", () => {
  const models = parseModelsResponse(chatgptProCatalogFixture);
  const unsupportedModel = models.find((model) => model.supportedInApi === false);

  assert.ok(unsupportedModel, "expected fixture to include a model marked unsupported in the external API");
  assert.equal(unsupportedModel.supportedInApi, false);
  assert.equal(unsupportedModel.defaultReasoningLevel, "high");
  assert.equal(unsupportedModel.supportedReasoningLevels?.length, 4);
  assert.equal(unsupportedModel.supportsReasoningSummaries, true);
  assert.equal(unsupportedModel.defaultReasoningSummary, "none");
});

test("parseModelsResponse reads image input from catalog modalities", () => {
  assert.deepEqual(parseModelsResponse({
    models: [
      { slug: "gpt-image-modalities", input_modalities: ["text", "image"] },
      { slug: "gpt-vision-capabilities", capabilities: { supports_vision: true } }
    ]
  }), [
    { id: "gpt-image-modalities", displayName: "gpt-image-modalities", imageInput: true },
    { id: "gpt-vision-capabilities", displayName: "gpt-vision-capabilities", imageInput: true }
  ]);
});

test("chooseCodexModel prefers configured Codex model then Codex-looking fallback", () => {
  assert.equal(chooseCodexModel([{ id: "gpt-5-codex", displayName: "GPT-5 Codex" }]), "gpt-5-codex");
  assert.equal(chooseCodexModel([{ id: "gpt-5.2-codex", displayName: "GPT-5.2 Codex" }]), "gpt-5.2-codex");
  assert.equal(chooseCodexModel([{ id: "gpt-5.2", displayName: "GPT-5.2" }]), "gpt-5.2");
});

test("codexUserAgent returns a stable process value", () => {
  assert.equal(codexUserAgent(), codexUserAgent());
  assert.match(codexUserAgent(), /^cocopi\/0\.0\.1 \(.+; .+\) node\/\d+\.\d+\.\d+$/u);
});

test("listCodexModels sends bearer auth to backend models endpoint", async () => {
  /** @type {Array<{ url: string, options: RequestInit & { headers: Record<string, string> } }>} */
  const calls = [];
  const models = await listCodexModels({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    fetch: /** @type {typeof fetch} */ (async (url, options = {}) => {
      calls.push({
        url: String(url),
        options: /** @type {RequestInit & { headers: Record<string, string> }} */ (options)
      });
      return /** @type {Response} */ ({
        ok: true,
        status: 200,
        json: async () => ({ models: [{ slug: "gpt-5-codex" }] })
      });
    })
  });

  assert.deepEqual(models, [{ id: "gpt-5-codex", displayName: "gpt-5-codex" }]);
  assert.equal(calls[0].url, "https://chatgpt.example.test/backend-api/codex/models?client_version=0.125.0");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Authorization, "Bearer access-token");
  assert.equal(calls[0].options.headers.originator, COCOPI_ORIGINATOR);
  assert.equal(calls[0].options.headers.version, "0.125.0");
  assert.equal(calls[0].options.headers["User-Agent"], codexUserAgent());
  assert.match(calls[0].options.headers["User-Agent"], /^cocopi\/0\.0\.1 \(.+; .+\) node\/\d+\.\d+\.\d+$/u);
});

test("fetchCodexModelsResponse returns redaction-safe debug metadata", async () => {
  const result = await fetchCodexModelsResponse({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    clientVersion: "1.2.3",
    fetch: /** @type {typeof fetch} */ (async () => /** @type {Response} */ ({
      ok: true,
      status: 200,
      headers: new Headers({ etag: "abc" }),
      json: async () => ({ models: [{ slug: "gpt-5-codex" }, { slug: "gpt-5.2" }] })
    }))
  });

  assert.deepEqual(result, {
    models: [
      { id: "gpt-5-codex", displayName: "gpt-5-codex" },
      { id: "gpt-5.2", displayName: "gpt-5.2" }
    ],
    debug: {
      url: "https://chatgpt.example.test/backend-api/codex/models?client_version=1.2.3",
      status: 200,
      etag: "abc",
      modelIds: ["gpt-5-codex", "gpt-5.2"]
    }
  });
});

test("listCodexModels can include ChatGPT account header", async () => {
  /** @type {Array<{ options: RequestInit & { headers: Record<string, string> } }>} */
  const calls = [];
  await listCodexModels({
    apiBaseUrl: "https://chatgpt.example.test/backend-api/codex",
    accessToken: "access-token",
    chatgptAccountId: "account-id",
    fetch: /** @type {typeof fetch} */ (async (_url, options = {}) => {
      calls.push({ options: /** @type {RequestInit & { headers: Record<string, string> }} */ (options) });
      return /** @type {Response} */ ({
        ok: true,
        status: 200,
        json: async () => ({ models: [{ slug: "gpt-5-codex" }] })
      });
    })
  });

  assert.equal(calls[0].options.headers["ChatGPT-Account-ID"], "account-id");
});
