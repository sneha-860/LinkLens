import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { HttpError } from "./errors.js";

export const SESSION_COOKIE = "linklens_session";

const digest = (s: string) => createHash("sha256").update(s).digest();
/** Constant-time string comparison (hashing first makes the lengths equal). */
export const safeEqual = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

/** The session cookie's value: derived from the key, so the key itself is never stored in it. */
export const sessionToken = (apiKey: string) =>
  createHmac("sha256", apiKey).update("linklens-session-v1").digest("base64url");

/** Cookies of a request (no dependency: name=value pairs separated by semicolons). */
export function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of (req.headers.cookie ?? "").split(";")) {
    const part = raw.trim();
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[name] = part.slice(i + 1).trim();
    }
  }
  return out;
}

/** How the request is authenticated, if at all. */
export function credential(req: Request, apiKey: string): "key" | "cookie" | null {
  const auth = req.headers.authorization;
  const bearer = auth?.startsWith("Bearer ") === true ? auth.slice(7).trim() : undefined;
  const header = req.headers["x-api-key"];
  const key = bearer ?? (typeof header === "string" ? header : undefined);
  if (key !== undefined && safeEqual(key, apiKey)) return "key";
  const cookie = cookies(req)[SESSION_COOKIE];
  if (cookie !== undefined && safeEqual(cookie, sessionToken(apiKey))) return "cookie";
  return null;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Requires the API key (`Authorization: Bearer <key>` or `X-API-Key`), or the session cookie
 * that POST /session sets for the dashboard (EventSource, downloads and report links cannot send
 * headers). The cookie is SameSite=Strict; a state-changing request with it must not come from
 * another site (Sec-Fetch-Site, when the browser sends it).
 */
export function requireAuth(apiKey: string): RequestHandler {
  return (req, res, next) => {
    const how = credential(req, apiKey);
    if (how === null) {
      res.set("WWW-Authenticate", 'Bearer realm="LinkLens"');
      return next(new HttpError(401, "unauthorized", "an API key is required"));
    }
    const site = req.headers["sec-fetch-site"];
    if (how === "cookie" && !SAFE_METHODS.has(req.method) && site === "cross-site") {
      return next(new HttpError(403, "forbidden", "cross-site request refused"));
    }
    next();
  };
}

/** Set the dashboard's session cookie (HttpOnly; Secure over HTTPS). */
export function setSessionCookie(req: Request, res: Response, apiKey: string): void {
  res.cookie(SESSION_COOKIE, sessionToken(apiKey), {
    httpOnly: true,
    sameSite: "strict",
    secure: req.secure,
    path: "/",
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "strict", path: "/" });
}
