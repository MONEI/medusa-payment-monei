import { knex } from "@medusajs/framework/mikro-orm/knex";
import { expect, it, vi } from "vite-plus/test";
import MoneiConnectService from "../src/modules/monei-connect/service";

it("keeps credential bindings and rejected rows out of Knex query and error events", async () => {
  const db = knex({ client: "pg" });
  const apiKey = "fixture-api-key";
  const signingSecret = "fixture-signing-secret";
  const inserted = vi.fn();
  // Let real Knex run the transaction and emit events, with a stub for the pg wire connection.
  const connection = {
    query(
      { text, values }: { text: string; values: unknown[] },
      callback?: (error: Error | null, result?: object) => void,
    ) {
      if (text.includes("monei_credential")) {
        inserted(values.includes(apiKey) && values.includes(signingSecret));
        const error = new Error(`Rejected row (${apiKey}, ${signingSecret})`);
        if (!callback) return Promise.reject(error);
        callback(error);
        return;
      }
      callback?.(null, { command: "", rows: [], rowCount: 0 });
    },
  };
  vi.spyOn(db.client, "acquireConnection").mockResolvedValue(connection);
  vi.spyOn(db.client, "releaseConnection").mockResolvedValue(undefined);
  const exposed = vi.fn();
  const recordExposure = (...args: unknown[]) => {
    const details = JSON.stringify(args.map((arg) => (arg instanceof Error ? arg.message : arg)));
    exposed(details.includes(apiKey) || details.includes(signingSecret));
  };
  db.on("query", recordExposure);
  db.on("query-error", recordExposure);
  const dependencies = {
    __pg_connection__: db,
    baseRepository: {
      transaction: (fn: (manager: unknown) => Promise<unknown>) =>
        db.transaction((trx) => fn({ getTransactionContext: () => trx })),
    },
  };
  const service = new MoneiConnectService(dependencies);
  vi.spyOn(service, "listMoneiCredentials").mockResolvedValue([]);
  try {
    await expect(
      service.switchCredentials(
        { test: { accountId: "test-account", apiKey, signingSecret } },
        null,
      ),
    ).rejects.toThrow(/^Could not write the MONEI test credential$/);
    expect(inserted).toHaveBeenCalledExactlyOnceWith(true);
    expect(exposed).toHaveBeenCalled();
    expect(exposed).not.toHaveBeenCalledWith(true);
  } finally {
    await db.destroy();
  }
});
