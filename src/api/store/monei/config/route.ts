import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { getMoneiOptions } from "../../../../providers/monei/core/client";

/**
 * The capture mode, for the storefront's PayPal components: monei.js loads the PayPal
 * SDK with `intent=capture` unless it gets `transactionType: "AUTH"`, and a capture
 * order cannot pay an AUTH payment. Public: the mode is no secret.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  res.json({ capture: getMoneiOptions(req.scope).capture !== false });
};
