import type { Request, Response, NextFunction } from "express";
import type { Env } from "./env";

/**
 * Express types used across the gateway routes. `Env` is attached to the app
 * (via `app.locals.env`) when the server boots, so any handler can read it.
 */
export type { Request, Response, NextFunction };

/**
 * Read the runtime `Env` from an Express request. The env object is stored on
 * `app.locals.env` (see `src/index.ts`). Falls back to an empty object when
 * the server was constructed without an env (e.g. in tests that build the app
 * directly).
 */
export function getEnv(req: Request): Env {
  const locals = (req.app as any).locals as { env?: Env };
  return locals?.env ?? ({} as Env);
}
