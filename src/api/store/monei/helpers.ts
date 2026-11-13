import type { MedusaContainer } from "@medusajs/framework/types";
import { MedusaError } from "@medusajs/framework/utils";
import type { CustomerPaymentMethod, Monei } from "@monei-js/node-sdk";
import { isNotFound, toMedusaError } from "../../../providers/monei/core/errors";
import { opaqueId } from "../../../providers/monei/core/ids";
import { findCardHolders, findOne, query } from "../../../providers/monei/core/scope";

type MoneiSession = {
  id: string;
  provider_id: string;
  data: Record<string, unknown> | null;
};

/**
 * A non-empty string, or 400. An array or an operator object would reach the
 * query filters, and an undefined filter matches every row.
 */
export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, `\`${name}\` must be a non-empty string`);
  }
  return value;
}

export function requireCustomerId(req: { auth_context?: { actor_id?: string } }): string {
  const id = req.auth_context?.actor_id;
  if (!id) throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Unauthorized");
  return id;
}

/** The MONEI customer ids of the Medusa customer's card account holders. */
export async function findMoneiCustomerIds(
  scope: MedusaContainer,
  customerId: string,
): Promise<string[]> {
  const holders = await findCardHolders(query(scope), customerId);
  return holders.map((holder) => holder.moneiCustomerId);
}

/**
 * The session and the id and customer of the cart it belongs to, resolved like
 * core `processPaymentWorkflow` (session, then the cart-collection link, then the cart).
 */
export async function findSessionCart(
  scope: MedusaContainer,
  sessionId: string,
): Promise<{ session: MoneiSession; cart: { id: string; customer_id: string | null } }> {
  const session = await findOne(
    query(scope),
    "payment_session",
    ["id", "provider_id", "payment_collection_id", "data"],
    { id: sessionId },
  );
  const collectionId = session?.payment_collection_id;
  if (!session || typeof collectionId !== "string" || !collectionId) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, `Payment session ${sessionId} not found`);
  }
  const link = await findOne(
    query(scope),
    "cart_payment_collection",
    ["cart_id", "payment_collection_id"],
    { payment_collection_id: collectionId },
  );
  const cartId = link?.cart_id;
  const cart =
    typeof cartId === "string" && cartId
      ? await findOne(query(scope), "cart", ["id", "customer_id"], { id: cartId })
      : undefined;
  if (!cart) {
    throw new MedusaError(MedusaError.Types.FORBIDDEN, "The payment session has no cart");
  }
  return {
    session: session as unknown as MoneiSession,
    cart: {
      id: cart.id as string,
      customer_id: typeof cart.customer_id === "string" ? cart.customer_id : null,
    },
  };
}

/** The MONEI payment id stored by `initiatePayment`. */
export function sessionPaymentId(session: MoneiSession): string {
  const id = session.data?.id;
  if (typeof id !== "string" || !id) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Payment session ${session.id} has no MONEI payment`,
    );
  }
  return id;
}

/** Saved cards of a MONEI customer; a customer already deleted at MONEI has none. */
async function listSavedCards(
  client: Monei,
  moneiCustomerId: string,
): Promise<CustomerPaymentMethod[]> {
  try {
    return await client.customers.listPaymentMethods(moneiCustomerId);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw toMedusaError(error, "list payment methods");
  }
}

export type SavedCard = { moneiCustomerId: string; card: CustomerPaymentMethod };

/** Saved cards of every card holder of the shopper, each with the MONEI customer that owns it. */
export async function listShopperCards(
  client: Monei,
  moneiCustomerIds: string[],
): Promise<SavedCard[]> {
  const lists = await Promise.all(
    moneiCustomerIds.map(async (moneiCustomerId) =>
      (await listSavedCards(client, moneiCustomerId)).map((card) => ({ moneiCustomerId, card })),
    ),
  );
  return lists.flat();
}

export function findSavedCard(cards: SavedCard[], id: string): SavedCard {
  const found = cards.find(({ card }) => opaqueId(card.id) === id);
  if (!found) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Payment method not found");
  return found;
}
