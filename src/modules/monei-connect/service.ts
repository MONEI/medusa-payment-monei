import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { EntityManager } from "@medusajs/framework/mikro-orm/postgresql";
import type { Client } from "@medusajs/framework/pg";
import type { Context } from "@medusajs/framework/types";
import {
  generateEntityId,
  InjectTransactionManager,
  MedusaContext,
  MedusaService,
} from "@medusajs/framework/utils";
import { clearCredentialsCache, MONEI_SETTING_ID } from "../../providers/monei/core/credentials";
import { MONEI_MODES, type MoneiMode } from "../../providers/monei/types";
import MoneiConnectState from "./models/connect-state";
import MoneiCredential from "./models/credential";
import MoneiSetting from "./models/setting";

const CREDENTIAL_LOCK = 0x4d4f4e45;

type ProvenCredential = { accountId: string; apiKey: string; signingSecret: string };
type SwitchResults = Partial<Record<MoneiMode, ProvenCredential>> & { envMode?: MoneiMode };
type SwitchResult = "switched" | "otherAccount" | "temporarily_unavailable";
type ConsumedState = { verifier: string; redirect_uri: string; expired: boolean };

export default class MoneiConnectService extends MedusaService({
  MoneiCredential,
  MoneiSetting,
  MoneiConnectState,
}) {
  private readonly knex: Knex;

  constructor(container: { __pg_connection__: Knex }) {
    super(container);
    this.knex = container.__pg_connection__;
  }

  async createState(state: string, verifier: string, redirectUri: string): Promise<void> {
    await this.knex("monei_connect_state").insert({
      id: generateEntityId(undefined, "mcstate"),
      state,
      verifier,
      redirect_uri: redirectUri,
    });
  }

  async consumeState(state: string): Promise<ConsumedState | undefined> {
    const { rows } = await this.knex.raw<{ rows: ConsumedState[] }>(
      `delete from monei_connect_state where state = ?
       returning verifier, redirect_uri, now() - created_at > interval '20 minutes' as expired`,
      [state],
    );
    return rows[0];
  }

  async deleteOldStates(): Promise<void> {
    await this.knex("monei_connect_state")
      .whereRaw("created_at < now() - interval '20 minutes'")
      .delete();
  }

  /** A null liveBasis means there was no stored Live row when the caller checked Live. */
  async switchCredentials(results: SwitchResults, liveBasis: string | null): Promise<SwitchResult> {
    const result = await this.withCredentialLock(async (context, trx) => {
      const rows = await this.listMoneiCredentials(
        {},
        { select: ["id", "mode", "account_id"] },
        context,
      );
      const live = rows.find((row) => row.mode === "live");
      if (results.live) {
        // Check the basis under the lock before interpreting the stored account.
        if ((live?.id ?? null) !== liveBasis) return "temporarily_unavailable";
        if (live && live.account_id !== results.live.accountId) return "otherAccount";
      }

      for (const mode of MONEI_MODES) {
        const credential = results[mode];
        if (!credential) continue;
        const previous = rows.find((row) => row.mode === mode);
        if (previous) await this.deleteMoneiCredentials(previous.id, context);
        // The transaction client returns its pinned pg connection. Sending the
        // insert directly keeps its bindings and errors out of both query loggers.
        try {
          const connection: Client = await trx.client.acquireConnection();
          await connection.query({
            text: `insert into monei_credential (id, mode, account_id, api_key, signing_secret)
                   values ($1, $2, $3, $4, $5)`,
            values: [
              generateEntityId(undefined, "mcred"),
              mode,
              credential.accountId,
              credential.apiKey,
              credential.signingSecret,
            ],
          });
        } catch {
          // PostgreSQL errors can include the full failing row.
          throw new Error(`Could not write the MONEI ${mode} credential`);
        }
      }
      if (results.live || results.test) {
        const [setting] = await this.listMoneiSettings({ id: MONEI_SETTING_ID }, {}, context);
        if (!setting) {
          const mode = results.envMode ?? (results.live ? "live" : "test");
          await this.createMoneiSettings({ id: MONEI_SETTING_ID, mode }, context);
        }
      }
      return "switched";
    });
    if (result === "switched") clearCredentialsCache();
    return result;
  }

  async setMode(mode: MoneiMode): Promise<boolean> {
    const changed = await this.withCredentialLock(async (context) => {
      const [credential] = await this.listMoneiCredentials({ mode }, {}, context);
      if (!credential) return false;
      const [setting] = await this.listMoneiSettings({ id: MONEI_SETTING_ID }, {}, context);
      if (setting) {
        await this.updateMoneiSettings({ id: MONEI_SETTING_ID, mode }, context);
      } else {
        await this.createMoneiSettings({ id: MONEI_SETTING_ID, mode }, context);
      }
      return true;
    });
    if (changed) clearCredentialsCache();
    return changed;
  }

  async disconnect(): Promise<void> {
    await this.withCredentialLock(async (context, trx) => {
      const rows = await this.listMoneiCredentials({}, {}, context);
      if (rows.length)
        await this.deleteMoneiCredentials(
          rows.map(({ id }) => id),
          context,
        );
      await trx("monei_connect_state").delete();
    });
    clearCredentialsCache();
  }

  @InjectTransactionManager()
  private async withCredentialLock<T>(
    write: (context: Context<EntityManager>, trx: Knex.Transaction) => Promise<T>,
    @MedusaContext() context: Context<EntityManager> = {},
  ): Promise<T> {
    const trx = context.transactionManager?.getTransactionContext<Knex.Transaction>();
    if (!trx) throw new Error("MONEI credential writes require a database transaction");
    await trx.raw("select pg_advisory_xact_lock(?)", [CREDENTIAL_LOCK]);
    return write(context, trx);
  }
}
