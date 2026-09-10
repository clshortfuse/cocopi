import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, lstatSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexWorkerError, WORKER_LIMITS } from "./worker-protocol.js";

// A crashed parent cannot acknowledge cleanup. Never touch another running
// extension host, symlinks, recent files, or generic temporary directories.
export function cleanStaleWorkerStorage() {
  for (const name of readdirSync(tmpdir())) {
    const match = /^cocopi-transport-v1-(\d+)-[\dA-Za-z]{6}$/u.exec(name);
    if (!match) {
      continue;
    }
    try {
      const directory = path.join(tmpdir(), name);
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || Date.now() - stat.mtimeMs < 86_400_000) {
        continue;
      }
      try {
        process.kill(Number(match[1]), 0);
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === "ESRCH") {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    } catch {
      // Conservative startup cleanup is best effort, not disk repair.
    }
  }
}

/**
 * Worker-only storage. Synchronous bounded record IO avoids an unbounded queue
 * of pending filesystem writes. Never used for uploads or credentials.
 */
export class WorkerDeliveryBuffer {
  /** @param {{ memoryBytes?: number, diskBytes?: number, eventBytes?: number, records?: number, directory?: string }} [options] */
  constructor(options = {}) {
    this.limits = { ...WORKER_LIMITS, ...options };
    this.key = randomBytes(32);
    /** @type {{ data?: string, offset?: number, bytes: number }[]} */
    this.queue = [];
    this.memoryBytes = 0;
    this.diskBytes = 0;
    this.memoryHighWater = 0;
    this.diskHighWater = 0;
    /** @type {string | undefined} */
    this.directory = undefined;
    /** @type {number | undefined} */
    this.fd = undefined;
  }

  /** @param {import("./worker-protocol.js").DeliveryRecord} record */
  push(record) {
    const data = JSON.stringify(record);
    const bytes = Buffer.byteLength(data);
    if (bytes > this.limits.eventBytes || this.queue.length >= this.limits.records) {
      throw new CodexWorkerError("Codex worker buffer-storage failure: event or record budget exceeded.");
    }
    if (this.fd === undefined && this.memoryBytes + bytes <= this.limits.memoryBytes) {
      this.queue.push({ data, bytes });
      this.memoryBytes += bytes;
      this.memoryHighWater = Math.max(this.memoryHighWater, this.memoryBytes);
      return;
    }
    const storageBytes = bytes + 28; // 12-byte nonce and 16-byte authentication tag.
    if (this.diskBytes + storageBytes > this.limits.diskBytes) {
      throw new CodexWorkerError("Codex worker buffer-storage failure: disk budget exceeded.");
    }
    try {
      if (this.fd === undefined) {
        this.directory = mkdtempSync(path.join(this.limits.directory ?? tmpdir(), `cocopi-transport-${process.pid}-`));
        this.fd = openSync(path.join(this.directory, "events"), "wx+", 0o600);
      }
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
      const encrypted = Buffer.concat([cipher.update(data, "utf8"), cipher.final()]);
      const buffer = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
      let written = 0;
      while (written < storageBytes) {
        const count = writeSync(this.fd, buffer, written, storageBytes - written, this.diskBytes + written);
        if (count === 0) {
          throw new Error("Short write");
        }
        written += count;
      }
      this.queue.push({ offset: this.diskBytes, bytes: storageBytes });
      this.diskBytes += storageBytes;
      this.diskHighWater = Math.max(this.diskHighWater, this.diskBytes);
    } catch {
      throw new CodexWorkerError("Codex worker buffer-storage failure: cannot write private response storage.");
    }
  }

  shift() {
    const entry = this.queue.shift();
    if (!entry) {
      return;
    }
    if (entry.data !== undefined) {
      this.memoryBytes -= entry.bytes;
      return entry.data;
    }
    try {
      const buffer = Buffer.alloc(entry.bytes);
      let read = 0;
      while (read < entry.bytes) {
        const count = readSync(/** @type {number} */ (this.fd), buffer, read, entry.bytes - read, /** @type {number} */ (entry.offset) + read);
        if (count === 0) {
          throw new Error("Short read");
        }
        read += count;
      }
      const decipher = createDecipheriv("aes-256-gcm", this.key, buffer.subarray(0, 12));
      decipher.setAuthTag(buffer.subarray(12, 28));
      return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString("utf8");
    } catch {
      throw new CodexWorkerError("Codex worker buffer-storage failure: cannot read private response storage.");
    }
  }

  dispose() {
    this.queue.length = 0;
    this.memoryBytes = 0;
    this.key.fill(0);
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }
    if (this.directory) {
      rmSync(this.directory, { recursive: true, force: true });
      this.directory = undefined;
    }
  }
}