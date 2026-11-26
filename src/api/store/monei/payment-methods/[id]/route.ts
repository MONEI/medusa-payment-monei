import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { callMonei } from "../../../../../providers/monei/core/errors";
import { moneiClient, moneiCredentials } from "../../../../../providers/monei/core/scope";
import {
  findMoneiCustomerIds,
  findSavedCard,
  listShopperCards,
  requireCustomerId,
  requireString,
} from "../../helpers";

export const DELETE = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const customerId = requireCustomerId(req);
  const id = requireString(req.params.id, "id");
  const credentials = await moneiCredentials(req.scope);
  const moneiCustomerIds = await findMoneiCustomerIds(req.scope, customerId, credentials);
  const client = await moneiClient(req.scope, credentials);
  const { moneiCustomerId, card } = findSavedCard(
    await listShopperCards(client, moneiCustomerIds),
    id,
  );
  await callMonei("delete payment method", () =>
    client.customers.deletePaymentMethod(moneiCustomerId, card.id),
  );
  res.json({ id, deleted: true });
};
