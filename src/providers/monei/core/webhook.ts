import { createHash } from "node:crypto";
import type { Logger } from "@medusajs/framework/types";
import type { Monei, Payment } from "@monei-js/node-sdk";
import { createMoneiClient } from "./client";
import type { Credentials } from "./credentials";
import { callMonei } from "./errors";
import { sessionIdOf } from "./ids";

const MINUTE = 60_000;
const PAYMENT_ID = /^[a-f0-9]{32,40}$/i;

export type WebhookSession = {
  provider_id?: string;
  data?: Record<string, unknown> | null;
  payment?: {
    data?: Record<string, unknown> | null;
    captured_at?: unknown;
    canceled_at?: unknown;
  } | null;
};

/** Medusa acts on the attached payment if it exists, or authorizes the session otherwise. */
export function settlementPaymentId(session: WebhookSession): unknown {
  return session.payment ? session.payment.data?.id : session.data?.id;
}

type WebhookContext = {
  client: () => Monei;
  logger: Logger;
  providerId: string;
  accountWebhookSigningSecret?: string;
  findSession: (id: string) => Promise<WebhookSession | undefined>;
};
type SignatureHeader = string | string[] | undefined;

type Delivery = { expiresAt: number; result: Promise<Payment | undefined> };
const deliveries = new Map<string, Delivery>();
let fallbackFetches: { at: number; sessionId: string }[] = [];

