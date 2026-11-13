import { Monei } from "@monei-js/node-sdk";
import MockAdapter from "axios-mock-adapter";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { validateOptions } from "../src/providers/monei/core/client";
import release, { config } from "../src/subscribers/monei-hold-release";
import reconcile, { config as reconcileConfig } from "../src/subscribers/monei-payment-reconcile";
import { API_KEY, fakeGraph, sign } from "./helpers";

const shared = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock("../src/providers/monei/core/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createMoneiClient: () => shared.client,
}));

const API = "https://api.monei.com/v1";

const moneiPayment = (overrides: Record<string, unknown> = {}) => ({
  id: "pay_1",
  orderId: "payses_1",
  amount: 2250,
  currency: "EUR",
  status: "AUTHORIZED",
  ...overrides,
});

let tables: Record<string, Record<string, unknown>[]>;
let mock: MockAdapter;
let emit: ReturnType<typeof vi.fn>;
let deletePaymentSession: ReturnType<typeof vi.fn>;
let acquire: ReturnType<typeof vi.fn>;
let lockRelease: ReturnType<typeof vi.fn>;
let logger: Record<"warn" | "info" | "error", ReturnType<typeof vi.fn>>;
let providerOptions: Record<string, unknown>;
let container: { resolve: (key: string) => unknown };

beforeEach(() => {
  const client = new Monei(API_KEY);
  shared.client = client;
  mock = new MockAdapter(client.client);
  tables = {
    payment_session: [{ id: "payses_1", data: { id: "pay_1" }, payment_collection_id: "paycol_1" }],
    cart_payment_collection: [{ cart_id: "cart_1", payment_collection_id: "paycol_1" }],
    order_cart: [],
    customer: [],
  };
  emit = vi.fn();
  deletePaymentSession = vi.fn();
  acquire = vi.fn();
  lockRelease = vi.fn();
  logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  providerOptions = { apiKey: API_KEY, backendUrl: "https://shop.test" };
  const deps: Record<string, unknown> = {
    query: { graph: fakeGraph(tables) },
    logger,
    event_bus: { emit },
    payment: { deletePaymentSession },
    locking: { acquire, release: lockRelease },
    configModule: {
      modules: { payment: { options: { providers: [{ id: "monei", options: providerOptions }] } } },
    },
  };
  container = { resolve: (key) => deps[key] };
});

const runCheck = () =>
  release({
    event: {
      name: config.event as string,
      data: { payment_id: "pay_1", session_id: "payses_1" },
    },
    container: container as never,
    pluginOptions: {},
  });

const cancels = () => mock.history.post.filter((request) => request.url?.endsWith("/cancel"));

describe("hold release: scheduling", () => {
  const callback = JSON.stringify({ id: "pay_1", status: "AUTHORIZED" });
  const runCallback = () =>
    reconcile({
      event: {
        name: reconcileConfig.event as string,
        data: {
          provider: "monei_monei",
          payload: {
            data: {},
            rawData: callback,
            headers: { "monei-signature": sign(callback) },
          },
        },
      },
      container: container as never,
      pluginOptions: {},
    });

  it("schedules a re-check 30 minutes after the AUTHORIZED callback by default", async () => {
    // Bug: a stock-out hold is never re-checked, so the buyer's money stays held for days.
    mock.onGet(`${API}/payments/pay_1`).reply(200, moneiPayment());

    await runCallback();

    expect(emit).toHaveBeenCalledExactlyOnceWith(
      { name: "monei.hold_release_due", data: { payment_id: "pay_1", session_id: "payses_1" } },
      { delay: 1_800_000 },
    );
  });

  it("schedules nothing when the option is 0", async () => {
    // Bug: a store that completes carts later than any delay cannot turn the release off.
    providerOptions.releaseUnorderedHoldsAfterMinutes = 0;
    mock.onGet(`${API}/payments/pay_1`).reply(200, moneiPayment());

    await runCallback();

    expect(emit).not.toHaveBeenCalled();
  });

  it("refuses a delay that is not a whole number of minutes", () => {
    // Bug: `process.env.X` gives "30", and an env string would schedule a wrong delay.
    for (const value of ["30", -1]) {
      expect(() =>
        validateOptions({ ...providerOptions, releaseUnorderedHoldsAfterMinutes: value as never }),
      ).toThrow("`releaseUnorderedHoldsAfterMinutes` must be a whole number");
    }
  });

  it("accepts a delay up to 7 days and refuses a longer one", () => {
    // Bug: 35792 minutes passes 2^31 ms, Node fires the timer after 1 ms, and the
    // re-check cancels the hold while core cart completion still runs.
    expect(
      validateOptions({ ...providerOptions, releaseUnorderedHoldsAfterMinutes: 10_080 })
        .releaseUnorderedHoldsAfterMinutes,
    ).toBe(10_080);
    for (const value of [10_081, 35_792]) {
      expect(() =>
        validateOptions({ ...providerOptions, releaseUnorderedHoldsAfterMinutes: value }),
      ).toThrow("`releaseUnorderedHoldsAfterMinutes` must be a whole number");
    }
  });
});

