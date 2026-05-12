import test from "node:test";
import assert from "node:assert/strict";

import { VSCODE_CANCELLATION_MESSAGE, abortIfCancellationRequested, abortSignalFromCancellationToken } from "../lib/vscode/cancellation.js";

test("abortSignalFromCancellationToken starts aborted for cancelled tokens", () => {
  const registration = abortSignalFromCancellationToken(fakeCancellationToken({ cancelled: true }));

  assert.equal(registration.signal.aborted, true);
  assert.equal(registration.signal.reason.message, VSCODE_CANCELLATION_MESSAGE);
  assert.equal(registration.cancellationSource, "initial");
});

test("abortSignalFromCancellationToken aborts when VS Code cancels", () => {
  const token = fakeCancellationToken();
  const registration = abortSignalFromCancellationToken(token);

  token.cancel();

  assert.equal(registration.signal.aborted, true);
  assert.equal(registration.signal.reason.message, VSCODE_CANCELLATION_MESSAGE);
  assert.equal(registration.cancellationSource, "event");
  assert.equal(token.listenerCount(), 0);
});

test("abortSignalFromCancellationToken dispose unregisters cancellation listener", () => {
  const token = fakeCancellationToken();
  const registration = abortSignalFromCancellationToken(token);

  registration.dispose();
  token.cancel();

  assert.equal(registration.signal.aborted, false);
  assert.equal(token.listenerCount(), 0);
});

test("abortIfCancellationRequested aborts when the token flag is set without an event", () => {
  const token = fakeCancellationToken();
  const registration = abortSignalFromCancellationToken(token);
  token.isCancellationRequested = true;

  assert.equal(abortIfCancellationRequested(registration, token), true);
  assert.equal(registration.signal.reason.message, VSCODE_CANCELLATION_MESSAGE);
  assert.equal(registration.cancellationSource, "poll");
});

/**
 * @param {{ cancelled?: boolean }} [options]
 */
function fakeCancellationToken(options = {}) {
  /** @type {Set<() => void>} */
  const listeners = new Set();
  return {
    isCancellationRequested: options.cancelled === true,
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
    },
    listenerCount() {
      return listeners.size;
    }
  };
}
