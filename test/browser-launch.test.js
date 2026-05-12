import test from "node:test";
import assert from "node:assert/strict";

import { browserLaunchCommand } from "../lib/utils/browser-launch.js";

test("browserLaunchCommand opens Windows URLs without shell parsing", () => {
  const url = "https://auth.example.test/oauth/authorize?response_type=code&client_id=abc&state=xyz";
  assert.deepEqual(browserLaunchCommand(url, "win32"), {
    command: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", url]
  });
});

test("browserLaunchCommand uses direct opener on macOS and Linux", () => {
  const url = "https://auth.example.test/oauth/authorize?response_type=code&client_id=abc";
  assert.deepEqual(browserLaunchCommand(url, "darwin"), { command: "open", args: [url] });
  assert.deepEqual(browserLaunchCommand(url, "linux"), { command: "xdg-open", args: [url] });
});