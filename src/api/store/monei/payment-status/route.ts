import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import type { Logger } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils";
import { callMonei } from "../../../../providers/monei/core/errors";
import { isMoneiProvider } from "../../../../providers/monei/core/ids";
import { moneiClient } from "../../../../providers/monei/core/scope";
import { toSessionStatus } from "../../../../providers/monei/utils/status";
import { findSessionCart, requireString, sessionPaymentId } from "../helpers";

/**
 * The live MONEI status of a cart's session, for the return page: Medusa records
 * no failure (core ignores `failed`, MONEI sends no callback for `EXPIRED`).
 * Guests allowed: knowing the cart id is the store API's own cart capability.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const cartId = requireString(req.query.cart_id, "cart_id");
  const sessionId = requireString(req.query.session_id, "session_id");

  const { session, cart } = await findSessionCart(req.scope, sessionId);
  if (cart.id !== cartId) {
    throw new MedusaError(MedusaError.Types.FORBIDDEN, "The payment session is not of this cart");
  }
  if (!isMoneiProvider(session.provider_id)) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "Not a MONEI payment session");
  }

  const paymentId = sessionPaymentId(session);
  const payment = await callMonei("get payment", () =>
    moneiClient(req.scope).payments.get(paymentId),
  );
  if (payment.orderId !== session.id) {
    throw new MedusaError(
      MedusaError.Types.FORBIDDEN,
      "The MONEI payment does not belong to this session",
    );
  }

  const logger = req.scope.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  res.json({ status: toSessionStatus(payment.status, logger) });
};
