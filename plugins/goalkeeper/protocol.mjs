import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { goalkeeperDirectory, readGoalkeeperSettings } from "./settings.mjs";

const { join } = path;
const WATCHER_NOTIFICATION = /^<system_notification>\r?\nShell command "Goalkeeper check-in" \(shellId: (\d+)\) has completed[^\r\n]*\r?\n<\/system_notification>$/u;
const FOLLOW_UP = "[Cocopi Goalkeeper follow-up]";
const RECOVERY = "[Cocopi Goalkeeper recovery]";

/** @param {string} prompt */
function hostNotification(prompt) {
  return /^<system_notification>\r?\n[\s\S]+\r?\n<\/system_notification>$/u.test(prompt);
}

/** @param {string} prompt */
function delegatedGoal(prompt) {
  const slash = /^\/(?:VS Code Synced Data:|goalkeeper:)?goalkeeper[ \t]+([\s\S]+)$/u.exec(prompt);
  const expanded = /^The user explicitly invoked the "\/(?:VS Code Synced Data:|goalkeeper:)?goalkeeper" skill\.[^\r\n]*\r?\n\s*<skill-context name="goalkeeper">[\s\S]*?\r?\n\r?\nARGUMENTS:[ \t]*([\s\S]+?)\r?\n<\/skill-context>(?:\s|$)/u.exec(prompt);
  return (slash?.[1] ?? expanded?.[1])?.trim();
}

/** @param {string | undefined} transcriptPath
 * @param {number} [delegatedAt]
 * @param {boolean} [details]
 * @param {{replyId: string, ticket: string}} [wake] */
export async function replyStatus(transcriptPath, delegatedAt, details = false, wake) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return;
  /** @type {string | undefined} */
  let reply;
  /** @type {string | undefined} */
  let replyId;
  let lineNumber = 0;
  let dismissed = false;
  /** @type {string | undefined} */
  let watcherShell;
  /** @type {string | undefined} */
  let watcherTicket;
  let priorReply;
  let priorReplyId;
  let priorWatcherTicket;
  // The scheduling reply may itself have come from a previous, valid watcher.
  const ignoreWatcherTurn = () => Boolean(wake && watcherShell &&
    (!watcherTicket || (replyId !== wake.replyId && watcherTicket !== wake.ticket)));
  /** @param {string | undefined} shell */
  const beginPrompt = (shell) => {
    if (!ignoreWatcherTurn()) {
      priorReply = reply;
      priorReplyId = replyId;
      priorWatcherTicket = watcherTicket;
    }
    watcherShell = shell;
    watcherTicket = undefined;
    reply = replyId = undefined;
  };
  const lines = createInterface({ input: createReadStream(transcriptPath), crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    lineNumber++;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.agentId || event.data?.parentToolCallId) continue;
    if (delegatedAt !== undefined && !(Date.parse(event.timestamp) > delegatedAt)) continue;
    if (event.type === "hook.start" && event.data?.hookType === "userPromptSubmitted") {
      beginPrompt(WATCHER_NOTIFICATION.exec(event.data.input?.prompt ?? "")?.[1]);
    }
    if (event.type === "tool.execution_complete" && watcherShell && event.data?.result?.structuredContent?.shellId === watcherShell) {
      const content = typeof event.data.result.content === "string" ? event.data.result.content.trimStart() : "";
      if (content.startsWith(`${FOLLOW_UP} `)) {
        const ticket = content.slice(FOLLOW_UP.length + 1).split(/\r?\n/u, 1)[0];
        if (/^[a-f0-9-]{36}$/u.test(ticket)) watcherTicket = ticket;
      }
    }
    if (event.type === "user.message") {
      const content = typeof event.data?.content === "string" ? event.data.content.trim() : "";
      if (content) {
        const shell = WATCHER_NOTIFICATION.exec(content)?.[1];
        if (shell !== watcherShell) beginPrompt(shell);
      }
      if (content && !hostNotification(content) && !content.startsWith(`${RECOVERY}\n`)) {
        const goal = delegatedGoal(content);
        if (!goal || goal.toLowerCase() === "off") dismissed = true;
      }
      reply = replyId = undefined;
    }
    if (event.type === "assistant.turn_start") reply = replyId = undefined;
    if (event.type === "assistant.message") {
      reply = event.data?.toolRequests?.length ? undefined : event.data?.content;
      replyId = typeof reply === "string" ? event.id || `${lineNumber}:${event.timestamp}` : undefined;
    }
  }
  if (dismissed) return "dismissed";
  if (ignoreWatcherTurn()) {
    reply = priorReply;
    replyId = priorReplyId;
    watcherTicket = priorWatcherTicket;
  } else if (watcherShell && !watcherTicket) return "silent-wake";
  const pending = details ? { replyId, seconds: undefined, shellId: undefined, watcherTicket } : undefined;
  if (typeof reply !== "string") return pending;
  const parts = reply.trimEnd().split(/\r?\n/u);
  const opening = parts.findLastIndex((line) => /^<goal(?:>| wait=")/u.test(line));
  if (opening === -1) return pending;
  const marker = /^<goal(?: wait="(\d+)"(?: shell="(\d+)")?)?>([^<>]*?)<\/goal>$/su.exec(parts.splice(opening).join("\n"));
  const body = marker?.[3]?.trim();
  if (!body) return pending;
  let fence;
  for (const line of parts) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (!match) continue;
    if (!fence) fence = match[1];
    else if (match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = undefined;
  }
  if (fence) return pending;
  if (marker?.[1]) {
    const seconds = Math.min(300, Math.max(1, Number(marker[1])));
    return details ? { seconds, shellId: marker[2], replyId, watcherTicket } : seconds;
  }
  if (body === "pending" && details) return pending;
  const outcome = body === "complete" || body === "pending" ? body : "need-user";
  return details ? { ...pending, outcome } : outcome;
}

/** @param {string} path */
async function read(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error)) throw error;
    if (error.code !== "ENOENT") throw error;
    return;
  }
}

