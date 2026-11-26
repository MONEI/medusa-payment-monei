import MockAdapter from "axios-mock-adapter";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type * as reconcileModule from "../src/subscribers/monei-payment-reconcile";
import type { MoneiOptions } from "../src/providers/monei/types";
import {
  API_KEY,
  emptyCredentialsStore,
  fakeGraph,
  MONEI_PAYMENT_ID,
  sign,
  signV2,
  type TestProvider,
} from "./helpers";

const mocks = vi.hoisted(() => new Map<string, MockAdapter[]>());
vi.mock("../src/providers/monei/core/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/providers/monei/core/client")>();
  return {
    ...actual,
    createMoneiClient: (options: Parameters<typeof actual.createMoneiClient>[0]) => {
      const client = actual.createMoneiClient(options);
      const adapters = mocks.get(options.apiKey) ?? [];
      adapters.push(new MockAdapter(client.client));
      mocks.set(options.apiKey, adapters);
      return client;
    },
  };
});

const API = "https://api.monei.com/v1";
const PROVIDER_ID = "pp_monei_monei";

const callbackBody = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: MONEI_PAYMENT_ID,
    status: "SUCCEEDED",
    orderId: "payses_gone",
    livemode: false,
    ...overrides,
  });
const callback = callbackBody();

const moneiPayment = (overrides: Record<string, unknown> = {}) => ({
  id: MONEI_PAYMENT_ID,
  orderId: "payses_gone",
  amount: 1999,
  currency: "EUR",
  status: "SUCCEEDED",
  livemode: false,
  ...overrides,
});

const cardHolder = (id: string, externalId: string, mode?: string) => ({
  id,
  provider_id: "pp_monei_monei",
  external_id: externalId,
  data: { id: externalId, mode },
});

const flaggedSession = (id: string, moneiCustomerId: string) => ({
  id,
  data: { id: MONEI_PAYMENT_ID, monei_customer_missing: true },
  context: {
    customer: { id: "cus_A" },
    account_holder: { data: { id: moneiCustomerId } },
  },
});

const fixtures: Record<string, Record<string, unknown>[]> = {
  payment_session: [
    { id: "payses_other", data: { id: "pay_2" }, context: null },
    {
      id: "payses_live",
      data: { id: MONEI_PAYMENT_ID, monei_customer_missing: false },
      context: {
        customer: { id: "cus_A" },
        account_holder: { data: { id: "mcus_old" } },
      },
    },
    flaggedSession("payses_stale", "mcus_old"),
    flaggedSession("payses_replaced", "mcus_older"),
  ],
  customer: [
    {
      id: "cus_A",
      account_holders: [
        null,
        { id: "acchld_s", provider_id: "pp_stripe_stripe", external_id: "mcus_old" },
        cardHolder("acchld_new", "mcus_new"),
        cardHolder("acchld_old", "mcus_old"),
      ],
    },
  ],
};

let mock: MockAdapter;
let tables: typeof fixtures;
let emit: ReturnType<typeof vi.fn>;
let deleteAccountHolder: ReturnType<typeof vi.fn>;
let logger: Record<"warn" | "info" | "error", ReturnType<typeof vi.fn>>;
let container: { resolve: (key: string) => unknown };
let Provider: typeof TestProvider;
let reconcile: typeof reconcileModule.default;
let config: typeof reconcileModule.config;
let readCredentials: ReturnType<typeof vi.fn>;
let moneiClient: typeof import("../src/providers/monei/core/scope").moneiClient;
let options: MoneiOptions;

