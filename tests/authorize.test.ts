import MockAdapter from "axios-mock-adapter";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { TestProvider } from "./helpers";

const SESSION_ID = "payses_01";
const PAYMENT = "https://api.monei.com/v1/payments/pay_1";

const storedData = {
  id: "pay_1",
  session_id: SESSION_ID,
  amount: 19.99,
  currency: "EUR",
  status: "PENDING",
  redirect_url: "https://secure.monei.com/payments/pay_1",
  monei_customer_missing: true,
};

const fetched = (overrides: Record<string, unknown> = {}) => ({
  id: "pay_1",
  amount: 1999,
  currency: "EUR",
  orderId: SESSION_ID,
  status: "SUCCEEDED",
  // MONEI returns the saved token on every save-card payment.
  paymentToken: "tok_permanent",
  ...overrides,
});

const capturedData = {
  id: "pay_1",
  session_id: SESSION_ID,
  amount: 19.99,
  currency: "EUR",
  status: "SUCCEEDED",
  redirect_url: undefined,
  monei_customer_missing: true,
};

// Session data stored by 0.1.x: minor-unit `amount`, a stale status, `client_secret`.
const legacyData = {
  id: "pay_1",
  status: "PENDING",
  amount: 1999,
  currency: "EUR",
  session_id: SESSION_ID,
  redirect_url: null,
  client_secret: "pay_1",
};

const fromLegacy = { ...capturedData, monei_customer_missing: false };

let logger: Record<"warn" | "info" | "error", ReturnType<typeof vi.fn>>;
let provider: TestProvider;
let mock: MockAdapter;
let paymentSessionService: { list: ReturnType<typeof vi.fn> };

/** The Medusa session as the payment module stores it: lowercase currency, major units. */
const medusaSession = (overrides: Record<string, unknown> = {}) => ({
  id: SESSION_ID,
  amount: 19.99,
  currency_code: "eur",
  ...overrides,
});

beforeEach(() => {
  logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  paymentSessionService = {
    list: vi.fn(async ({ id }: { id: string }) => (id === SESSION_ID ? [medusaSession()] : [])),
  };
  provider = new TestProvider(
    { logger, paymentSessionService },
    { apiKey: "pk_test_x", backendUrl: "https://shop.test" },
  );
  mock = new MockAdapter(provider["client_"].client);
});

const authorize = () =>
  provider.authorizePayment({ data: storedData, context: { idempotency_key: SESSION_ID } });

describe("authorizePayment", () => {
  it("returns captured with explicit data for a matching SUCCEEDED payment", async () => {
    // Bugs: returning the fetched payment leaks `paymentToken` through the store
    // cart API; dropping `monei_customer_missing` stops the stale-customer cleanup.
    mock.onGet(PAYMENT).reply(200, fetched());

    await expect(authorize()).resolves.toEqual({ status: "captured", data: capturedData });
  });

  it("returns error for a payment bound to another session and keeps its data out", async () => {
    // Bug: an injected `data.id` of another paid session authorizes this cart, or
    // its redirect URL and amount get stored on this session.
    mock.onGet(PAYMENT).reply(
      200,
      fetched({
        orderId: "payses_other",
        amount: 50000,
        nextAction: { redirectUrl: "https://secure.monei.com/payments/other" },
      }),
    );

    await expect(authorize()).resolves.toEqual({ status: "error", data: storedData });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("payses_other"));
  });

  it("returns error when neither the payment nor the context names a session", async () => {
    // Bug: `undefined !== undefined` is false, so the binding check passes.
    mock.onGet(PAYMENT).reply(200, fetched({ orderId: undefined }));

    await expect(provider.authorizePayment({ data: storedData })).resolves.toMatchObject({
      status: "error",
    });
  });

  it("returns error for a REFUNDED payment", async () => {
    // Bug: an order created for money that was already returned.
    mock.onGet(PAYMENT).reply(200, fetched({ status: "REFUNDED" }));

    await expect(authorize()).resolves.toMatchObject({ status: "error" });
  });

  it("returns error for a payment of the session in another currency", async () => {
    // Bug: 1999 USD (or any currency) completes a 19.99 EUR cart.
    mock.onGet(PAYMENT).reply(200, fetched({ currency: "USD" }));

    await expect(authorize()).resolves.toEqual({ status: "error", data: storedData });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("USD"));
  });

  it("authorizes when the session amount has tax decimals that round to the MONEI amount", async () => {
    // Bug: comparing 6.0379 with 6.04 unrounded refuses every express checkout with tax.
    paymentSessionService.list.mockResolvedValue([medusaSession({ amount: 6.0379 })]);
    mock.onGet(PAYMENT).reply(200, fetched({ amount: 604 }));

    await expect(authorize()).resolves.toMatchObject({ status: "captured" });
  });

  it("throws when the session cannot be read", async () => {
    // Bug: a failed lookup skips the amount check and authorizes any amount.
    paymentSessionService.list.mockRejectedValue(new Error("db down"));
    mock.onGet(PAYMENT).reply(200, fetched());

    await expect(authorize()).rejects.toThrow("db down");
  });

  it("throws when the session is not found", async () => {
    // Bug: `undefined` session amount treated as a match.
    paymentSessionService.list.mockResolvedValue([]);
    mock.onGet(PAYMENT).reply(200, fetched());

    await expect(authorize()).rejects.toMatchObject({ type: "unexpected_state" });
  });

  it("throws when MONEI answers with an error", async () => {
    // Bug: an API error reported as `pending` makes Medusa wait forever.
    mock.onGet(PAYMENT).reply(503, { statusCode: 503, message: "Unavailable" });

    await expect(authorize()).rejects.toMatchObject({ type: "unexpected_state" });
  });
});

