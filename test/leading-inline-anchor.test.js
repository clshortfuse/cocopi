import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import { createLanguageModelTextProgressReporter } from "../lib/vscode/language-model-provider.js";

test("leading filename remains in final prose after an edit block", () => {
  /** @type {string[]} */
  const reports = [];
  class TextPart {
    /** @param {string} value */
    constructor(value) { this.value = value; }
  }
  const progress = createLanguageModelTextProgressReporter({ report(part) { if (part instanceof TextPart) reports.push(part.value); } }, { LanguageModelTextPart: TextPart }, {
    separateLeadingCode: true, debugLevel: "off", logger: { debug() {}, info() {}, error() {}, dispose() {} }, onReport() {}
  });
  for (const delta of ["`", "scene", "_fixed", ".s", "lang", "`", " now compiles."]) progress.report(delta);
  progress.finish();
  const text = reports.join("");
  const filename = "`scene_fixed.slang`";
  const at = text.indexOf(filename);
  assert.ok(at !== -1, "the exact model filename is preserved");
  const source = readFileSync(new URL("fixtures/vscode-leading-anchor-annotation.txt", import.meta.url), "utf8");
  const annotate = new Script(`${source}\nFdo;`).runInNewContext({
    nje: "http://_vscodecontentref_",
    be: class {
      /** @param {string} value */
      constructor(value) { Object.assign(this, { value, supportHtml: false, supportThemeIcons: false }); }
    },
    P: { parse: (/** @type {string} */ value) => ({ with: (/** @type {{ path: string }} */ options) => ({ toString: () => `${value}/${options.path}` }) }) },
    // The sanitized fixture has balanced edit fences, never an open code context.
    WBr: () => false,
    HBr: (/** @type {string} */ value) => /^\[.*\]\(http:\/\/_vscodecontentref_\/\d+\)$/u.test(value),
    Jdi: (/** @type {{ baseUri?: string }} */ a, /** @type {{ baseUri?: string }} */ b) => a.baseUri === b.baseUri,
    ame: (/** @type {{ value: string }} */ a, /** @type {{ value: string }} */ b) => ({ ...a, value: a.value + b.value })
  });
  /**
   * @param {string} value
   * @param {boolean} [normal]
   */
  const markdown = (value, normal = false) => ({ kind: "markdownContent", content: { value, supportHtml: false, supportThemeIcons: false, ...(normal ? { baseUri: "file:///synthetic/" } : {}) } });
  /** @type {object[]} */
  const parts = [markdown("\n```\n"), { kind: "undoStop" }, { kind: "codeblockUri", isEdit: true, uri: { toString: () => "file:///synthetic/edit.md" } }, { kind: "textEditGroup" }, markdown("\n```\n")];
  if (at > 0) parts.push(markdown(text.slice(0, at), true));
  parts.push({ kind: "inlineReference", name: "scene_fixed.slang" }, markdown(text.slice(at + filename.length), true));
  /** @type {{ content: { kind: string, content?: { value: string } } }[]} */
  const rendered = annotate(parts);
  const final = rendered.at(-1)?.content.content?.value ?? "";
  assert.match(final, /scene_fixed\.slang.* now compiles\./u, "filename must belong to final prose, not the preceding edited-file block");
});

test("paragraph compatibility boundary is limited to leading code on tool follow-ups", () => {
  class TextPart {
    /** @param {string} value */
    constructor(value) { this.value = value; }
  }
  for (const [enabled, input, expected] of [
    [false, "`file.cpp` done.", "`file.cpp` done."],
    [true, "Normal prose.", "Normal prose."],
    [true, "\n`file.cpp` done.", "\n`file.cpp` done."],
    [true, "`file.cpp` done.", "\n\n`file.cpp` done."]
  ]) {
    /** @type {string[]} */
    const reports = [];
    const reporter = createLanguageModelTextProgressReporter({ report(part) { if (part instanceof TextPart) reports.push(part.value); } }, { LanguageModelTextPart: TextPart }, {
      separateLeadingCode: Boolean(enabled), debugLevel: "off", logger: { debug() {}, info() {}, error() {}, dispose() {} }, onReport() {}
    });
    for (const character of String(input)) reporter.report(character);
    reporter.finish();
    assert.equal(reports.join(""), expected);
  }
});