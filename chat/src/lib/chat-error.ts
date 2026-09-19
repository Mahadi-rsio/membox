export type DetailedError = {
  message: string;
  status?: number;
  detail?: string;
};

/**
 * Parse the error object surfaced by `useChat`. The SDK wraps non-2xx
 * responses so that `error.message` holds the raw response body (which the
 * gateway returns as `{ error, status, detail }`). We extract those fields to
 * show the user exactly what went wrong instead of a generic message.
 */
export function parseChatError(err: unknown): DetailedError {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const fallback: DetailedError = { message: raw || "Something went wrong." };

  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return {
        message:
          typeof parsed.error === "string"
            ? parsed.error
            : typeof parsed.message === "string"
              ? parsed.message
              : fallback.message,
        status: typeof parsed.status === "number" ? parsed.status : undefined,
        detail:
          typeof parsed.detail === "string" && parsed.detail.length > 0
            ? parsed.detail
            : undefined,
      };
    }
  } catch {
    /* not JSON — keep raw message */
  }

  return fallback;
}
