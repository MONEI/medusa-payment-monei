import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { Logger } from "@medusajs/framework/types";
import type { MoneiMode, MoneiOptions } from "../types";

type CredentialRow = {
  id: string;
  mode: MoneiMode;
  account_id: string;
  api_key: string;
  signing_secret: string;
};

type StoredCredentials = {
  rows: CredentialRow[];
  storedMode: MoneiMode | null;
};

export type Credentials = StoredCredentials & {
  mode: MoneiMode | null;
  apiKey?: string;
  accountId?: string;
  signingSecret?: string;
  source: "connected" | "env" | null;
  envKey?: string;
};

export const MONEI_SETTING_ID = "monei";

export function modeOfKey(apiKey: string): MoneiMode {
  return /^(pk|mk)_test_/.test(apiKey) ? "test" : "live";
}

const EMPTY: StoredCredentials = { rows: [], storedMode: null };
const TTL_MS = 30_000;
let generation = 0;
let warnedMissingTables = false;
const cache = new WeakMap<
  Knex,
  { generation: number; expiresAt: number; result: Promise<StoredCredentials> }
>();

export function clearCredentialsCache(): void {
  generation++;
}

async function readStored(knex: Knex, logger: Pick<Logger, "warn">): Promise<StoredCredentials> {
  try {
    // Read both tables in one snapshot in case a connect commits during the lookup.
    const { rows } = await knex.raw<{ rows: StoredCredentials[] }>(
      `select
        (select coalesce(json_agg(c), '[]') from
          (select id, mode, account_id, api_key, signing_secret
           from monei_credential where deleted_at is null) c) as rows,
        (select mode from monei_setting where id = ? and deleted_at is null) as "storedMode"`,
      [MONEI_SETTING_ID],
    );
    return rows[0];
  } catch (error) {
    if ((error as { code?: string } | null)?.code !== "42P01") throw error;
    if (!warnedMissingTables) {
      warnedMissingTables = true;
      logger.warn("MONEI credentials tables are missing. Run medusa db:migrate to enable Connect.");
    }
    return EMPTY;
  }
}

function storedCredentials(knex: Knex, logger: Pick<Logger, "warn">): Promise<StoredCredentials> {
  const cached = cache.get(knex);
  if (cached?.generation === generation && cached.expiresAt > Date.now()) return cached.result;

  const entry = {
    generation,
    expiresAt: Infinity,
    result: readStored(knex, logger),
  };
  cache.set(knex, entry);
  void entry.result.then(
    () => {
      if (entry.generation === generation) entry.expiresAt = Date.now() + TTL_MS;
    },
    () => {
      if (cache.get(knex) === entry) cache.delete(knex);
    },
  );
  return entry.result;
}

export async function loadCredentials(
  knex: Knex,
  options: Pick<MoneiOptions, "apiKey" | "accountId">,
  logger: Pick<Logger, "warn"> = console,
): Promise<Credentials> {
  const envKey = options.apiKey;
  if (!knex) throw new Error("MONEI credentials require the Medusa PostgreSQL connection");
  const stored = await storedCredentials(knex, logger);
  const mode = envKey ? modeOfKey(envKey) : stored.storedMode;
  const row = options.accountId ? undefined : stored.rows.find((row) => row.mode === mode);
  if (row) {
    return {
      ...stored,
      mode,
      apiKey: row.api_key,
      accountId: row.account_id,
      signingSecret: row.signing_secret,
      source: "connected",
      envKey,
    };
  }
  return {
    ...stored,
    mode,
    apiKey: envKey,
    accountId: envKey ? options.accountId : undefined,
    source: envKey ? "env" : null,
    envKey,
  };
}
