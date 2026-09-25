import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError } from "zod";
import { prominence } from "@linklens/core";
import type { Logger } from "./pipeline.js";

/** An error with an HTTP status and a stable machine-readable code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, "not_found", `${what} not found`);
export const notReady = (what: string) =>
  new HttpError(409, "not_ready", `${what} is not available yet: the pipeline has not reached it`);

/** Express 4 does not catch rejected promises: route them to the error handler. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

/** Every error becomes `{ error: { code, message, details? } }` with a fitting status. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, _req, res, _next) => {
    const send = (status: number, code: string, message: string, details?: unknown) =>
      res
        .status(status)
        .json({ error: { code, message, ...(details === undefined ? {} : { details }) } });
    if (err instanceof HttpError) return send(err.status, err.code, err.message, err.details);
    if (err instanceof ZodError) {
      return send(
        400,
        "validation_error",
        "the request is invalid",
        err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      );
    }
    if (err instanceof prominence.CsvError)
      return send(400, "invalid_csv", err.message, err.problems);
    const e = err as { type?: string; status?: number; message?: string };
    if (e.type === "entity.parse.failed")
      return send(400, "invalid_json", "the body is not valid JSON");
    if (e.type === "entity.too.large") return send(413, "too_large", "the body is too large");
    if (err instanceof RangeError) return send(400, "invalid_config", err.message);
    logger.error(`unhandled: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return send(500, "internal", "internal server error");
  };
}
