import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { MedusaContainer } from "@medusajs/framework/types";
import MockAdapter from "axios-mock-adapter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import registerDomains from "../src/jobs/monei-apple-pay-domains";
import { createMoneiClient } from "../src/providers/monei/core/client";
import { clearCredentialsCache, loadCredentials } from "../src/providers/monei/core/credentials";
import { moneiClient } from "../src/providers/monei/core/scope";
import type { MoneiMode } from "../src/providers/monei/types";
import { TestProvider } from "./helpers";

const adapters = new Map<string, MockAdapter[]>();
vi.mock("../src/providers/monei/core/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/providers/monei/core/client")>();
  return {
    ...actual,
    createMoneiClient: vi.fn((options: Parameters<typeof actual.createMoneiClient>[0]) => {
      const client = actual.createMoneiClient(options);
      const mock = new MockAdapter(client.client, { onNoMatch: "throwException" });
      mock.onGet("https://api.monei.com/v1/payments/pay_1").reply(200, {
        id: "pay_1",
        amount: 1999,
        currency: "EUR",
        status: "PENDING",
      });
      const mocks = adapters.get(options.apiKey) ?? [];
      mocks.push(mock);
      adapters.set(options.apiKey, mocks);
      return client;
    }),
  };
});

const live = {
  id: "mcred_live",
  mode: "live" as const,
  account_id: "acc_live",
  api_key: "mk_live_fixture",
  signing_secret: "fixture_live_signing",
};
const test = {
  id: "mcred_test",
  mode: "test" as const,
  account_id: "acc_test",
  api_key: "mk_test_fixture",
  signing_secret: "fixture_test_signing",
};
const replacement = { ...test, id: "mcred_replacement", api_key: "mk_test_replacement" };

const snapshot = (
  rows: (typeof live | typeof test)[] = [],
  storedMode: MoneiMode | null = null,
) => ({
  rows: [{ rows, storedMode }],
});

function database(result = snapshot()) {
  const raw = vi.fn<() => Promise<ReturnType<typeof snapshot>>>().mockResolvedValue(result);
  return { knex: { raw } as unknown as Knex, raw };
}

const logger = { warn: vi.fn() };
const backendUrl = "https://api.example.test";

function scopeWith(knex: Knex, apiKey?: string) {
  const deps: Record<string, unknown> = {
    __pg_connection__: knex,
    logger,
    configModule: {
      projectConfig: { http: { storeCors: "https://shop.example.test" } },
      modules: {
        payment: { options: { providers: [{ id: "monei", options: { apiKey, backendUrl } }] } },
      },
    },
  };
  return { resolve: (key: string) => deps[key] } as MedusaContainer;
}

