import { MedusaError } from "@medusajs/framework/utils";
import { ApiException } from "@monei-js/node-sdk";

/** The SDK builds an `ApiException` only when the response has a body; a body-less error is a raw axios error. */
export function statusCodeOf(error: unknown): number | undefined {
  return error instanceof ApiException
    ? error.statusCode
    : (error as { response?: { status?: number } } | undefined)?.response?.status;
}

/**
 * MONEI answered 4xx: the request was not applied. Anything else (no answer, a
 * timeout, a 5xx, a body without status) may come after MONEI applied it.
 */
export function isClientError(error: unknown): boolean {
  const statusCode = statusCodeOf(error);
  return statusCode !== undefined && statusCode >= 400 && statusCode < 500;
}

export function isNotFound(error: unknown): boolean {
  return statusCodeOf(error) === 404;
}

/**
 * MONEI SDK error to `MedusaError`: 4xx is `INVALID_DATA`, 5xx and network
 * errors are `UNEXPECTED_STATE`. Refund and capture never take a 5xx as a clean
 * failure: MONEI can answer 5xx after it applied the request (`monei-base.ts`).
 */
export function toMedusaError(error: unknown, action: string): MedusaError {
  if (error instanceof MedusaError) return error;

  const message = error instanceof Error ? error.message : String(error);
  const statusCode = statusCodeOf(error);
  const requestId = error instanceof ApiException ? error.requestId : undefined;

  const details = [
    statusCode !== undefined && `statusCode: ${statusCode}`,
    requestId && `requestId: ${requestId}`,
  ].filter(Boolean);
  const type = isClientError(error)
    ? MedusaError.Types.INVALID_DATA
    : MedusaError.Types.UNEXPECTED_STATE;

  return new MedusaError(
    type,
    `MONEI ${action} failed: ${message}${details.length ? ` (${details.join(", ")})` : ""}`,
  );
}

export async function callMonei<T>(action: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toMedusaError(error, action);
  }
}
