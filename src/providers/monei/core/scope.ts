// Helpers for routes and subscribers, which cannot resolve the provider itself.
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { Monei } from "@monei-js/node-sdk";
import { createMoneiClient, getMoneiOptions } from "./client";
import { CARD_PROVIDER_ID, moneiCustomerIdOf } from "./ids";

export type Query = {
  graph: (config: {
    entity: string;
    fields: string[];
    filters: Record<string, unknown>;
  }) => Promise<{ data: Record<string, unknown>[] }>;
};

export function query(scope: MedusaContainer): Query {
  return scope.resolve<Query>(ContainerRegistrationKeys.QUERY);
}

/** One client per loaded config: the options never change while it is loaded. */
const clients = new WeakMap<object, Monei>();

export function moneiClient(scope: MedusaContainer): Monei {
  const config = scope.resolve<object>(ContainerRegistrationKeys.CONFIG_MODULE);
  let client = clients.get(config);
  if (!client) {
    client = createMoneiClient(getMoneiOptions(scope));
    clients.set(config, client);
  }
  return client;
}

/**
 * The row that matches every filter; never trust `data[0]` alone. Filter values
 * are strings only: an undefined filter matches every row.
 */
export async function findOne(
  queryService: Query,
  entity: string,
  fields: string[],
  filters: Record<string, string>,
): Promise<Record<string, unknown> | undefined> {
  const { data } = await queryService.graph({ entity, fields, filters });
  return data.find((row) => Object.entries(filters).every(([key, value]) => row[key] === value));
}

/**
 * The Medusa customer's card account holders. Core `createPaymentSessionWorkflow`
 * uses the first; two first checkouts at once can leave two. Entries can be null.
 */
export async function findCardHolders(
  queryService: Query,
  customerId: string,
): Promise<{ id: string | undefined; moneiCustomerId: string }[]> {
  const customer = await findOne(queryService, "customer", ["id", "account_holders.*"], {
    id: customerId,
  });
  const holders = (customer?.account_holders ?? []) as ({
    id?: string;
    provider_id?: string;
    data?: Record<string, unknown>;
  } | null)[];
  return holders.flatMap((holder) => {
    const moneiCustomerId =
      holder?.provider_id === CARD_PROVIDER_ID ? moneiCustomerIdOf(holder) : undefined;
    return moneiCustomerId ? [{ id: holder?.id, moneiCustomerId }] : [];
  });
}
