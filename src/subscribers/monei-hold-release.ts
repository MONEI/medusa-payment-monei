import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import type {
  IEventBusModuleService,
  ILockingModule,
  IPaymentModuleService,
  Logger,
  MedusaContainer,
} from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { PaymentStatus, type Payment } from "@monei-js/node-sdk";
import { getMoneiOptions } from "../providers/monei/core/client";
import { callMonei } from "../providers/monei/core/errors";
import { findOne, moneiClient, query as resolveQuery } from "../providers/monei/core/scope";
import { fromMinorUnits } from "../providers/monei/utils/amount";

/** Internal: the delayed re-check of one `AUTHORIZED` payment. */
export const HOLD_RELEASE_DUE_EVENT = "monei.hold_release_due";
export const HOLD_RELEASE_FAILED_EVENT = "monei.hold_release_failed";

type HoldRef = { payment_id: string; session_id: string };

// Core completeCartWorkflow and processPaymentWorkflow lock the cart id with these values.
const LOCK_WAIT_MS = 30_000;
const LOCK_TTL_SECONDS = 120;
const LOCK_RETRY_MS = 300;

/** Called for every `AUTHORIZED` callback of a session that still holds the payment. */
export async function scheduleHoldRelease(container: MedusaContainer, hold: HoldRef) {
  const minutes = getMoneiOptions(container).releaseUnorderedHoldsAfterMinutes;
  if (!minutes) return;
  await container
    .resolve<IEventBusModuleService>(Modules.EVENT_BUS)
    .emit({ name: HOLD_RELEASE_DUE_EVENT, data: hold }, { delay: minutes * 60_000 });
}

async function withCartLock<T>(container: MedusaContainer, cartId: string, job: () => Promise<T>) {
  const locking = container.resolve<ILockingModule>(Modules.LOCKING);
  // Own owner id: the 2.17 locking `execute` releases without one, which can free a core lock.
  const ownerId = `monei-hold-release:${randomUUID()}`;
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await locking.acquire(cartId, { ownerId, expire: LOCK_TTL_SECONDS });
      break;
    } catch (error) {
      if (Date.now() >= until) throw error;
    }
    await sleep(LOCK_RETRY_MS);
  }
  try {
    return await job();
  } finally {
    await locking.release(cartId, { ownerId });
  }
}

/**
 * Cancels an `AUTHORIZED` MONEI payment whose cart never became an order (core cart
 * completion reserves stock before it authorizes, so a stock-out leaves the hold). The
 * session is deleted through the payment module, so the provider's `deletePayment`
 * cancels the payment, as on any cart change.
 */
export default async function moneiHoldRelease({ event, container }: SubscriberArgs<HoldRef>) {
  const { payment_id: paymentId, session_id: sessionId } = event.data;
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  const query = resolveQuery(container);
  const client = moneiClient(container);
  const kept = (reason: string) =>
    logger.info(`MONEI hold check: payment ${paymentId} kept: ${reason}`);

  let cartId: string | undefined;
  let payment: Payment | undefined;
  try {
    const session = await findOne(query, "payment_session", ["id", "payment_collection_id"], {
      id: sessionId,
    });
    const collectionId = session?.payment_collection_id;
    if (typeof collectionId !== "string") return kept(`session ${sessionId} no longer exists`);
    const link = await findOne(
      query,
      "cart_payment_collection",
      ["cart_id", "payment_collection_id"],
      { payment_collection_id: collectionId },
    );
    if (typeof link?.cart_id !== "string") return kept(`session ${sessionId} belongs to no cart`);
    const cart = link.cart_id;
    cartId = cart;

    await withCartLock(container, cart, async () => {
      // Re-read under the lock: the cart may have completed or changed while waiting.
      const order = await findOne(query, "order_cart", ["order_id", "cart_id"], { cart_id: cart });
      if (order) return kept(`cart ${cart} has order ${String(order.order_id)}`);
      const current = await findOne(query, "payment_session", ["id", "data"], { id: sessionId });
      if ((current?.data as { id?: unknown } | null | undefined)?.id !== paymentId) {
        return kept(`session ${sessionId} no longer holds it`);
      }
      payment = await callMonei("get payment", () => client.payments.get(paymentId));
      if (payment.status !== PaymentStatus.AUTHORIZED || payment.orderId !== sessionId) {
        return kept(`it is ${payment.status}`);
      }

      // Core logs the failed cart completion as "[object Object]": this line names it.
      logger.warn(
        `MONEI hold release: payment ${paymentId} of ${fromMinorUnits(payment.amount, payment.currency)} ${payment.currency} is AUTHORIZED, but cart ${cart} has no order after the release delay (cart completion failed, for example out of stock); canceling it by deleting session ${sessionId}`,
      );
      await container
        .resolve<IPaymentModuleService>(Modules.PAYMENT)
        .deletePaymentSession(sessionId);
      // deletePayment logs and swallows a refused cancel, so only MONEI can tell.
      const after = await callMonei("get payment", () => client.payments.get(paymentId));
      if (after.status !== PaymentStatus.CANCELED) {
        throw new Error(`the payment is ${after.status} after the cancel`);
      }
      logger.info(`MONEI hold release: payment ${paymentId} of cart ${cart} is CANCELED`);
    });
  } catch (error) {
    // No event bus retry: a failed release is reported once, loudly.
    const data = {
      payment_id: paymentId,
      session_id: sessionId,
      cart_id: cartId ?? null,
      amount: payment ? fromMinorUnits(payment.amount, payment.currency) : null,
      currency: payment?.currency ?? null,
      reason: error instanceof Error ? error.message : String(error),
    };
    logger.error(
      `MONEI hold release failed: payment ${paymentId} (session ${sessionId}, cart ${cartId ?? "unknown"}${payment ? `, ${data.amount} ${data.currency}` : ""}) may still hold the buyer's money: ${data.reason}; cancel it in the MONEI dashboard if the cart has no order`,
    );
    await container
      .resolve<IEventBusModuleService>(Modules.EVENT_BUS)
      .emit({ name: HOLD_RELEASE_FAILED_EVENT, data });
  }
}

export const config: SubscriberConfig = {
  event: HOLD_RELEASE_DUE_EVENT,
  context: { subscriberId: "monei-hold-release" },
};