/** @param {string} path
 * @param {object} value */
async function save(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, path);
        break;
      } catch (error) {
        if (attempt >= 4 || !(error instanceof Error) || !("code" in error) || !["EPERM", "EBUSY"].includes(String(error.code))) throw error;
        await sleep(20);
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

/** @param {{pid?: number} | undefined} claim */
function liveClaim(claim) {
  if (typeof claim?.pid !== "number" || !Number.isInteger(claim.pid) || claim.pid <= 0) return false;
  try {
    return process.kill(claim.pid, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

/** @param {string} directory
 * @param {string} base
 * @param {number} [scheduledExpiry] */
async function readyWatcher(directory, base, scheduledExpiry = 0) {
  const prefix = `${path.basename(base)}.ready.`;
  const names = await readdir(directory);
  for (const name of names.toSorted()) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const claim = await read(join(directory, name));
    if (claim?.expires > Math.max(Date.now(), scheduledExpiry) && liveClaim(claim)) return claim;
  }
}

/** @param {{goal: string}} state
 * @param {string} directory */
async function instructions(state, directory) {
  const settings = await readGoalkeeperSettings(directory);
  return [settings.prependInstructions,
    `Active /goalkeeper goal (user request): ${JSON.stringify(state.goal)}`,
    "Keep working toward the goal. End your reply with one standalone <goal> block, without quotes, backticks, or code fences: <goal>complete</goal> after explaining what you verified; <goal>pending</goal> if work remains; or a final <goal>…</goal> block containing your request only if you cannot make meaningful progress without the user. Inside that block explain what you tried, exactly what you need and why, and any authorization scope and consequences.",
    settings.appendInstructions].filter(Boolean).join("\n\n");
}

/** @param {string} action
 * @param {{sessionId?: string, agentId?: string, prompt?: string, transformedPrompt?: string, stopReason?: string, stop_hook_active?: boolean, transcriptPath?: string}} event
 * @param {string} directory */
export async function processEvent(action, event, directory) {
  if (typeof event?.sessionId !== "string" || !event.sessionId || event.agentId) return {};
  const key = createHash("sha256").update(event.sessionId).digest("hex");
  const path = join(directory, `${key}.json`);
  const prompt = (action === "prompt" || action === "submitted") && typeof event.prompt === "string" ? event.prompt.trim() : "";
  if (prompt.startsWith(`${RECOVERY}\n`)) return {};
  const goal = delegatedGoal(prompt);
  const shellCompletion = /^<system_notification>\r?\nShell command [^\r\n]+ \(shellId: (\d+)\) has completed[^\r\n]*\r?\n<\/system_notification>$/u.exec(prompt);
  // The watcher output, not its shell exit notification, authorizes continuation.
  if (WATCHER_NOTIFICATION.test(prompt)) return {};
  const oversized = Boolean(goal && goal.length > 8000);
  if (oversized || goal?.toLowerCase() === "off" || (prompt && !goal && !hostNotification(prompt))) {
    const previous = await read(path);
    if (action === "submitted") {
      if (previous) await save(join(directory, `${key}.${previous.id}.terminal.json`), { status: "dismissed" });
      return {};
    }
    await rm(path, { force: true });
    if (oversized && typeof event.transformedPrompt === "string") {
      return { modifiedTransformedPrompt: `${event.transformedPrompt}\n\nCocopi Goalkeeper rejected this delegation: the goal exceeds 8,000 characters. Do not continue a previous goal or launch a watcher. Tell the user to submit a shorter goal.` };
    }
    if (previous && typeof event.transformedPrompt === "string") {
      return { modifiedTransformedPrompt: `${event.transformedPrompt}\n\nCocopi Goalkeeper delegation has ended. Do not launch a Goalkeeper watcher or emit a <goal> marker. Only the user can start a new delegation with /goalkeeper.` };
    }
    return {};
  }
  if (action === "submitted" && !shellCompletion) return {};
  if (goal) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await save(path, { id: randomUUID(), goal, delegatedAt: Date.now() });
  }
  const state = await read(path);
  if (!state) return {};
  const base = join(directory, `${key}.${state.id}`);
  if (shellCompletion) {
    const completionPath = `${base}.shell-${shellCompletion[1]}.done.json`;
    if (!await read(completionPath)) await save(completionPath, { completed: true });
  }
  if (action === "submitted") return {};
  const terminalPath = join(directory, `${key}.${state.id}.terminal.json`);
  if (await read(terminalPath)) return {};
  const pausePath = join(directory, `${key}.${state.id}.pause.json`);
  if (action === "prompt" && typeof event.transformedPrompt === "string") {
    if (await read(pausePath)) return {};
    return { modifiedTransformedPrompt: `${event.transformedPrompt}\n\n${await instructions(state, directory)}\n\n${watchInstructions(key, state.id)}` };
  }
  if (action === "stop" && event.stopReason === "end_turn" && !await read(pausePath)) {
    const status = await replyStatus(event.transcriptPath, state.delegatedAt, true);
    if (status === "dismissed") {
      await save(terminalPath, { status });
      return {};
    }
    if (typeof status !== "object" || !status.replyId) return {};
    const { replyId, watcherTicket } = status;
    const wakePath = `${base}.wake.json`;
    const scheduled = await read(wakePath);
    if (watcherTicket && (scheduled?.ticket !== watcherTicket || !await read(`${base}.sent.${watcherTicket}.json`))) return {};
    if ("outcome" in status && status.outcome === "complete") {
      await save(terminalPath, { status: "complete" });
      return {};
    }
    if ("outcome" in status && status.outcome === "need-user") {
      await save(pausePath, { waiting: true });
      return {};
    }
    const waiting = status.seconds ? status : undefined;
    if (waiting?.shellId && await read(`${base}.shell-${waiting.shellId}.done.json`)) return {};
    if (scheduled?.replyId === replyId && (await read(`${base}.sent.${scheduled.ticket}.json`) || liveClaim(await read(`${base}.ready.${scheduled.ticket}.json`)))) return {};
    const ready = await readyWatcher(directory, base, scheduled?.claimExpiry);
    if (ready) {
      await save(wakePath, { ticket: ready.ticket, claimExpiry: ready.expires, due: Date.now() + (waiting ? waiting.seconds * 1000 : 1500), checkIn: Boolean(waiting), replyId, shellId: waiting?.shellId, transcriptPath: event.transcriptPath });
    } else if (!event.stop_hook_active) {
      return {
        decision: "block",
        reason: `${RECOVERY}\n\nThe goal is still pending, but no Goalkeeper watcher is armed. If work remains, arm the watcher before ending this reply. If it cannot start, explicitly tell the user automatic follow-up is unavailable.\n\n${await instructions(state, directory)}\n\n${watchInstructions(key, state.id)}`
      };
    }
  }
  return {};
}

/** @param {string} key
 * @param {string} id */
function watchInstructions(key, id) {
  return `If waiting on a specific background task, end with <goal wait="120" shell="123">Describe the task and why you are waiting.</goal>, using the actual shell ID (omit shell if unknown) and your ETA in seconds (maximum check-in delay: 300 seconds). For pending or waiting, launch the watcher below with the host's asynchronous shell tool (not detached), using the description Goalkeeper check-in, then finish your reply. Do not wait for the watcher. If a task completes first, read its result. On a Goalkeeper check-in notification, read that shell result and continue only if it contains Goalkeeper follow-up instructions. At a timed check-in, inspect the existing task rather than restarting it. If you cannot launch it, tell the user. Do not arm it when completing or requesting user input.\nScript path (quote for your shell): ${fileURLToPath(import.meta.url)}\nArguments: watch ${key} ${id}`;
}

/** @param {string} directory
 * @param {string | undefined} key
 * @param {string | undefined} id
 * @param {(text: string) => Promise<void>} [emit] */
export async function watchGoal(directory, key, id, emit) {
  if (!key || !id || !/^[a-f0-9]{64}$/u.test(key) || !/^[a-f0-9-]{36}$/u.test(id)) return;
  const base = join(directory, `${key}.${id}`);
  const active = async () => {
    const state = await read(join(directory, `${key}.json`));
    return state?.id === id && !await read(`${base}.terminal.json`) && !await read(`${base}.pause.json`);
  };
  if (!await active()) return;
  const wakePath = `${base}.wake.json`;
  const scheduled = await read(wakePath);
  if (await readyWatcher(directory, base, scheduled?.claimExpiry)) return;
  const ticket = randomUUID();
  // Leave time for the agent to finish its reply before the 25-second Stop hook starts.
  const expires = Math.max(Date.now() + 90_000, (scheduled?.claimExpiry ?? 0) + 1);
  const readyPath = `${base}.ready.${ticket}.json`;
  await save(readyPath, { ticket, expires, pid: process.pid });
  try {
    while (await active()) {
      const wake = await read(wakePath);
      if (wake?.ticket === ticket) {
        if (wake.shellId && await read(`${base}.shell-${wake.shellId}.done.json`)) return;
        if (Date.now() >= wake.due) {
          const state = await read(join(directory, `${key}.json`));
          if (state?.id !== id) return;
          const followUp = `${await instructions(state, directory)}\n\n${wake.checkIn ? "Check the existing background task now. If it is still running, report a new ETA; do not restart it.\n\n" : ""}${watchInstructions(key, id)}`;
          if (!wake.replyId) return;
          const status = await replyStatus(wake.transcriptPath, state.delegatedAt, true, { replyId: wake.replyId, ticket });
          if (status === "dismissed") {
            await save(`${base}.terminal.json`, { status: "dismissed" });
            return;
          }
          if (typeof status !== "object" || status.replyId !== wake.replyId || "outcome" in status) return;
          if (!await active()) return;
          const latestWake = await read(wakePath);
          if (latestWake?.ticket !== ticket || (latestWake.shellId && await read(`${base}.shell-${latestWake.shellId}.done.json`))) return;
          if (emit) {
            await emit(`${FOLLOW_UP} ${ticket}\n${followUp}`);
            await save(`${base}.sent.${ticket}.json`, { sent: true });
          }
          return followUp;
        }
      } else if (expires <= (wake?.claimExpiry ?? 0) || Date.now() >= expires) return;
      await sleep(100);
    }
  } finally {
    await rm(readyPath, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === "watch") {
      await watchGoal(goalkeeperDirectory(), process.argv[3], process.argv[4], (text) => new Promise((resolve, reject) => {
        process.stdout.write(`${text}\n`, (error) => error ? reject(error) : resolve());
      }));
    } else {
      process.stdin.setEncoding("utf8");
      let input = "";
      for await (const chunk of process.stdin) input += chunk;
      process.stdout.write(JSON.stringify(await processEvent(process.argv[2], JSON.parse(input), goalkeeperDirectory())));
    }
  } catch {
    process.stderr.write("Cocopi goalkeeper hook failed; automatic continuation was not enforced.\n");
    process.exitCode = 1;
  }
}
