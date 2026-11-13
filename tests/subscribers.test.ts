import { Monei } from "@monei-js/node-sdk";
import MockAdapter from "axios-mock-adapter";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import reconcile, { config } from "../src/subscribers/monei-payment-reconcile";
import { API_KEY, fakeGraph, sign } from "./helpers";

// The subscriber builds its own client; hand it one whose axios instance is mocked.
const shared = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock("../src/providers/monei/core/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createMoneiClient: () => shared.client,
}));

const API = "https://api.monei.com/v1";

const callback = JSON.stringify({ id: "pay_1", status: "SUCCEEDED" });

const moneiPayment = (overrides: Record<string, unknown> = {}) => ({
  id: "pay_1",
  orderId: "payses_gone",
  amount: 1999,
  currency: "EUR",
  status: "SUCCEEDED",
  ...overrides,
});

const cardHolder = (id: string, externalId: string) => ({
  id,
  provider_id: "pp_monei_monei",
  external_id: externalId,
  data: { id: externalId },
});

const flaggedSession = (id: string, moneiCustomerId: string) => ({
  id,
  data: { id: "pay_1", monei_customer_missing: true },
  context: {
    customer: { id: "cus_A" },
    account_holder: { data: { id: moneiCustomerId } },
  },
});

const tables: Record<string, Record<string, unknown>[]> = {
  payment_session: [
    { id: "payses_other", data: { id: "pay_2" }, context: null },
    {
      id: "payses_live",
      data: { id: "pay_1", monei_customer_missing: false },
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
let emit: ReturnType<typeof vi.fn>;
let deleteAccountHolder: ReturnType<typeof vi.fn>;
let logger: Record<"warn" | "info" | "error", ReturnType<typeof vi.fn>>;
let container: { resolve: (key: string) => unknown };

beforeEach(() => {
  const client = new Monei(API_KEY);
  shared.client = client;
  mock = new MockAdapter(client.client);
  emit = vi.fn();
  deleteAccountHolder = vi.fn();
  logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  const deps: Record<string, unknown> = {
    query: { graph: fakeGraph(tables) },
    logger,
    event_bus: { emit },
    payment: { deleteAccountHolder },
    configModule: {
      modules: {
        payment: {
          options: {
            providers: [
              { id: "monei", options: { apiKey: API_KEY, backendUrl: "https://shop.test" } },
            ],
          },
        },
      },
    },
  };
  container = { resolve: (key) => deps[key] };
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
          data: { id: "pay_1", orderId: "payses_live" },
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
    mock.onGet(`${API}/payments/pay_1`).reply(200, moneiPayment());

    await run();

    expect(emit).toHaveBeenCalledWith({
      name: "monei.orphan_payment",
      data: {
        payment_id: "pay_1",
        session_id: "payses_gone",
        amount: 19.99,
        currency: "EUR",
        status: "SUCCEEDED",
      },
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toContain("pay_1");
    expect(logger.error.mock.calls[0][0]).toContain("refund it");
    expect(posts()).toBe(0);
  });

  it("reports an authorized payment whose session now points to another payment", async () => {
    // Bug: only a missing session is checked, so a replaced payment is never reported.
    mock
      .onGet(`${API}/payments/pay_1`)
      .reply(200, moneiPayment({ orderId: "payses_other", status: "AUTHORIZED" }));

    await run();

    expect(emit).toHaveBeenCalledWith({
      name: "monei.orphan_payment",
      data: expect.objectContaining({ payment_id: "pay_1", session_id: "payses_other" }),
    });
    // Bug: told to refund an AUTHORIZED hold, which MONEI refuses.
    expect(logger.error.mock.calls[0][0]).toContain("cancel it");
  });

  it("stays silent for a canceled payment whose session is gone", async () => {
    // Bug: every cart change cancels the old payment, so each CANCELED callback raises an alert.
    mock.onGet(`${API}/payments/pay_1`).reply(200, moneiPayment({ status: "CANCELED" }));

    await run();

    expect(emit).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("stays silent for a paid payment of the session's own payment", async () => {
    // Bug: every normal checkout is reported as an orphan, or a live holder is deleted.
    mock.onGet(`${API}/payments/pay_1`).reply(200, moneiPayment({ orderId: "payses_live" }));

    await run();

    expect(emit).not.toHaveBeenCalled();
    expect(deleteAccountHolder).not.toHaveBeenCalled();
  });

  it("ignores payments of another integration on the same MONEI account", async () => {
    // Bug: a WooCommerce order paid on the shared account is reported as a Medusa orphan.
    mock.onGet(`${API}/payments/pay_1`).reply(200, moneiPayment({ orderId: "WC-1042" }));

    await run();

    expect(emit).not.toHaveBeenCalled();
  });

  it("throws when the payment cannot be fetched, so the event bus retries", async () => {
    // Bug: an API outage swallows the only callback of an orphan payment.
    mock
      .onGet(`${API}/payments/pay_1`)
      .reply(503, { statusCode: 503, message: "Service unavailable" });

    await expect(run()).rejects.toThrow("Service unavailable");
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("reconcile subscriber: verification", () => {
  beforeEach(() => {
    // Would be reported as an orphan if the callback were accepted.
    mock.onGet(`${API}/payments/pay_1`).reply(200, moneiPayment());
  });

  it("does nothing for a callback with a bad signature", async () => {
    // Bug: a forged callback makes the subscriber alert or delete account holders.
    await run({ headers: { "monei-signature": sign(callback, "pk_test_other") } });

    expect(mock.history.get).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
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
      objectType: "charge",
      objectId: "pay_1",
      object: { id: "pay_1", status: "SUCCEEDED" },
    });

    await run({ rawData: event, headers: { "monei-signature": sign(event) } });

    expect(mock.history.get.map((request) => request.url)).toEqual([`${API}/payments/pay_1`]);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ payment_id: "pay_1" }) }),
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
    mock.onGet(`${API}/payments/pay_1`).reply(200, moneiPayment({ orderId: "payses_stale" }));
    mock
      .onGet(`${API}/customers/mcus_old`)
      .reply(404, { status: "NOT_FOUND", statusCode: 404, message: "Customer not found" });

    await run();

    expect(deleteAccountHolder).toHaveBeenCalledExactlyOnceWith("acchld_old");
    expect(emit).not.toHaveBeenCalled();
  });

  it("keeps the holder when the MONEI customer still exists", async () => {
    // Bug: a holder is deleted on the flag alone, and the shopper loses the saved cards.
    mock.onGet(`${API}/payments/pay_1`).reply(200, moneiPayment({ orderId: "payses_stale" }));
    mock.onGet(`${API}/customers/mcus_old`).reply(200, { id: "mcus_old" });

    await run();

    expect(deleteAccountHolder).not.toHaveBeenCalled();
  });

  it("keeps the current holder when the stale one was already replaced", async () => {
    // Bug: a late callback deletes the new holder made by the next checkout.
    mock.onGet(`${API}/payments/pay_1`).reply(200, moneiPayment({ orderId: "payses_replaced" }));

    await run();

    expect(mock.history.get.map((request) => request.url)).not.toContain(
      `${API}/customers/mcus_older`,
    );
    expect(deleteAccountHolder).not.toHaveBeenCalled();
  });

  it("throws and keeps the holder when MONEI cannot answer", async () => {
    // Bug: a MONEI outage is read as a deleted customer and the holder is dropped.
    mock.onGet(`${API}/payments/pay_1`).reply(200, moneiPayment({ orderId: "payses_stale" }));
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