/** The `MONEI-Signature` header in any case. */
function signatureHeader(headers: Record<string, unknown> | undefined): SignatureHeader {
  const value = Object.entries(headers ?? {}).find(
    ([name]) => name.toLowerCase() === "monei-signature",
  )?.[1];
  if (typeof value === "string") return value;
  return Array.isArray(value) && value.every((part) => typeof part === "string")
    ? value
    : undefined;
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
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The payment id a signed body points to. The body is either the payment itself (the
 * per-payment `callbackUrl`) or an account-webhook event `{id, type, objectType,
 * objectId, object}`, whose own `id` is the event id and must never be fetched.
 */
function paymentIdOf(body: Record<string, unknown>): { paymentId: string } | { refused: string } {
  if ("objectType" in body) {
    if (body.objectType !== "charge") {
      return { refused: "event objectType is not charge" };
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
  if (typeof id !== "string" || !id) return { refused: "body has no payment id" };
  return { paymentId: id };
}

function signedBy(
  credentials: Credentials,
  { client, accountWebhookSigningSecret }: WebhookContext,
  raw: string,
  signature: SignatureHeader,
): { version: "v2" | "v1"; body: unknown } | undefined {
  if (typeof signature !== "string" || !signature) return undefined;
  if (credentials.source === "connected" && credentials.signingSecret) {
    try {
      return {
        version: "v2",
        body: client().verifySignature(raw, signature, credentials.signingSecret),
      };
    } catch {
      // A callback sent before the connect may still verify with the env key.
    }
  }
  if (accountWebhookSigningSecret) {
    try {
      const body = client().verifySignature(raw, signature, accountWebhookSigningSecret);
      if (isObject(body) && "objectType" in body) return { version: "v2", body };
    } catch {
      // The account webhook has its own secret.
    }
  }
  if (credentials.envKey) {
    const envClient =
      credentials.source === "env" ? client() : createMoneiClient({ apiKey: credentials.envKey });
    try {
      return { version: "v1", body: envClient.verifySignature(raw, signature) };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function matchesMode(credentials: Credentials, livemode: unknown): boolean {
  // A partner key's prefix describes the master account, not the merchant.
  if (credentials.source === "env" && credentials.accountId) return true;
  return typeof livemode === "boolean" && livemode === (credentials.mode === "live");
}

function isPaymentId(id: unknown): id is string {
  return typeof id === "string" && PAYMENT_ID.test(id);
}

function paymentLog(id: unknown): string {
  return isPaymentId(id) ? ` payment=${id}` : "";
}

export function ignoreWebhook(logger: Logger, reason: string, id?: unknown): undefined {
  logger.warn(`MONEI webhook ignored: ${reason}${paymentLog(id)}`);
  return undefined;
}

async function fallbackSession(
  { findSession, logger, providerId }: WebhookContext,
  id: string,
  sessionId: string,
): Promise<WebhookSession | undefined> {
  const session = await findSession(sessionId);
  if (!session) return ignoreWebhook(logger, "fallback callback session does not exist", id);
  if (session.provider_id !== providerId || settlementPaymentId(session) !== id) {
    return ignoreWebhook(
      logger,
      "fallback callback session does not belong to this provider and payment",
      id,
    );
  }
  if (session.payment?.captured_at || session.payment?.canceled_at) {
    return ignoreWebhook(logger, "fallback callback session payment is captured or canceled", id);
  }
  return session;
}

function takeFallbackSlot(sessionId: string): boolean {
  const now = Date.now();
  fallbackFetches = fallbackFetches.filter(({ at }) => at > now - MINUTE);
  if (
    fallbackFetches.length >= 60 ||
    fallbackFetches.filter((fetch) => fetch.sessionId === sessionId).length >= 5
  ) {
    return false;
  }
  fallbackFetches.push({ at: now, sessionId });
  return true;
}

async function fetchFallback(
  credentials: Credentials,
  context: WebhookContext,
  id: string,
  sessionId: string,
  raw: string,
  signature: SignatureHeader,
): Promise<Payment | undefined> {
  const { client, logger } = context;
  const now = Date.now();
  for (const [key, entry] of deliveries) {
    if (entry.expiresAt <= now) deliveries.delete(key);
  }
  // Both subscribers can reuse a fetch, but a key or merchant switch needs a fresh one.
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        id,
        sessionId,
        credentials.apiKey,
        credentials.accountId,
        credentials.mode,
        raw,
        signature,
      ]),
    )
    .digest("hex");
  const existing = deliveries.get(key);
  if (existing) return existing.result;

  if (!takeFallbackSlot(sessionId)) {
    logger.error(`MONEI webhook refused: fallback fetch quota reached payment=${id}`);
    return undefined;
  }
  logger.info(`MONEI callback fallback fetch payment=${id}`);
  const delivery: Delivery = {
    expiresAt: now + MINUTE,
    result: callMonei("get payment", () => client().payments.get(id)).then((payment) => {
      if (payment.id !== id || payment.orderId !== sessionId) {
        return ignoreWebhook(
          logger,
          "fetched payment id or orderId does not match the callback",
          id,
        );
      }
      if (!matchesMode(credentials, payment.livemode)) {
        return ignoreWebhook(
          logger,
          "fetched payment livemode does not match the configured mode",
          id,
        );
      }
      return payment;
    }),
  };
  deliveries.set(key, delivery);
  try {
    return await delivery.result;
  } catch (error) {
    if (deliveries.get(key) === delivery) deliveries.delete(key);
    throw error;
  }
}

/** Read only the raw callback. Only the fetched payment supplies settlement data. */
export async function verifyWebhook(
  credentials: Credentials,
  { rawData, headers }: { rawData?: unknown; headers?: Record<string, unknown> },
  context: WebhookContext,
): Promise<{ payment: Payment; verified: boolean } | undefined> {
  const { client, logger } = context;
  if (!credentials.apiKey) return ignoreWebhook(logger, "MONEI is not connected");
  const raw = rawBody(rawData);
  if (!raw) return ignoreWebhook(logger, "raw body is missing or not a string or Buffer");
  const signature = signatureHeader(headers);
  const signed = signedBy(credentials, context, raw, signature);
  if (signed) {
    const { version, body } = signed;
    if (!isObject(body)) return ignoreWebhook(logger, "raw body is not a JSON object");
    const pointer = paymentIdOf(body);
    if ("refused" in pointer) return ignoreWebhook(logger, pointer.refused);
    const { paymentId } = pointer;
    if (!matchesMode(credentials, body.livemode)) {
      return ignoreWebhook(
        logger,
        "verified callback livemode does not match the configured mode",
        paymentId,
      );
    }
    logger.info(`MONEI callback verified (${version})${paymentLog(paymentId)}`);
    // Throw on API failures so the event bus can retry.
    const payment = await callMonei("get payment", () => client().payments.get(paymentId));
    return { payment, verified: true };
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return ignoreWebhook(logger, "raw body is not valid JSON");
  }
  if (!isObject(body)) return ignoreWebhook(logger, "raw body is not a JSON object");
  if ("objectType" in body) {
    return ignoreWebhook(
      logger,
      "signature verification failed for an account-webhook event",
      body.objectId,
    );
  }
  const { id } = body;
  if (!isPaymentId(id)) return ignoreWebhook(logger, "fallback callback has an invalid payment id");
  const sessionId = sessionIdOf(body.orderId);
  if (!sessionId)
    return ignoreWebhook(logger, "fallback callback orderId is not a Medusa session id", id);
  if (!(await fallbackSession(context, id, sessionId))) return undefined;
  const payment = await fetchFallback(credentials, context, id, sessionId, raw, signature);
  return payment ? { payment, verified: false } : undefined;
}
