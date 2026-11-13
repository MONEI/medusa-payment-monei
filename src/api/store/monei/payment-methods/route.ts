import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { opaqueId } from "../../../../providers/monei/core/ids";
import { moneiClient } from "../../../../providers/monei/core/scope";
import { findMoneiCustomerIds, listShopperCards, requireCustomerId } from "../helpers";

export const GET = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const customerId = requireCustomerId(req);
  // Every card holder: the confirm route pays with a card of whichever one the session used.
  const moneiCustomerIds = await findMoneiCustomerIds(req.scope, customerId);
  const cards = await listShopperCards(moneiClient(req.scope), moneiCustomerIds);
  res.json({
    payment_methods: cards.map(({ card }) => ({
      id: opaqueId(card.id),
      brand: card.paymentMethod?.card?.brand ?? null,
      last4: card.paymentMethod?.card?.last4 ?? null,
      // Seconds since the Unix epoch, as MONEI returns it.
      expires_at: card.paymentMethod?.card?.expiration ?? null,
    })),
  });
};
