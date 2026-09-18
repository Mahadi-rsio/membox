import type { Request, Response } from "../http.js";
import { userIdForApiKey } from "../auth/identity.js";

export interface AuthUser {
  userId: string;
  apiKey: string;
}

/** Type guard: returns true when `result` is a resolved AuthUser, false when it's a 401 Response. */
export function isAuthUser(result: AuthUser | Response): result is AuthUser {
  return typeof (result as AuthUser).userId === "string";
}

function unauthorized(res: Response): Response {
  return res.status(401).json({
    error: {
      message: "Unauthorized: valid API key required",
      type: "invalid_request_error",
      code: "invalid_api_key",
    },
  });
}

/**
 * Authenticate a request via the `Authorization: Bearer <key>` header.
 *
 * Returns the resolved user identity, or a 401 Response when the header is
 * missing, the token is not a Bearer token, or the key is not a valid one.
 */
export function checkAuth(req: Request, res: Response): AuthUser | Response {
  const authHeader = req.header("authorization") || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return unauthorized(res);
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return unauthorized(res);
  }

  const userId = userIdForApiKey(token);
  if (!userId) {
    return unauthorized(res);
  }

  return { userId, apiKey: token };
}
