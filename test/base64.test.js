import test from "node:test";
import assert from "node:assert/strict";

import { decodeBase64UrlAsUtf8 } from "../lib/utils/base64.js";

const FIXTURES = [
  { utf8: "f", base64UrlString: "Zg" },
  { utf8: "fo", base64UrlString: "Zm8" },
  { utf8: "foo", base64UrlString: "Zm9v" },
  { utf8: "£", base64UrlString: "wqM" },
  { utf8: "€", base64UrlString: "4oKs" },
  { utf8: "🙈", base64UrlString: "8J-ZiA" },
  { utf8: "€A", base64UrlString: "4oKsQQ" },
  { utf8: "€AB", base64UrlString: "4oKsQUI" },
  { utf8: "€€", base64UrlString: "4oKs4oKs" },
  { utf8: "€🙈", base64UrlString: "4oKs8J-ZiA" },
  { utf8: "🙈🙈", base64UrlString: "8J-ZiPCfmYg" }
];

for (const { utf8, base64UrlString } of FIXTURES) {
  test(`decodeBase64UrlAsUtf8 decodes ${utf8}`, () => {
    assert.equal(decodeBase64UrlAsUtf8(base64UrlString), utf8);
  });
}

test("decodeBase64UrlAsUtf8 rejects invalid length", () => {
  assert.throws(() => decodeBase64UrlAsUtf8("A"), /Invalid base64url/u);
});

test("decodeBase64UrlAsUtf8 rejects invalid UTF-8", () => {
  assert.throws(() => decodeBase64UrlAsUtf8("_w"), /Invalid UTF-8/u);
});
