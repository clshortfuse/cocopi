import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { processEvent, replyStatus, watchGoal } from "../plugins/goalkeeper/protocol.mjs";
import { writeGoalkeeperSettings } from "../plugins/goalkeeper/settings.mjs";

const hook = fileURLToPath(new URL("../plugins/goalkeeper/protocol.mjs", import.meta.url));

test("goalkeeper continues only its own chat and requires a status for the current goal", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cocopi-goalkeeper-test-"));
  /**
   * @param {string} action
   * @param {object} event
   */
  const run = (action, event) => {
    const child = spawnSync(process.execPath, [hook, action], {
      env: { ...process.env, COPILOT_HOME: home },
      input: JSON.stringify({ sessionId: "chat-a", ...event }), encoding: "utf8"
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  const transcriptPath = path.join(home, "events.jsonl");
  const stop = { stopReason: "end_turn", transcriptPath };
  /** @param {string} content */
  const reply = (content) => writeFile(transcriptPath, [
    { type: "user.message", data: { content: "/goalkeeper <goal>complete</goal>" } },
    { type: "assistant.turn_start" },
    { type: "assistant.message", data: { content, toolRequests: [] } },
    { type: "assistant.message", agentId: "child", data: { content: "<goal>complete</goal>" } }
  ].map((event) => JSON.stringify({ timestamp: new Date(Date.now() + 1000).toISOString(), ...event })).join("\n"));
  try {
    const directory = path.join(home, "cocopi-goalkeeper");
    await writeGoalkeeperSettings({ prependInstructions: "Before", appendInstructions: "After" }, directory);
    /** @param {string} goal */
    const expanded = (goal) => `The user explicitly invoked the "/VS Code Synced Data:goalkeeper" skill. Follow its instructions now.\n\n<skill-context name="goalkeeper">\nInstructions.\n\nARGUMENTS: ${goal}\n</skill-context>`;
    const start = run("prompt", { prompt: expanded("finish tests"), transformedPrompt: "Host prompt" });
    assert.match(start.modifiedTransformedPrompt, /^Host prompt\n\nBefore[\s\S]*finish tests[\s\S]*After\n\nIf waiting/u);
    await reply("Example:\n```xml\n<goal>complete</goal>");
    assert.deepEqual(run("stop", { ...stop, sessionId: "chat-b" }), {});
    assert.equal(run("stop", stop).decision, "block");
    await reply("I checked the fixtures.\n<goal>\nPlease provide the sample.\nThe existing fixtures do not reproduce the issue.\n</goal>");
    assert.deepEqual(run("stop", stop), {});
    assert.match(run("prompt", { prompt: "Here is the sample", transformedPrompt: "Here is the sample" }).modifiedTransformedPrompt, /Do not launch a Goalkeeper watcher/u);
    await reply("More work remains.");
    assert.deepEqual(run("stop", stop), {});
    run("prompt", { prompt: "/goalkeeper next goal", transformedPrompt: "Host prompt" });
    assert.match(run("prompt", { prompt: "What's left?", transformedPrompt: "What's left?" }).modifiedTransformedPrompt, /delegation has ended/u);
    assert.deepEqual(run("stop", stop), {});
    run("prompt", { sessionId: "chat-b", prompt: "/goalkeeper independent", transformedPrompt: "Host prompt" });
    await reply("Verified the count.\n<goal>complete</goal>");
    assert.deepEqual(run("stop", { ...stop, sessionId: "chat-b" }), {});
    run("prompt", { sessionId: "chat-b", prompt: "/goalkeeper new independent goal", transformedPrompt: "Host prompt" });
    await reply("Still working.");
    assert.deepEqual(run("prompt", { prompt: "/goalkeeper off", transformedPrompt: "Host prompt" }), {});
    assert.deepEqual(run("stop", stop), {});
    assert.match(run("prompt", { sessionId: "chat-b", prompt: "", transformedPrompt: "Host wake-up" }).modifiedTransformedPrompt, /new independent goal/u);
    const rejected = run("prompt", { sessionId: "chat-b", prompt: `/goalkeeper ${"x".repeat(8001)}`, transformedPrompt: "New goal" });
    assert.match(rejected.modifiedTransformedPrompt, /exceeds 8,000 characters/u);
    assert.deepEqual(run("prompt", { sessionId: "chat-b", prompt: "", transformedPrompt: "Host wake-up" }), {});
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Goalkeeper retires a scheduled check-in when the user takes over", { timeout: 8000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cocopi-goalkeeper-"));
  const sessionId = "goalkeeper-takeover";
  const key = createHash("sha256").update(sessionId).digest("hex");
  const transcriptPath = path.join(directory, "events.jsonl");
  /** @type {ReturnType<typeof watchGoal> | undefined} */
  let watcher;
  try {
    await processEvent("prompt", { sessionId, prompt: "/goalkeeper test" }, directory);
    const { id } = JSON.parse(await readFile(path.join(directory, `${key}.json`), "utf8"));
    await writeFile(transcriptPath, JSON.stringify({ type: "assistant.message", timestamp: new Date(Date.now() + 1000).toISOString(), data: { content: '<goal wait="120">Waiting for tests.</goal>' } }));
    watcher = watchGoal(directory, key, id);
    for (let attempt = 0; attempt < 50; attempt++) {
      const names = await readdir(directory);
      if (names.some((name) => name.startsWith(`${key}.${id}.ready.`) && name.endsWith(".json"))) break;
      await sleep(20);
    }
    assert.deepEqual(await processEvent("stop", { sessionId, stopReason: "end_turn", transcriptPath }, directory), {});
    const scheduledFiles = await readdir(directory);
    assert.ok(scheduledFiles.includes(`${key}.${id}.wake.json`));
    await processEvent("submitted", { sessionId, prompt: "What's the status?" }, directory);
    assert.equal(await watcher, undefined);
    const remainingFiles = await readdir(directory);
    assert.ok(!remainingFiles.some((name) => name.startsWith(`${key}.${id}.ready.`)));
  } finally {
    await processEvent("prompt", { sessionId, prompt: "/goalkeeper off" }, directory);
    await watcher;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Goalkeeper hands off two pending replies without blocking and stops on completion", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cocopi-goalkeeper-"));
  const sessionId = "goalkeeper-chat";
  const key = createHash("sha256").update(sessionId).digest("hex");
  const transcriptPath = path.join(directory, "events.jsonl");
  const stop = { sessionId, stopReason: "end_turn", transcriptPath };
  /** @type {ReturnType<typeof watchGoal> | undefined} */
  let timer;
  try {
    const start = await processEvent("prompt", { sessionId, prompt: "/goalkeeper test", transformedPrompt: "test" }, directory);
    assert.match(start.modifiedTransformedPrompt ?? "", /Active \/goalkeeper goal/u);
    const notification = '<system_notification>\nShell command "Tests" (shellId: 123) has completed successfully.\n</system_notification>';
    assert.match(start.modifiedTransformedPrompt ?? "", /maximum check-in delay: 300 seconds/u);
    const watcherNotification = notification.replace('"Tests"', '"Goalkeeper check-in"');
    assert.deepEqual(await processEvent("prompt", { sessionId, prompt: watcherNotification, transformedPrompt: watcherNotification }, directory), {});
    const other = notification.replace("123", "456");
    const resumed = await processEvent("prompt", { sessionId, prompt: other, transformedPrompt: other }, directory);
    assert.match(resumed.modifiedTransformedPrompt ?? "", /Active \/goalkeeper goal/u);
    const { id } = JSON.parse(await readFile(path.join(directory, `${key}.json`), "utf8"));
    await writeFile(transcriptPath, JSON.stringify({ type: "assistant.message", timestamp: new Date(Date.now() + 1000).toISOString(), data: { content: "<goal>pending</goal>" } }));
    const pendingReply = JSON.parse(await readFile(transcriptPath, "utf8"));
    const record = { timestamp: pendingReply.timestamp };
    await writeFile(transcriptPath, [
      { ...record, type: "hook.start", data: { hookType: "userPromptSubmitted", input: { prompt: watcherNotification } } },
      pendingReply
    ].map((event) => JSON.stringify(event)).join("\n"));
    assert.deepEqual(await processEvent("stop", stop, directory), {});
    await writeFile(transcriptPath, JSON.stringify({ ...record, type: "assistant.turn_start" }));
    assert.deepEqual(await processEvent("stop", stop, directory), {});
    await writeFile(transcriptPath, JSON.stringify(pendingReply));
    const recovery = await processEvent("stop", stop, directory);
    assert.equal(recovery.decision, "block");
    assert.match(recovery.reason ?? "", /no Goalkeeper watcher is armed/u);
    assert.deepEqual(await processEvent("prompt", { sessionId, prompt: recovery.reason, transformedPrompt: recovery.reason }, directory), {});
    assert.deepEqual(await processEvent("stop", { ...stop, stop_hook_active: true }, directory), {});
    await writeFile(path.join(directory, `${key}.${id}.ready.expired.json`), JSON.stringify({ expires: 0 }));
    let olderFollowUp = "";
    for (let round = 0; round < 3; round++) {
      await writeFile(transcriptPath, JSON.stringify({ id: `pending-${round}`, type: "assistant.message", timestamp: new Date(Date.now() + 1000).toISOString(), data: { content: "<goal>pending</goal>" } }));
      const previousFiles = await readdir(directory);
      let emitted = "";
      const watcher = watchGoal(directory, key, id, async (text) => {
        emitted = olderFollowUp = text;
        const names = await readdir(directory);
        assert.ok(!names.some((name) => name.startsWith(`${key}.${id}.sent.`) && !previousFiles.includes(name)));
      });
      try {
        let armed = false;
        for (let check = 0; check < 50 && !armed; check++) {
          const names = await readdir(directory);
          armed = names.some((name) => name.startsWith(`${key}.${id}.ready.`) && name.endsWith(".json") && !name.endsWith(".expired.json"));
          if (!armed) await sleep(20);
        }
        assert.ok(armed);
        assert.deepEqual(await processEvent("stop", stop, directory), {});
        if (round === 2) {
          const wake = JSON.parse(await readFile(path.join(directory, `${key}.${id}.wake.json`), "utf8"));
          await rm(path.join(directory, `${key}.${id}.ready.${wake.ticket}.json`), { force: true });
          const recoveryAfterExit = await processEvent("stop", stop, directory);
          assert.equal(recoveryAfterExit.decision, "block");
          await writeFile(transcriptPath, JSON.stringify({ id: "newer-reply", type: "assistant.message", timestamp: new Date(Date.now() + 1000).toISOString(), data: { content: "<goal>complete</goal>" } }));
          assert.equal(await watcher, undefined);
        } else {
          assert.match(await watcher ?? "", /Active \/goalkeeper goal/u);
          assert.deepEqual(await processEvent("stop", stop, directory), {});
          await writeFile(transcriptPath, [
            { ...record, type: "hook.start", data: { hookType: "userPromptSubmitted", input: { prompt: watcherNotification } } },
            { ...record, type: "tool.execution_complete", data: { result: { content: emitted, structuredContent: { shellId: "123" } } } },
            { ...pendingReply, id: `follow-up-${round}` }
          ].map((event) => JSON.stringify(event)).join("\n"));
          const nextRecovery = await processEvent("stop", stop, directory);
          assert.equal(nextRecovery.decision, "block");
        }
      } catch (error) {
        await processEvent("prompt", { sessionId, prompt: "/goalkeeper off" }, directory);
        await watcher;
        throw error;
      }
    }
    await writeFile(transcriptPath, JSON.stringify({ type: "assistant.message", timestamp: new Date(Date.now() + 1000).toISOString(), data: { content: '<goal wait="600" shell="123">Waiting for tests.</goal>' } }));
    assert.equal(await replyStatus(transcriptPath), 300);
    timer = watchGoal(directory, key, id);
    for (let attempt = 0; attempt < 50; attempt++) {
      const names = await readdir(directory);
      if (names.some((name) => name.startsWith(`${key}.${id}.ready.`) && name.endsWith(".json") && !name.endsWith(".expired.json"))) break;
      await sleep(20);
    }
    const before = Date.now();
    assert.deepEqual(await processEvent("stop", stop, directory), {});
    const scheduled = JSON.parse(await readFile(path.join(directory, `${key}.${id}.wake.json`), "utf8"));
    assert.ok(scheduled.due >= before + 300_000 && scheduled.due <= Date.now() + 300_000);
    await processEvent("prompt", { sessionId, prompt: other, transformedPrompt: other }, directory);
    assert.deepEqual(await processEvent("stop", stop, directory), {});
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, `${key}.${id}.wake.json`), "utf8")), scheduled);
    const remainingFilesBeforeCompletion = await readdir(directory);
    const replacement = watchGoal(directory, key, id);
    try {
      assert.deepEqual(await processEvent("submitted", { sessionId, prompt: notification }, directory), {});
      assert.deepEqual(await processEvent("stop", stop, directory), {});
      for (let attempt = 0; attempt < 50; attempt++) {
        const names = await readdir(directory);
        if (names.some((name) => name.startsWith(`${key}.${id}.ready.`) && !remainingFilesBeforeCompletion.includes(name))) break;
        await sleep(20);
      }
      await writeFile(transcriptPath, JSON.stringify({ type: "assistant.message", timestamp: new Date(Date.now() + 1000).toISOString(), data: { content: '<goal wait="1" shell="789">Waiting for the next task.</goal>' } }));
      assert.deepEqual(await processEvent("stop", stop, directory), {});
      const replacementReply = await readFile(transcriptPath, "utf8");
      const silentNotification = { ...record, type: "hook.start", data: { hookType: "userPromptSubmitted", input: { prompt: watcherNotification } } };
      for (const content of ["<goal>complete</goal>", "<goal>Please provide a sample.</goal>"]) {
        await writeFile(transcriptPath, [silentNotification,
          { ...record, type: "tool.execution_complete", data: { result: { content: olderFollowUp, structuredContent: { shellId: "123" } } } },
          { ...pendingReply, data: { content } }
        ].map((event) => JSON.stringify(event)).join("\n"));
        assert.deepEqual(await processEvent("stop", stop, directory), {});
      }
      await writeFile(transcriptPath, [replacementReply, ...[
        silentNotification,
        { ...record, type: "tool.execution_complete", data: { result: { content: olderFollowUp, structuredContent: { shellId: "123" } } } },
        { ...pendingReply, id: "late-wake", data: { content: "<goal>complete</goal>" } }
      ].map((event) => JSON.stringify(event))].join("\n"));
      assert.match(await replacement ?? "", /Check the existing background task now/u);
      assert.equal(await timer, undefined);
    } catch (error) {
      await processEvent("prompt", { sessionId, prompt: "/goalkeeper off" }, directory);
      await replacement;
      throw error;
    }
    const remainingFiles = await readdir(directory);
    assert.deepEqual(remainingFiles.filter((name) => name.startsWith(`${key}.${id}.ready.`)), [`${key}.${id}.ready.expired.json`]);
    await writeFile(transcriptPath, JSON.stringify({ type: "assistant.message", timestamp: new Date(Date.now() + 1000).toISOString(), data: { content: "<goal>complete</goal>" } }));
    assert.deepEqual(await processEvent("stop", stop, directory), {});
    assert.equal(await watchGoal(directory, key, id), undefined);

    await processEvent("prompt", { sessionId, prompt: "/goalkeeper new goal", transformedPrompt: "new goal" }, directory);
    await writeFile(transcriptPath, JSON.stringify({ type: "assistant.message", timestamp: new Date(0).toISOString(), data: { content: "<goal>complete</goal>" } }));
    const staleCompletion = await processEvent("stop", stop, directory);
    assert.deepEqual(staleCompletion, {});
    await writeFile(transcriptPath, [
      { type: "user.message", timestamp: new Date(Date.now() + 1000).toISOString(), data: { content: "Wait, why this approach?" } },
      { type: "user.message", data: { content: notification } },
      { type: "assistant.turn_start" },
      { type: "assistant.message", data: { content: "Still working.\n<goal>pending</goal>" } }
    ].map((event) => JSON.stringify({ timestamp: new Date(Date.now() + 1000).toISOString(), ...event })).join("\n"));
    assert.deepEqual(await processEvent("stop", stop, directory), {});
    const afterTakeover = await processEvent("prompt", { sessionId, prompt: notification, transformedPrompt: notification }, directory);
    assert.deepEqual(afterTakeover, {});
  } finally {
    await processEvent("prompt", { sessionId, prompt: "/goalkeeper off" }, directory);
    await timer;
    await rm(directory, { recursive: true, force: true });
  }
});