describe("hold release: re-check", () => {
  it("deletes the session under the cart lock, so the provider cancels the hold", async () => {
    // Bug: the hold of a cart that never became an order stays AUTHORIZED.
    mock
      .onGet(`${API}/payments/pay_1`)
      .replyOnce(200, moneiPayment())
      .onGet(`${API}/payments/pay_1`)
      .replyOnce(200, moneiPayment({ status: "CANCELED" }));

    await runCheck();

    expect(deletePaymentSession).toHaveBeenCalledExactlyOnceWith("payses_1");
    const [key, { ownerId }] = acquire.mock.calls[0];
    expect(key).toBe("cart_1");
    expect(lockRelease).toHaveBeenCalledWith("cart_1", { ownerId });
    expect(ownerId).toEqual(expect.any(String));
    expect(logger.warn.mock.calls[0][0]).toMatch(/MONEI hold release: payment pay_1 .*cart_1/);
    expect(emit).not.toHaveBeenCalled();
  });

  it("waits for a cart locked by cart completion before it deletes the session", async () => {
    // Bug: the release runs without the lock and deletes the session that a running
    // cart completion is about to authorize.
    mock
      .onGet(`${API}/payments/pay_1`)
      .replyOnce(200, moneiPayment())
      .onGet(`${API}/payments/pay_1`)
      .replyOnce(200, moneiPayment({ status: "CANCELED" }));
    acquire.mockRejectedValueOnce(new Error('Failed to acquire lock for key "cart_1"'));
    deletePaymentSession.mockImplementation(() => {
      expect(acquire).toHaveBeenCalledTimes(2);
    });

    await runCheck();

    expect(deletePaymentSession).toHaveBeenCalledOnce();
    expect(emit).not.toHaveBeenCalled();
  });

  it("keeps the hold when the cart has an order", async () => {
    // Bug: an AUTH order left uncaptured past the delay loses its money.
    tables.order_cart.push({ order_id: "order_1", cart_id: "cart_1" });
    mock.onGet(`${API}/payments/pay_1`).reply(200, moneiPayment());

    await runCheck();

    expect(deletePaymentSession).not.toHaveBeenCalled();
    expect(cancels()).toHaveLength(0);
  });

  it("keeps the hold when the session now holds another payment", async () => {
    // Bug: the re-check deletes the buyer's new session and cancels the payment they just made.
    tables.payment_session[0].data = { id: "pay_2" };
    mock.onGet(`${API}/payments/pay_1`).reply(200, moneiPayment());

    await runCheck();

    expect(deletePaymentSession).not.toHaveBeenCalled();
  });

  it("does nothing when MONEI no longer shows the payment AUTHORIZED", async () => {
    // Bug: a payment the admin already captured is "released" and its session deleted.
    mock.onGet(`${API}/payments/pay_1`).reply(200, moneiPayment({ status: "SUCCEEDED" }));

    await runCheck();

    expect(deletePaymentSession).not.toHaveBeenCalled();
  });

  it("logs an error and emits monei.hold_release_failed when the cancel did not happen", async () => {
    // Bug: deletePayment swallows a refused cancel, and the hold stays with nobody told.
    mock.onGet(`${API}/payments/pay_1`).reply(200, moneiPayment());

    await runCheck();

    expect(deletePaymentSession).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledExactlyOnceWith({
      name: "monei.hold_release_failed",
      data: {
        payment_id: "pay_1",
        session_id: "payses_1",
        cart_id: "cart_1",
        amount: 22.5,
        currency: "EUR",
        reason: "the payment is AUTHORIZED after the cancel",
      },
    });
    expect(logger.error.mock.calls[0][0]).toContain("pay_1");
  });

  it("releases the cart lock and reports when the delete throws", async () => {
    // Bug: a thrown delete keeps the cart locked, and the next checkout of the cart waits out the TTL.
    mock.onGet(`${API}/payments/pay_1`).reply(200, moneiPayment());
    deletePaymentSession.mockRejectedValueOnce(new Error("db down"));

    await runCheck();

    expect(lockRelease).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith({
      name: "monei.hold_release_failed",
      data: expect.objectContaining({ payment_id: "pay_1", reason: "db down" }),
    });
  });
});
