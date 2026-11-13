import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import type { Logger } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils";
import { callMonei } from "../../../../providers/monei/core/errors";
import { CARD_PROVIDER_ID } from "../../../../providers/monei/core/ids";
import { moneiClient } from "../../../../providers/monei/core/scope";
import { toSessionStatus } from "../../../../providers/monei/utils/status";
import {
  findMoneiCustomerIds,
  findSavedCard,
  findSessionCart,
  listShopperCards,
  requireCustomerId,
  requireString,
  sessionPaymentId,
} from "../helpers";

/**
 * Pays a card session with a saved card. The permanent token stays on the server:
 * the storefront sends only the opaque id from `GET /store/monei/payment-methods`.
 */
export const POST = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const customerId = requireCustomerId(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const sessionId = requireString(body.payment_session_id, "payment_session_id");
  const methodId = requireString(body.payment_method_id, "payment_method_id");

  const { session, cart } = await findSessionCart(req.scope, sessionId);
  if (cart.customer_id !== customerId) {
    throw new MedusaError(MedusaError.Types.FORBIDDEN, "The payment session is not yours");
  }
  if (session.provider_id !== CARD_PROVIDER_ID) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Saved cards can only pay a MONEI card session",
    );
  }
  const moneiCustomerIds = await findMoneiCustomerIds(req.scope, customerId);
  if (!moneiCustomerIds.length) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, "Payment method not found");
  }

  const client = moneiClient(req.scope);
  const paymentId = sessionPaymentId(session);
  const payment = await callMonei("get payment", () => client.payments.get(paymentId));
  // MONEI checks a token against the customer only when the payment has one. The
  // session's holder, not the first one: a shopper can have two.
  const moneiCustomerId = payment.customerId;
  if (
    payment.orderId !== session.id ||
    !moneiCustomerId ||
    !moneiCustomerIds.includes(moneiCustomerId)
  ) {
    throw new MedusaError(
      MedusaError.Types.FORBIDDEN,
      "The MONEI payment does not belong to this session and customer",
    );
  }

  const { card } = findSavedCard(await listShopperCards(client, [moneiCustomerId]), methodId);
  const confirmed = await callMonei("confirm payment", () =>
    client.payments.confirm(paymentId, { paymentToken: card.id }),
  );

  const logger = req.scope.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  // Only these two fields: the confirmed payment carries the permanent token.
  res.json({
    status: toSessionStatus(confirmed.status, logger),
    redirect_url: confirmed.nextAction?.redirectUrl ?? null,
  });
};
