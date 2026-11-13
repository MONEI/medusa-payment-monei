/** The error's message, or `fallback` when it has none. */
export const messageOf = (error: unknown, fallback = String(error)) =>
  (error as { message?: string } | null | undefined)?.message || fallback
