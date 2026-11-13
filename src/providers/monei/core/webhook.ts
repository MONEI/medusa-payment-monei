import type { Monei } from "@monei-js/node-sdk";

/** The `MONEI-Signature` header in any case; only a single string value is accepted. */
function signatureHeader(headers: Record<string, unknown> | undefined): string | undefined {
  const entry = Object.entries(headers ?? {}).find(
    ([name]) => name.toLowerCase() === "monei-signature",
  );
  return typeof entry?.[1] === "string" ? entry[1] : undefined;
}

/** The raw callback body as text; a JSON-serialized Buffer (`{type:"Buffer",data}`) is rebuilt. */
function rawBody(rawData: unknown): string | undefined {
  if (typeof rawData === "string") return rawData;
  if (Buffer.isBuffer(rawData)) return rawData.toString("utf8");
  const serialized = rawData as { type?: unknown; data?: unknown } | null | undefined;
  if (serialized?.type === "Buffer" && Array.isArray(serialized.data)) {
    return Buffer.from(serialized.data as number[]).toString("utf8");
  }
  return undefined;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * The payment id a signed body points to. The body is either the payment itself (the
 * per-payment `callbackUrl`) or an account-webhook event `{id, type, objectType,
 * objectId, object}`, whose own `id` is the event id and must never be fetched.
 */
function paymentIdOf(body: unknown): { paymentId: string } | { refused: string } {
  if (!isObject(body)) return { refused: "signed body is not a JSON object" };
  if ("objectType" in body) {
    if (body.objectType !== "charge") {
      return { refused: `event for objectType ${String(body.objectType)} is not a payment` };
    }
    const { objectId, object } = body;
    if (typeof objectId !== "string" || !objectId) {
      return { refused: "charge event has no objectId" };
    }
    if (!isObject(object) || object.id !== objectId) {
      return { refused: "charge event object id does not match objectId" };
    }
    return { paymentId: objectId };
  }
  const { id } = body;
  if (typeof id !== "string" || !id) return { refused: "signed body has no payment id" };
  return { paymentId: id };
}

/**
 * The payment id from a callback whose `MONEI-Signature` matches the raw body, or
 * the reason it was refused. The parsed body Medusa passes is never read.
 */
export function verifyWebhook(
  client: Monei,
  { rawData, headers }: { rawData?: unknown; headers?: Record<string, unknown> },
): { paymentId: string } | { refused: string } {
  const signature = signatureHeader(headers);
  if (!signature) return { refused: "missing or malformed MONEI-Signature header" };
  const body = rawBody(rawData);
  if (!body) return { refused: "raw body is missing or not a string or Buffer" };
  let signed: unknown;
  try {
    signed = client.verifySignature(body, signature);
  } catch {
    return { refused: "signature verification failed" };
  }
  return paymentIdOf(signed);
}
