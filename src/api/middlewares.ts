import {
  authenticate,
  defineMiddlewares,
  type MedusaNextFunction,
  type MedusaRequest,
  type MedusaResponse,
} from "@medusajs/framework/http";
import type { BigNumberInput } from "@medusajs/framework/types";
import { MedusaError } from "@medusajs/framework/utils";
import { isMoneiProvider } from "../providers/monei/core/ids";
import { SESSION_DATA_KEYS } from "../providers/monei/core/monei-base";
import { findOne, query } from "../providers/monei/core/scope";
import { toMinorUnits } from "../providers/monei/utils/amount";

/**
 * The provider receives no capture amount (core `capturePaymentFromProvider_`
 * passes only `data`), so a partial capture would capture in full at MONEI while
 * Medusa records less.
 */
export async function refusePartialMoneiCapture(
  req: MedusaRequest,
  _res: MedusaResponse,
  next: MedusaNextFunction,
) {
  const amount = (req.body as { amount?: unknown } | undefined)?.amount;
  const id = req.params.id;
  // Any other amount type is left to the core body validator.
  if (typeof amount !== "number" || typeof id !== "string") return next();

  const payment = (await findOne(
    query(req.scope),
    "payment",
    ["id", "provider_id", "amount", "currency_code"],
    { id },
  )) as { provider_id?: string; amount?: BigNumberInput; currency_code?: string } | undefined;
  if (
    typeof payment?.provider_id !== "string" ||
    !isMoneiProvider(payment.provider_id) ||
    payment.amount === undefined ||
    !payment.currency_code
  ) {
    return next();
  }
  // In cents, as MONEI holds it: tax maths can leave 6.034 on a payment MONEI holds as 6.03.
  if (
    toMinorUnits(amount, payment.currency_code).amount <
    toMinorUnits(payment.amount, payment.currency_code).amount
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "MONEI payments can only be captured in full: omit `amount` or send the full payment amount",
    );
  }
  return next();
}

/**
 * Only the provider may set the MONEI keys of session data: `deletePayment` and the
 * storefront trust them. The route reads `req.body`, not `validatedBody`, so this checks
 * the same object.
 */
export function refuseReservedMoneiSessionData(
  req: MedusaRequest,
  _res: MedusaResponse,
  next: MedusaNextFunction,
) {
  const { provider_id: providerId, data } = (req.body ?? {}) as Record<string, unknown>;
  // Any other shape is left to the core body validator.
  if (typeof providerId !== "string" || !isMoneiProvider(providerId)) return next();
  if (typeof data !== "object" || data === null) return next();
  // `__proto__`: an own key after JSON.parse, a prototype (inherited `id`) after a copy.
  const reserved = [...SESSION_DATA_KEYS, "__proto__"].filter((key) =>
    Object.prototype.hasOwnProperty.call(data, key),
  );
  if (reserved.length) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `\`data\` must not contain ${reserved.map((key) => `\`${key}\``).join(", ")}: the MONEI provider sets them`,
    );
  }
  return next();
}

const customerOnly = authenticate("customer", ["session", "bearer"]);

export default defineMiddlewares({
  routes: [
    { matcher: "/store/monei/payment-methods", methods: ["GET"], middlewares: [customerOnly] },
    {
      matcher: "/store/monei/payment-methods/:id",
      methods: ["DELETE"],
      middlewares: [customerOnly],
    },
    { matcher: "/store/monei/confirm", methods: ["POST"], middlewares: [customerOnly] },
    {
      matcher: "/store/payment-collections/:id/payment-sessions",
      methods: ["POST"],
      middlewares: [refuseReservedMoneiSessionData],
    },
    {
      matcher: "/admin/payments/:id/capture",
      methods: ["POST"],
      middlewares: [refusePartialMoneiCapture],
    },
  ],
});
