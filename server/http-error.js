/**
 * CommuteIQ — HTTP error type.
 *
 * Lives in its own module so `server/api/*.js` handlers can throw it without
 * importing `server/index.js`, which imports them (a cycle).
 */

/** An error that carries the HTTP status the client should receive. */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {object} [extra] merged into the JSON error response
   */
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (msg, extra) => new HttpError(400, msg, extra);
export const notFound = (msg, extra) => new HttpError(404, msg, extra);
export const conflict = (msg, extra) => new HttpError(409, msg, extra);
export const unprocessable = (msg, extra) => new HttpError(422, msg, extra);
