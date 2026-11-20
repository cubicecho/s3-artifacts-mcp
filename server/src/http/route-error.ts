import type { Response } from 'express';
import type { ErrorCode } from '../core/errors.ts';
import type { HttpStatus } from '../core/wire.ts';

// How the REST routes under /api refuse: an HTTP status for the browser, and the same `ErrorCode`
// vocabulary GraphQL answers with, so the client reads one set of codes everywhere.

/** One of the statuses in `HttpStatus`. */
type Status = (typeof HttpStatus)[keyof typeof HttpStatus];

/** What a refused request answers with, as JSON. */
export interface RouteErrorBody {
  error: {
    code: ErrorCode;
    message: string;
  };
}

/** A refusal a route handler throws, for `sendRouteError` to answer. */
export class RouteError extends Error {
  /** The HTTP status to answer with. */
  readonly status: Status;
  /** The code the client branches on. */
  readonly code: ErrorCode;

  /**
   * @param status - The HTTP status.
   * @param code - The client's code.
   * @param message - What went wrong, in words a person can read.
   */
  constructor(status: Status, code: ErrorCode, message: string) {
    super(message);
    this.name = 'RouteError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Answers a refusal, unless an answer has already started or the client has gone.
 *
 * @param res - The response.
 * @param error - The refusal.
 * @param [headers] - Headers to add, such as `Connection: close` after a body that was not read to its end.
 */
export function sendRouteError(res: Response, error: RouteError, headers: Record<string, string> = {}): void {
  const isAnswerable = res.headersSent === false && res.destroyed === false;
  if (isAnswerable === false) {
    return;
  }
  const body: RouteErrorBody = { error: { code: error.code, message: error.message } };
  res.status(error.status).set(headers).json(body);
}
