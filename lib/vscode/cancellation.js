export const VSCODE_CANCELLATION_MESSAGE = "VS Code request was cancelled.";

/**
 * @typedef {object} CancellationTokenLike
 * @property {boolean} isCancellationRequested
 * @property {(listener: () => void) => { dispose(): void }} onCancellationRequested
 */

/**
 * @typedef {object} AbortSignalRegistration
 * @property {AbortSignal} signal
 * @property {AbortController} controller
 * @property {"initial" | "event" | "poll" | undefined} cancellationSource
 * @property {() => void} dispose
 */

/**
 * @param {CancellationTokenLike} token
 * @returns {AbortSignalRegistration}
 */
export function abortSignalFromCancellationToken(token) {
  const controller = new AbortController();
  /** @type {AbortSignalRegistration} */
  const registration = {
    signal: controller.signal,
    controller,
    cancellationSource: undefined,
    dispose() {}
  };
  if (token.isCancellationRequested) {
    registration.cancellationSource = "initial";
    controller.abort(new Error(VSCODE_CANCELLATION_MESSAGE));
    return registration;
  }

  const subscription = token.onCancellationRequested(() => {
    registration.cancellationSource = "event";
    controller.abort(new Error(VSCODE_CANCELLATION_MESSAGE));
    subscription.dispose();
  });

  registration.dispose = () => {
      subscription.dispose();
  };
  return registration;
}

/**
 * Handles cancellation tokens whose event did not fire but whose requested flag
 * has flipped by the time stream work resumes.
 *
 * @param {AbortSignalRegistration} registration
 * @param {CancellationTokenLike} token
 */
export function abortIfCancellationRequested(registration, token) {
  if (token.isCancellationRequested && !registration.signal.aborted) {
    registration.cancellationSource = "poll";
    registration.controller.abort(new Error(VSCODE_CANCELLATION_MESSAGE));
  }

  return registration.signal.aborted;
}

/**
 * @param {"initial" | "event" | "poll" | undefined} source
 */
export function vscodeCancellationSourceLabel(source) {
  if (source === "initial") return "already requested";
  if (source === "poll") return "token flag observed";
  return "event received";
}
