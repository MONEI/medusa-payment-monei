// Helpers for routes and subscribers, which cannot resolve the provider itself.
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import type { Monei } from "@monei-js/node-sdk";
import { createMoneiClient, getMoneiOptions, MoneiNotConnectedError } from "./client";
import { type Credentials, loadCredentials } from "./credentials";
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

const clients = new WeakMap<object, { apiKey: string; accountId?: string; client: Monei }>();

export function clientForCredentials(owner: object, credentials: Credentials): Monei {
  const { apiKey } = credentials;
  if (!apiKey) throw new MoneiNotConnectedError();
  const accountId = credentials.source === "env" ? credentials.accountId : undefined;
  const cached = clients.get(owner);
  if (cached?.apiKey === apiKey && cached.accountId === accountId) {
    return cached.client;
  }
  const client = createMoneiClient({ apiKey, accountId });
  clients.set(owner, { apiKey, accountId, client });
  return client;
}

export async function moneiClient(scope: MedusaContainer): Promise<Monei> {
  const config = scope.resolve<object>(ContainerRegistrationKeys.CONFIG_MODULE);
  const credentials = await loadCredentials(
    scope.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION),
    getMoneiOptions(scope),
    scope.resolve<Logger>(ContainerRegistrationKeys.LOGGER),
  );
  return clientForCredentials(config, credentials);
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
