export default class SseParseError extends Error {
  /**
   * @param {string} message
   * @param {ErrorOptions & { eventData?: string }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = "SseParseError";
    this.cause = options.cause;
    this.eventData = options.eventData;
  }
}