describe("getPaymentStatus", () => {
  it("maps the fetched status and returns explicit data", async () => {
    // Bug: returning the fetched payment (Stripe pattern) leaks `paymentToken`.
    mock.onGet(PAYMENT).reply(200, fetched());

    await expect(provider.getPaymentStatus({ data: storedData })).resolves.toEqual({
      status: "captured",
      data: capturedData,
    });
  });
});

describe("retrievePayment", () => {
  it("returns explicit data in major units", async () => {
    // Bugs: the fetched payment with `paymentToken` and a minor-unit amount.
    mock.onGet(PAYMENT).reply(200, fetched());

    await expect(provider.retrievePayment({ data: storedData })).resolves.toEqual({
      data: capturedData,
    });
  });
});

describe("0.1.x session data", () => {
  it("authorizes a 0.1.x payment bound to the session and returns v1 data", async () => {
    // Bugs: a checkout open at the upgrade cannot complete; `client_secret` or the
    // stored minor `amount` stays in data the store cart API returns.
    mock.onGet(PAYMENT).reply(200, fetched());

    await expect(
      provider.authorizePayment({ data: legacyData, context: { idempotency_key: SESSION_ID } }),
    ).resolves.toEqual({ status: "captured", data: fromLegacy });
  });

  it("refuses a 0.1.x payment whose order id is not the session id", async () => {
    // 0.1.x used a generated `medusa_...` order id when Medusa sent no session id,
    // and stored that id as `session_id`. Bug: binding to the stored `session_id`
    // instead of the session Medusa authorizes lets session data name any payment.
    const orphan = { ...legacyData, session_id: "medusa_1762970000_abc" };
    mock.onGet(PAYMENT).reply(200, fetched({ orderId: "medusa_1762970000_abc" }));

    await expect(
      provider.authorizePayment({ data: orphan, context: { idempotency_key: SESSION_ID } }),
    ).resolves.toMatchObject({ status: "error", data: { session_id: "medusa_1762970000_abc" } });
  });

  it("refuses a 0.1.x payment of 1/100 of the session amount", async () => {
    // 0.1.x sent the Medusa amount as cents: a 19.99 EUR cart made a 20-cent payment.
    // Bug: Medusa records the session amount, so 0.20 EUR completes a 19.99 EUR order.
    mock.onGet(PAYMENT).reply(200, fetched({ amount: 20 }));

    await expect(
      provider.authorizePayment({ data: legacyData, context: { idempotency_key: SESSION_ID } }),
    ).resolves.toMatchObject({ status: "error", data: { amount: 1999, status: "PENDING" } });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("refund it"));
  });

  it("maps the status MONEI returns, not the stored 0.1.x status", async () => {
    // Bug: the stored minor `amount` (1999) or `client_secret` returned in the data.
    mock.onGet(PAYMENT).reply(200, fetched());

    await expect(provider.getPaymentStatus({ data: legacyData })).resolves.toEqual({
      status: "captured",
      data: fromLegacy,
    });
  });
});