beforeEach(async () => {
  vi.resetModules();
  ({ TestProvider: Provider } = await import("./helpers"));
  ({ default: reconcile, config } = await import("../src/subscribers/monei-payment-reconcile"));
  ({ moneiClient } = await import("../src/providers/monei/core/scope"));
  mocks.clear();
  tables = structuredClone(fixtures);
  tables.payment_session.forEach((session) => {
    session.provider_id = PROVIDER_ID;
  });
  options = { apiKey: API_KEY, backendUrl: "https://shop.test" };
  readCredentials = vi.fn(emptyCredentialsStore.raw);
  emit = vi.fn();
  deleteAccountHolder = vi.fn();
  logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  const deps: Record<string, unknown> = {
    __pg_connection__: { raw: readCredentials },
    query: { graph: fakeGraph(tables) },
    logger,
    event_bus: { emit },
    payment: { deleteAccountHolder },
    configModule: {
      modules: {
        payment: {
          options: {
            providers: [{ id: "monei", options }],
          },
        },
      },
    },
  };
  container = { resolve: (key) => deps[key] };
  await moneiClient(container as never);
  mock = mocks.get(API_KEY)![0];
});

const run = (
  overrides: { provider?: string; rawData?: unknown; headers?: Record<string, unknown> } = {},
) =>
  reconcile({
    event: {
      name: config.event as string,
      data: {
        provider: overrides.provider ?? "monei_monei",
        payload: {
          // Never trusted: names another session.
          data: { id: MONEI_PAYMENT_ID, orderId: "payses_live" },
          rawData: (overrides.rawData ?? callback) as string,
          headers: overrides.headers ?? { "monei-signature": sign(callback) },
        },
      },
    },
    container: container as never,
    pluginOptions: {},
  });

const posts = () => mock.history.post.length;

