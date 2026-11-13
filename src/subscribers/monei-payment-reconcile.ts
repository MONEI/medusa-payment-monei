import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import type {
  IEventBusModuleService,
  IPaymentModuleService,
  Logger,
  MedusaContainer,
  ProviderWebhookPayload,
} from "@medusajs/framework/types";
import {
  ContainerRegistrationKeys,
  Modules,
  PaymentWebhookEvents,
} from "@medusajs/framework/utils";
import { type Monei, type Payment, PaymentStatus } from "@monei-js/node-sdk";
import { callMonei, isNotFound, toMedusaError } from "../providers/monei/core/errors";
import { isMoneiProvider, sessionIdOf } from "../providers/monei/core/ids";
import {
  findCardHolders,
  findOne,
  moneiClient,
  type Query,
  query as resolveQuery,
} from "../providers/monei/core/scope";
import { verifyWebhook } from "../providers/monei/core/webhook";
import { fromMinorUnits } from "../providers/monei/utils/amount";
import { HELD_OR_MOVED } from "../providers/monei/utils/status";
import { scheduleHoldRelease } from "./monei-hold-release";

export const ORPHAN_PAYMENT_EVENT = "monei.orphan_payment";

type StoredSession = {
  id: string;
  data?: Record<string, unknown> | null;
  context?: {
    customer?: { id?: string } | null;
    account_holder?: { data?: Record<string, unknown> } | null;
  } | null;
};

async function findSession(query: Query, id: string): Promise<StoredSession | undefined> {
  return (await findOne(query, "payment_session", ["id", "data", "context"], { id })) as
    | StoredSession
    | undefined;
}

async function reportOrphan(
  container: MedusaContainer,
  logger: Logger,
  payment: Payment,
  session: StoredSession | undefined,
) {
  const data = {
    payment_id: payment.id,
    session_id: payment.orderId,
    amount: fromMinorUnits(payment.amount, payment.currency),
    currency: payment.currency,
    status: payment.status,
  };
  logger.error(
    `MONEI orphan payment: payment ${data.payment_id} of ${data.amount} ${data.currency} is ${data.status}, but session ${data.session_id} ${session ? `points to payment ${String(session.data?.id)}` : "no longer exists"}; if no order was created, ${data.status === PaymentStatus.AUTHORIZED ? "cancel" : "refund"} it in the MONEI dashboard`,
  );
  await container
    .resolve<IEventBusModuleService>(Modules.EVENT_BUS)
    .emit({ name: ORPHAN_PAYMENT_EVENT, data });
}

/**
 * The session's card account holder points to a MONEI customer that is gone: delete
 * the holder, and the next session creates a new one (`createPaymentAccountHolderStep`).
 */
async function removeStaleHolder(
  container: MedusaContainer,
  query: Query,
  client: Monei,
  logger: Logger,
  session: StoredSession,
) {
  const moneiCustomerId = session.context?.account_holder?.data?.id;
  const customerId = session.context?.customer?.id;
  if (typeof moneiCustomerId !== "string" || !moneiCustomerId || !customerId) return;

  const holder = (await findCardHolders(query, customerId)).find(
    (h) => h.moneiCustomerId === moneiCustomerId,
  );
  // Already deleted or replaced by a new holder: nothing left to do.
  if (!holder?.id) return;

  try {
    await client.customers.get(moneiCustomerId);
    return;
  } catch (error) {
    // Only a confirmed 404 deletes; an outage throws so the event bus retries.
    if (!isNotFound(error)) throw toMedusaError(error, "get customer");
  }
  await container.resolve<IPaymentModuleService>(Modules.PAYMENT).deleteAccountHolder(holder.id);
  logger.info(
    `MONEI customer ${moneiCustomerId} no longer exists; deleted account holder ${holder.id}`,
  );
}

/**
 * Runs next to the core webhook subscriber for what it cannot see: a charged MONEI
 * payment whose session is gone or replaced, a hold whose cart may never become an
 * order, and an account holder whose MONEI customer was deleted.
 */
export default async function moneiPaymentReconcile({
  event,
  container,
}: SubscriberArgs<ProviderWebhookPayload>) {
  const provider = event.data?.provider;
  if (typeof provider !== "string") return;
  const providerId = provider.startsWith("pp_") ? provider : `pp_${provider}`;
  if (!isMoneiProvider(providerId)) return;

  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  const client = moneiClient(container);
  // The core subscriber may already have rebuilt `rawData` on this shared event object.
  const verified = verifyWebhook(client, event.data.payload ?? {});
  if ("refused" in verified) {
    logger.warn(`MONEI reconcile ignored a callback: ${verified.refused}`);
    return;
  }

  const payment = await callMonei("get payment", () => client.payments.get(verified.paymentId));
  // Another integration on the same MONEI account.
  const sessionId = sessionIdOf(payment.orderId);
  if (!sessionId) return;

  const query = resolveQuery(container);
  const session = await findSession(query, sessionId);

  if (HELD_OR_MOVED.has(payment.status) && session?.data?.id !== payment.id) {
    await reportOrphan(container, logger, payment, session);
  }
  // Scheduled for every hold: the core subscriber completes the cart in parallel, so
  // whether it got an order is known only later, at the re-check.
  if (payment.status === PaymentStatus.AUTHORIZED && session?.data?.id === payment.id) {
    await scheduleHoldRelease(container, { payment_id: payment.id, session_id: sessionId });
  }
  if (session?.data?.monei_customer_missing === true) {
    await removeStaleHolder(container, query, client, logger, session);
  }
}

export const config: SubscriberConfig = {
  event: PaymentWebhookEvents.WebhookReceived,
  context: { subscriberId: "monei-payment-reconcile" },
};