beforeEach(() => {
  clearCredentialsCache();
  vi.clearAllMocks();
  adapters.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("credentials in effect", () => {
  it.each([
    {
      bug: "both connected rows move a backend with a Test env key to Live",
      apiKey: "pk_test_fixture",
      rows: [live, test],
      storedMode: "live",
      expected: { mode: "test", apiKey: test.api_key, source: "connected" },
    },
    {
      bug: "a connected Live row shadows a Test env key",
      apiKey: "pk_test_fixture",
      rows: [live],
      storedMode: "live",
      expected: { mode: "test", apiKey: "pk_test_fixture", source: "env" },
    },
    {
      bug: "a Live env key still wins after a Live connect",
      apiKey: "pk_live_fixture",
      rows: [live],
      storedMode: "test",
      expected: { mode: "live", apiKey: live.api_key, source: "connected" },
    },
    {
      bug: "a connected Test row shadows a Live env key",
      apiKey: "pk_live_fixture",
      rows: [test],
      storedMode: "test",
      expected: { mode: "live", apiKey: "pk_live_fixture", source: "env" },
    },
    {
      bug: "a connected Test row shadows an env key with an unknown prefix",
      apiKey: "pk_abc_fixture",
      rows: [test],
      storedMode: "test",
      expected: { mode: "live", apiKey: "pk_abc_fixture", source: "env" },
    },
    {
      bug: "an mk_test_ env key is treated as Live",
      apiKey: "mk_test_env_fixture",
      rows: [live],
      storedMode: "live",
      expected: { mode: "test", apiKey: "mk_test_env_fixture", source: "env" },
    },
    {
      bug: "approval and reconnect move a stored Test backend to Live",
      apiKey: undefined,
      rows: [live, test],
      storedMode: "test",
      expected: { mode: "test", apiKey: test.api_key, source: "connected" },
    },
    {
      bug: "a backend with stored Live mode still uses its connected Test key",
      apiKey: undefined,
      rows: [test, live],
      storedMode: "live",
      expected: { mode: "live", apiKey: live.api_key, source: "connected" },
    },
  ] as const)("prevents $bug", async ({ apiKey, rows, storedMode, expected }) => {
    const { knex } = database(snapshot([...rows], storedMode));

    await expect(loadCredentials(knex, { apiKey }, logger)).resolves.toMatchObject({
      ...expected,
      envKey: apiKey,
      storedMode,
      rows,
    });
  });

  it("boots before connecting and rejects a payment call with no key", async () => {
    const { knex } = database();
    const provider = new TestProvider({ logger, __pg_connection__: knex }, { backendUrl });

    await expect(provider.getPaymentStatus({ data: { id: "pay_1" } })).rejects.toThrow(
      "MONEI is not connected: connect it in Settings → MONEI or set MONEI_API_KEY",
    );
    expect(createMoneiClient).not.toHaveBeenCalled();
  });

  it("keeps the env key and account header for a partner provider with connected rows", async () => {
    const { knex } = database(snapshot([live, test], "live"));
    const provider = new TestProvider(
      { logger, __pg_connection__: knex },
      { apiKey: "pk_live_partner", accountId: "acc_partner", backendUrl },
    );

    await provider.getPaymentStatus({ data: { id: "pay_1" } });

    const [mock] = adapters.get("pk_live_partner") ?? [];
    expect(mock.history.get[0].headers?.["MONEI-Account-ID"]).toBe("acc_partner");
    expect(adapters.has(live.api_key)).toBe(false);
  });

  it("sends no partner account header with a connected key's stored account ID", async () => {
    const { knex } = database(snapshot([live], "live"));
    const provider = new TestProvider({ logger, __pg_connection__: knex }, { backendUrl });

    await expect(loadCredentials(knex, {}, logger)).resolves.toMatchObject({
      accountId: live.account_id,
      signingSecret: live.signing_secret,
    });
    await provider.getPaymentStatus({ data: { id: "pay_1" } });

    const [mock] = adapters.get(live.api_key) ?? [];
    expect(mock.history.get[0].headers?.["MONEI-Account-ID"]).toBeUndefined();
  });

  it("warns and skips Apple Pay registration before connecting even with HTTPS storeCors", async () => {
    const { knex } = database();

    await registerDomains(scopeWith(knex));

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("MONEI is not connected"));
    expect(createMoneiClient).not.toHaveBeenCalled();
  });
});

describe("credential cache", () => {
  it("sees a replacement immediately after clearing the cache", async () => {
    const { knex, raw } = database(snapshot([test], "test"));
    expect((await loadCredentials(knex, {}, logger)).apiKey).toBe(test.api_key);

    raw.mockResolvedValue(snapshot([replacement], "test"));
    clearCredentialsCache();

    expect((await loadCredentials(knex, {}, logger)).apiKey).toBe(replacement.api_key);
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it("avoids a database read at 29 seconds and reloads after 30 seconds", async () => {
    vi.useFakeTimers();
    const { knex, raw } = database(snapshot([test], "test"));
    expect((await loadCredentials(knex, {}, logger)).apiKey).toBe(test.api_key);
    raw.mockResolvedValue(snapshot([replacement], "test"));

    vi.advanceTimersByTime(29_000);
    expect((await loadCredentials(knex, {}, logger)).apiKey).toBe(test.api_key);
    expect(raw).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_001);
    expect((await loadCredentials(knex, {}, logger)).apiKey).toBe(replacement.api_key);
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it("keeps a pre-switch read from overwriting the new cache entry", async () => {
    const { knex, raw } = database(snapshot([replacement], "test"));
    const deferred = Promise.withResolvers<ReturnType<typeof snapshot>>();
    raw.mockReturnValueOnce(deferred.promise);
    const pending = loadCredentials(knex, {}, logger);

    clearCredentialsCache();
    expect((await loadCredentials(knex, {}, logger)).apiKey).toBe(replacement.api_key);
    deferred.resolve(snapshot([test], "test"));
    await pending;

    expect((await loadCredentials(knex, {}, logger)).apiKey).toBe(replacement.api_key);
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it("keeps checkout on the env key before migration and warns only once across reloads", async () => {
    const { knex, raw } = database();
    raw.mockRejectedValue(Object.assign(new Error("missing table"), { code: "42P01" }));
    const options = { apiKey: "pk_test_env_fixture" };

    await expect(loadCredentials(knex, options, logger)).resolves.toMatchObject({
      apiKey: options.apiKey,
      rows: [],
      source: "env",
    });
    clearCredentialsCache();
    expect((await loadCredentials(knex, options, logger)).apiKey).toBe(options.apiKey);
    expect(raw).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("medusa db:migrate"),
    );
  });

  it("surfaces a database outage and retries the query on the next call", async () => {
    const { knex, raw } = database(snapshot([test], "test"));
    const outage = Object.assign(new Error("database unavailable"), { code: "08006" });
    raw.mockRejectedValueOnce(outage);
    const options = { apiKey: "pk_test_env_fixture" };

    await expect(loadCredentials(knex, options, logger)).rejects.toBe(outage);
    expect((await loadCredentials(knex, options, logger)).apiKey).toBe(test.api_key);
    expect(raw).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("refreshes the singleton provider and the same scope after reconnect without restart", async () => {
    const { knex, raw } = database(snapshot([test], "test"));
    const scope = scopeWith(knex);
    const provider = new TestProvider({ logger, __pg_connection__: knex }, { backendUrl });
    const providerCall = () => provider.getPaymentStatus({ data: { id: "pay_1" } });
    const scopeCall = async () => (await moneiClient(scope)).payments.get("pay_1");

    await providerCall();
    await scopeCall();

    raw.mockResolvedValue(snapshot([replacement], "test"));
    clearCredentialsCache();
    await providerCall();
    await scopeCall();
    await providerCall();
    await scopeCall();

    expect(adapters.get(test.api_key)?.map((mock) => mock.history.get.length)).toEqual([1, 1]);
    expect(adapters.get(replacement.api_key)?.map((mock) => mock.history.get.length)).toEqual([
      2, 2,
    ]);
  });
});