describe("reconcile subscriber: orphan payments", () => {
  it("reports a paid payment whose session is gone, and never refunds it", async () => {
    // Bug: a Bizum approved after a cart change is charged with no order and nobody hears of it.
    mock.onGet(`${API}/payments/${MONEI_PAYMENT_ID}`).reply(200, moneiPayment());

    await run();

    expect(emit).toHaveBeenCalledWith({
      name: "monei.orphan_payment",
      data: {
        payment_id: MONEI_PAYMENT_ID,
        session_id: "payses_gone",
        amount: 19.99,
        currency: "EUR",
        status: "SUCCEEDED",
      },
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toContain(MONEI_PAYMENT_ID);
    expect(logger.error.mock.calls[0][0]).toContain("refund it");
    expect(posts()).toBe(0);
  });

  it("reconciles a PayPal account webhook signed with its own secret and reports an unattached charge", async () => {
    const paypalSecret = "whsec_" + "b".repeat(43);
    options.accountWebhookSigningSecrets = {
      pp_monei_monei: "whsec_" + "a".repeat(43),
      "pp_monei-paypal_monei": paypalSecret,
    };
    const session = tables.payment_session.find(({ id }) => id === "payses_live")!;
    session.provider_id = "pp_monei-paypal_monei";
    session.payment = { data: { id: "another_payment" } };
    mock
      .onGet(`${API}/payments/${MONEI_PAYMENT_ID}`)
      .reply(200, moneiPayment({ orderId: "payses_live" }));
    const raw = JSON.stringify({
      type: "charge.captured",
      livemode: false,
      objectType: "charge",
      objectId: MONEI_PAYMENT_ID,
      object: { id: MONEI_PAYMENT_ID },
    });

    await run({
      provider: "monei-paypal_monei",
      rawData: raw,
      headers: { "monei-signature": signV2(raw, paypalSecret) },
    });

    expect(mock.history.get).toHaveLength(1);
    expect(emit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: "monei.orphan_payment" }),
    );
  });

  it("reports an authorized payment whose session now points to another payment", async () => {
    // Bug: only a missing session is checked, so a replaced payment is never reported.
    mock
      .onGet(`${API}/payments/${MONEI_PAYMENT_ID}`)
      .reply(200, moneiPayment({ orderId: "payses_other", status: "AUTHORIZED" }));

    await run();

    expect(emit).toHaveBeenCalledWith({
      name: "monei.orphan_payment",
      data: expect.objectContaining({ payment_id: MONEI_PAYMENT_ID, session_id: "payses_other" }),
    });
    // Bug: told to refund an AUTHORIZED hold, which MONEI refuses.
    expect(logger.error.mock.calls[0][0]).toContain("cancel it");
  });

  it("stays silent for a canceled payment whose session is gone", async () => {
    // Bug: every cart change cancels the old payment, so each CANCELED callback raises an alert.
    mock
      .onGet(`${API}/payments/${MONEI_PAYMENT_ID}`)
      .reply(200, moneiPayment({ status: "CANCELED" }));

    await run();

    expect(emit).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("stays silent for a paid payment of the session's own payment", async () => {
    // Bug: every normal checkout is reported as an orphan, or a live holder is deleted.
    mock
      .onGet(`${API}/payments/${MONEI_PAYMENT_ID}`)
      .reply(200, moneiPayment({ orderId: "payses_live" }));

    await run();

    expect(emit).not.toHaveBeenCalled();
    expect(deleteAccountHolder).not.toHaveBeenCalled();
  });

  it("does not alert for a payment delivered to the wrong provider's account webhook URL", async () => {
    tables.payment_session.find(({ id }) => id === "payses_live")!.provider_id =
      "pp_monei-paypal_monei";
    mock
      .onGet(`${API}/payments/${MONEI_PAYMENT_ID}`)
      .reply(200, moneiPayment({ orderId: "payses_live", status: "AUTHORIZED" }));

    const raw = JSON.stringify({
      type: "charge.authorized",
      livemode: false,
      objectType: "charge",
      objectId: MONEI_PAYMENT_ID,
      object: { id: MONEI_PAYMENT_ID },
    });

    await run({ rawData: raw, headers: { "monei-signature": sign(raw) } });

    expect(emit).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("ignores payments of another integration on the same MONEI account", async () => {
    // Bug: a WooCommerce order paid on the shared account is reported as a Medusa orphan.
    mock
      .onGet(`${API}/payments/${MONEI_PAYMENT_ID}`)
      .reply(200, moneiPayment({ orderId: "WC-1042" }));

    await run();

    expect(emit).not.toHaveBeenCalled();
  });

  it("throws when the payment cannot be fetched, so the event bus retries", async () => {
    // Bug: an API outage swallows the only callback of an orphan payment.
    mock
      .onGet(`${API}/payments/${MONEI_PAYMENT_ID}`)
      .reply(503, { statusCode: 503, message: "Service unavailable" });

    await expect(run()).rejects.toThrow("Service unavailable");
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("reconcile subscriber: verification", () => {
  beforeEach(() => {
    // Would be reported as an orphan if the callback were accepted.
    mock.onGet(`${API}/payments/${MONEI_PAYMENT_ID}`).reply(200, moneiPayment());
  });

  it("does nothing for a callback with a bad signature when the session is gone", async () => {
    // Bug: a forged callback makes the subscriber alert or delete account holders.
    await run({ headers: { "monei-signature": sign(callback, "pk_test_other") } });

    expect(mock.history.get).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("fetches with the active key after a bad signature when the session is open", async () => {
    const raw = callbackBody({ orderId: "payses_live" });
    mock
      .onGet(`${API}/payments/${MONEI_PAYMENT_ID}`)
      .reply(200, moneiPayment({ orderId: "payses_live", status: "AUTHORIZED" }));

    await run({ rawData: raw, headers: { "monei-signature": sign(raw, "pk_test_other") } });

    expect(mock.history.get).toHaveLength(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ name: "monei.hold_release_due" }),
      expect.anything(),
    );
  });

  it.each(["captured_at", "canceled_at"])(
    "does not fetch an unsigned replay when the session payment has %s",
    async (field) => {
      const id = "payses_finished";
      tables.payment_session.push({
        id,
        provider_id: PROVIDER_ID,
        data: { id: MONEI_PAYMENT_ID },
        payment: { data: { id: MONEI_PAYMENT_ID }, [field]: new Date() },
      });

      await run({ rawData: callbackBody({ orderId: id }), headers: {} });

      expect(mock.history.get).toHaveLength(0);
      expect(emit).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("captured or canceled"));
    },
  );

  it("fetches a signed orphan with the connected key when there is no env key", async () => {
    delete options.apiKey;
    const key = "mk_test_fixture";
    const secret = "mksec_fixture";
    readCredentials.mockResolvedValue({
      rows: [
        {
          rows: [
            {
              id: "credential",
              mode: "test",
              account_id: "merchant",
              api_key: key,
              signing_secret: secret,
            },
          ],
          storedMode: "test",
        },
      ],
    });
    const { clearCredentialsCache } = await import("../src/providers/monei/core/credentials");
    clearCredentialsCache();
    await moneiClient(container as never);
    const [connected] = mocks.get(key)!;
    const url = `${API}/payments/${MONEI_PAYMENT_ID}`;
    connected.onGet(url).reply(200, moneiPayment());

    await run({ headers: { "monei-signature": signV2(callback, secret) } });

    expect(connected.history.get.map((request) => request.url)).toEqual([url]);
    expect(mock.history.get).toHaveLength(0);
    expect(emit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: "monei.orphan_payment" }),
    );
  });

  it("shares the provider's refusal of a signed callback of the other mode", async () => {
    const raw = callbackBody({ livemode: true });
    const headers = { "monei-signature": sign(raw) };
    const provider = new Provider(
      { logger, __pg_connection__: emptyCredentialsStore },
      { apiKey: API_KEY, backendUrl: "https://shop.test" },
    );

    await expect(
      provider.getWebhookActionAndData({ rawData: raw, headers, data: {} }),
    ).resolves.toEqual({ action: "not_supported" });
    await run({ rawData: raw, headers });

    expect(mocks.get(API_KEY)!.flatMap((adapter) => adapter.history.get)).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("shares the last fallback slot across the providers' separate clients for one delivery", async () => {
    const orderId = "payses_live";
    const payment = moneiPayment({ orderId, status: "AUTHORIZED" });
    const paymentUrl = `${API}/payments/${MONEI_PAYMENT_ID}`;
    const provider = new Provider(
      {
        logger,
        __pg_connection__: emptyCredentialsStore,
        paymentSessionService: {
          list: async () => tables.payment_session.filter(({ id }) => id === orderId),
        },
      },
      { apiKey: API_KEY, backendUrl: "https://shop.test" },
    );
    await provider["client"]();
    const providerMock = mocks.get(API_KEY)![1];
    providerMock.onGet(paymentUrl).reply(200, payment);
    mock.onGet(paymentUrl).reply(200, payment);
    for (let index = 0; index < 4; index++) {
      const rawData = callbackBody({ orderId, updatedAt: index });
      await expect(
        provider.getWebhookActionAndData({ rawData, headers: {}, data: {} }),
      ).resolves.toMatchObject({ action: "authorized" });
    }

    const raw = callbackBody({ orderId });
    const headers = { "monei-signature": sign(raw, "pk_test_old") };
    const [action] = await Promise.all([
      provider.getWebhookActionAndData({ rawData: Buffer.from(raw), headers, data: {} }),
      run({ rawData: JSON.parse(JSON.stringify(Buffer.from(raw))), headers }),
    ]);

    expect(action).toMatchObject({ action: "authorized" });
    expect(emit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: "monei.hold_release_due" }),
      expect.anything(),
    );
    expect(providerMock.history.get.length + mock.history.get.length).toBe(5);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("verifies a raw body that the Redis event bus serialized as a Buffer object", async () => {
    // Bug: with Redis, every callback reaches the subscriber as {type:"Buffer"} and is refused.
    const serialized = JSON.parse(JSON.stringify(Buffer.from(callback)));

    await run({ rawData: serialized });

    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("reports the payment of an account-webhook event, never fetching the event id", async () => {
    // Bug: a dashboard webhook's event id is fetched as a payment, so the orphan is never seen.
    const event = JSON.stringify({
      id: "evt_1",
      type: "charge.succeeded",
      livemode: false,
      objectType: "charge",
      objectId: MONEI_PAYMENT_ID,
      object: { id: MONEI_PAYMENT_ID, status: "SUCCEEDED" },
    });

    await run({ rawData: event, headers: { "monei-signature": sign(event) } });

    expect(mock.history.get.map((request) => request.url)).toEqual([
      `${API}/payments/${MONEI_PAYMENT_ID}`,
    ]);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ payment_id: MONEI_PAYMENT_ID }) }),
    );
  });

  it("does nothing for webhooks of other payment providers", async () => {
    // Bug: every Stripe webhook logs a MONEI signature warning.
    await run({ provider: "stripe_stripe", headers: { "stripe-signature": "t=1,v1=x" } });

    expect(mock.history.get).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("reconcile subscriber: stale MONEI customers", () => {
  it("deletes the card holder whose MONEI customer is gone", async () => {
    // Bug: the holder keeps pointing to a deleted customer and no saved card works again.
    // The customer also has a newer card holder listed first: only the matching one goes.
    mock
      .onGet(`${API}/payments/${MONEI_PAYMENT_ID}`)
      .reply(200, moneiPayment({ orderId: "payses_stale" }));
    mock
      .onGet(`${API}/customers/mcus_old`)
      .reply(404, { status: "NOT_FOUND", statusCode: 404, message: "Customer not found" });

    await run();

    expect(deleteAccountHolder).toHaveBeenCalledExactlyOnceWith("acchld_old");
    expect(emit).not.toHaveBeenCalled();
  });

  it("keeps a Live holder even when the Test client would get a 404 for it", async () => {
    tables.customer[0].account_holders = [cardHolder("acchld_old", "mcus_old", "live")];
    mock
      .onGet(`${API}/payments/${MONEI_PAYMENT_ID}`)
      .reply(200, moneiPayment({ orderId: "payses_stale" }));
    mock
      .onGet(`${API}/customers/mcus_old`)
      .reply(404, { statusCode: 404, message: "Customer not found" });

    await run();

    expect(deleteAccountHolder).not.toHaveBeenCalled();
    expect(mock.history.get.map((request) => request.url)).toEqual([
      `${API}/payments/${MONEI_PAYMENT_ID}`,
    ]);
  });

  it("keeps the holder when the MONEI customer still exists", async () => {
    // Bug: a holder is deleted on the flag alone, and the shopper loses the saved cards.
    mock
      .onGet(`${API}/payments/${MONEI_PAYMENT_ID}`)
      .reply(200, moneiPayment({ orderId: "payses_stale" }));
    mock.onGet(`${API}/customers/mcus_old`).reply(200, { id: "mcus_old" });

    await run();

    expect(deleteAccountHolder).not.toHaveBeenCalled();
  });

  it("keeps the current holder when the stale one was already replaced", async () => {
    // Bug: a late callback deletes the new holder made by the next checkout.
    mock
      .onGet(`${API}/payments/${MONEI_PAYMENT_ID}`)
      .reply(200, moneiPayment({ orderId: "payses_replaced" }));

    await run();

    expect(mock.history.get.map((request) => request.url)).not.toContain(
      `${API}/customers/mcus_older`,
    );
    expect(deleteAccountHolder).not.toHaveBeenCalled();
  });

  it("throws and keeps the holder when MONEI cannot answer", async () => {
    // Bug: a MONEI outage is read as a deleted customer and the holder is dropped.
    mock
      .onGet(`${API}/payments/${MONEI_PAYMENT_ID}`)
      .reply(200, moneiPayment({ orderId: "payses_stale" }));
    mock
      .onGet(`${API}/customers/mcus_old`)
      .reply(503, { statusCode: 503, message: "Service unavailable" });

    await expect(run()).rejects.toThrow("Service unavailable");
    expect(deleteAccountHolder).not.toHaveBeenCalled();
  });
});

describe("reconcile subscriber: registration", () => {
  it("listens to payment webhooks under its own subscriber id", () => {
    // Bug: the core id "payment-webhook-handler" makes Medusa refuse to boot (subscriber already exists).
    expect(config).toEqual({
      event: "payment.webhook_received",
      context: { subscriberId: "monei-payment-reconcile" },
    });
  });
});
