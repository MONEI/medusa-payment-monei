import type { InitiatePaymentInput } from "@medusajs/framework/types";
import MockAdapter from "axios-mock-adapter";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { moneiError, TestProvider } from "./helpers";

const PAYMENTS = "https://api.monei.com/v1/payments";
const SESSION_ID = "payses_01";

const createdPayment = {
  id: "pay_1",
  amount: 1999,
  currency: "EUR",
  orderId: SESSION_ID,
  status: "PENDING",
  nextAction: { type: "CONFIRM", redirectUrl: "https://secure.monei.com/payments/pay_1" },
};

let logger: Record<"warn" | "info" | "error", ReturnType<typeof vi.fn>>;
let provider: TestProvider;
let mock: MockAdapter;
let paymentSessionService: { list: ReturnType<typeof vi.fn> };

beforeEach(() => {
  logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  // The session row as the payment module stores it: not yet authorized.
  paymentSessionService = {
    list: vi.fn(async ({ id }: { id: string }) =>
      id === SESSION_ID ? [{ id, authorized_at: null }] : [],
    ),
  };
  provider = new TestProvider(
    { logger, paymentSessionService },
    { apiKey: "pk_test_x", backendUrl: "https://shop.test/medusa/" },
  );
  mock = new MockAdapter(provider["client_"].client);
});

const initiate = (input: Partial<InitiatePaymentInput> = {}) =>
  provider.initiatePayment({
    amount: 19.99,
    currency_code: "eur",
    ...input,
    data: { session_id: SESSION_ID, ...input.data },
  });

const sentRequest = () => JSON.parse(mock.history.post[0].data);

describe("initiatePayment", () => {
  it("sends only plugin-built fields, ignoring injected storefront keys", async () => {
    // Bugs: major units sent as cents; a spread of storefront data that
    // lets a buyer pick the amount, the payment methods, a saved token (charge
    // before "Place order") or metadata (rewrites the session binding); a
    // lowercase country that MONEI routing does not match; a cancelUrl equal to the
    // completeUrl, so the return page cannot tell a cancel from a pending payment.
    mock.onPost(PAYMENTS).reply(200, createdPayment);

    await initiate({
      data: {
        session_id: SESSION_ID,
        return_url: "https://shop.test/es/checkout/monei/return?step=review",
        amount: 1,
        id: "pay_injected",
        paymentToken: "tok_permanent",
        allowedPaymentMethods: ["bizum"],
        sessionId: "ms_injected",
        metadata: { session_id: "payses_other" },
        monei_customer_missing: true,
      },
      context: {
        customer: {
          id: "cus_1",
          email: "ana@example.com",
          first_name: "Ana",
          last_name: "Silva",
          phone: null,
          billing_address: {
            first_name: "Ana",
            last_name: "Silva",
            address_1: "Rua Augusta 1",
            city: "Lisboa",
            postal_code: "1100-048",
            country_code: "pt",
          } as never,
        },
      },
    });

    const returnUrl = "https://shop.test/es/checkout/monei/return?step=review&session_id=payses_01";
    expect(sentRequest()).toEqual({
      amount: 1999,
      currency: "EUR",
      orderId: SESSION_ID,
      allowedPaymentMethods: ["card"],
      transactionType: "SALE",
      callbackUrl: "https://shop.test/medusa/hooks/payment/monei_monei",
      completeUrl: returnUrl,
      failUrl: returnUrl,
      cancelUrl: `${returnUrl}&monei_canceled=1`,
      customer: { email: "ana@example.com", name: "Ana Silva" },
      billingDetails: {
        name: "Ana Silva",
        email: "ana@example.com",
        address: { country: "PT", city: "Lisboa", line1: "Rua Augusta 1", zip: "1100-048" },
      },
    });
  });

  it("sends AUTH when capture is false and the provider allows it", async () => {
    // Bug: `capture: false` ignored, so card and PayPal charge at once.
    const authProvider = new TestProvider(
      { logger },
      { apiKey: "pk_test_x", backendUrl: "https://shop.test", capture: false },
    );
    mock = new MockAdapter(authProvider["client_"].client);
    mock.onPost(PAYMENTS).reply(200, createdPayment);

    await authProvider.initiatePayment({
      amount: 19.99,
      currency_code: "eur",
      data: { session_id: SESSION_ID },
    });

    expect(sentRequest().transactionType).toBe("AUTH");
  });

  it("sends sessionId from monei_session_id", async () => {
    // Bug: a monei.js token bound to a sessionId confirms only a payment created
    // with the same sessionId (MONEI E206), so embedded and express checkout fail.
    mock.onPost(PAYMENTS).reply(200, createdPayment);

    await initiate({ data: { monei_session_id: "ms_1" } });

    expect(sentRequest().sessionId).toBe("ms_1");
  });

  it("returns exactly the explicit data keys", async () => {
    // Bug: Medusa stores `{...data, ...providerData}`; a key the provider omits
    // keeps the storefront value, e.g. an injected `id` or a forged flag.
    mock.onPost(PAYMENTS).reply(200, createdPayment);

    const result = await initiate({
      data: { id: "pay_injected", amount: 1, paymentToken: "tok", monei_customer_missing: true },
    });

    expect(result.id).toBe("pay_1");
    expect(result.status).toBe("pending");
    expect(result.data).toEqual({
      id: "pay_1",
      session_id: SESSION_ID,
      amount: 19.99,
      currency: "EUR",
      status: "PENDING",
      redirect_url: "https://secure.monei.com/payments/pay_1",
      monei_customer_missing: false,
    });
  });

  it("refuses an expected_amount in minor units", async () => {
    // Bug: express sends the wallet amount in major units; comparing it with the
    // minor-unit request amount accepts 1800 for an 18.00 cart.
    await expect(initiate({ amount: 18, data: { expected_amount: 1800 } })).rejects.toMatchObject({
      type: "invalid_data",
    });
    expect(mock.history.post).toHaveLength(0);
  });

  it("accepts the 2-decimal wallet amount of a session amount with more decimals", async () => {
    // Bug: 4.99 + 21% tax is 6.0379 in Medusa; the wallet shows 6.04, and an exact
    // compare refused every express payment of such a cart.
    mock.onPost(PAYMENTS).reply(200, createdPayment);

    await initiate({ amount: 6.0379, data: { expected_amount: "6.04" } });

    expect(sentRequest().amount).toBe(604);
  });

  it("refuses a non-numeric expected_amount as invalid data", async () => {
    // Bug: a raw BigNumber error reaches the storefront as a server error.
    await expect(initiate({ data: { expected_amount: "abc" } })).rejects.toMatchObject({
      type: "invalid_data",
    });
    expect(mock.history.post).toHaveLength(0);
  });

  it("refuses a relative return_url before calling MONEI", async () => {
    // Bug: MONEI refuses the payment later with a less clear error, or sends the
    // buyer back to a broken URL.
    await expect(initiate({ data: { return_url: "/checkout" } })).rejects.toMatchObject({
      type: "invalid_data",
    });
    expect(mock.history.post).toHaveLength(0);
  });

  it("sends a guest's billing_country in uppercase", async () => {
    // Bug: a guest sent no country, so MONEI routed by the buyer's IP country.
    mock.onPost(PAYMENTS).reply(200, createdPayment);

    await initiate({ data: { billing_country: "pt" } });

    expect(sentRequest().billingDetails).toEqual({ address: { country: "PT" } });
    expect(sentRequest()).not.toHaveProperty("customer");
  });

  it("sends only the checkout country when the saved address is in another country", async () => {
    // Bugs: the customer's default address country decided the routing although the
    // buyer checks out with another billing country; its street sent with that country.
    mock.onPost(PAYMENTS).reply(200, createdPayment);

    await initiate({
      data: { billing_country: "PT" },
      context: {
        customer: {
          id: "cus_1",
          email: "ana@example.com",
          billing_address: {
            address_1: "Calle Mayor 1",
            city: "Madrid",
            country_code: "es",
          } as never,
        },
      },
    });

    expect(sentRequest().billingDetails).toEqual({
      email: "ana@example.com",
      address: { country: "PT" },
    });
  });

  it.each([["ESP"], [["ES"]]])(
    "refuses billing_country %j before calling MONEI",
    async (billing_country) => {
      // Bug: a storefront value MONEI routing cannot match, or an object, reaches the request.
      await expect(initiate({ data: { billing_country } })).rejects.toMatchObject({
        type: "invalid_data",
      });
      expect(mock.history.post).toHaveLength(0);
    },
  );

  it.each([
    [400, "invalid_data"],
    // Bug: a MONEI outage reported as bad input tells the buyer to fix their data.
    [503, "unexpected_state"],
  ])("maps a MONEI %i to %s with statusCode and requestId", async (status, type) => {
    mock.onPost(PAYMENTS).reply(status, moneiError(status));

    const error = await initiate().catch((e) => e);

    expect(error).toMatchObject({ type });
    expect(error.message).toContain(`statusCode: ${status}`);
    expect(error.message).toContain("requestId: req_123");
  });

  it("maps a refused API key to invalid_data with its HTTP status", async () => {
    // Bug: MONEI answers a bad key with a body that has no statusCode; the SDK
    // builds the ApiException from the body alone, so the 401 was reported as an
    // outage (unexpected_state) with no status.
    mock.onPost(PAYMENTS).reply(401, { message: "Unauthorized" });

    const error = await initiate().catch((e) => e);

    expect(error).toMatchObject({ type: "invalid_data" });
    expect(error.message).toContain("statusCode: 401");
  });

  it("maps a network error to unexpected_state", async () => {
    // Bug: the SDK rethrows a bodiless failure as a raw axios error; reading only
    // ApiException fields would lose the type.
    mock.onPost(PAYMENTS).networkError();

    await expect(initiate()).rejects.toMatchObject({ type: "unexpected_state" });
  });
});

describe("updatePayment", () => {
  it("returns the incoming data unchanged, client included", async () => {
    // Bug: rebuilding data drops `data.client`, the only thing Medusa's
    // updatePaymentSessionClientDataWorkflow sends.
    // The session amount keeps extra decimals from tax maths; the stored amount
    // is rounded. Bug: an exact compare throws on every client-data update.
    const data = { id: "pay_1", amount: 19.99, currency: "EUR", client: { name: "Ana" } };

    await expect(
      provider.updatePayment({ amount: 19.9940001, currency_code: "eur", data }),
    ).resolves.toEqual({ data });
  });

  it("refuses an amount change", async () => {
    // Bug: accepting it records a new amount in Medusa while MONEI charges the old one.
    await expect(
      provider.updatePayment({
        amount: 25,
        currency_code: "eur",
        data: { amount: 19.99, currency: "EUR" },
      }),
    ).rejects.toMatchObject({ type: "invalid_data" });
  });
});

describe("deletePayment", () => {
  const sessionData = { id: "pay_1", session_id: SESSION_ID };

  it.each(["AUTHORIZED", "PENDING"])(
    "cancels a %s payment of this session once",
    async (status) => {
      // Bugs: a payment page left open after a cart change stays payable; PENDING
      // is cancelable at MONEI although the openapi text says AUTHORIZED only.
      mock.onGet(`${PAYMENTS}/pay_1`).reply(200, { ...createdPayment, status });
      mock.onPost(`${PAYMENTS}/pay_1/cancel`).reply(200, { ...createdPayment, status: "CANCELED" });

      await provider.deletePayment({ data: sessionData });

      expect(mock.history.post).toHaveLength(1);
      expect(JSON.parse(mock.history.post[0].data)).toEqual({
        cancellationReason: "requested_by_customer",
      });
    },
  );

  it("does not cancel an injected id whose orderId is another session", async () => {
    // Bug: deletePayment canceled a payment that belongs to another session.
    mock.onGet(`${PAYMENTS}/pay_1`).reply(200, { ...createdPayment, orderId: "payses_other" });

    await provider.deletePayment({ data: sessionData });

    expect(mock.history.post).toHaveLength(0);
  });

  it("does not cancel the payment of an authorized session", async () => {
    // Bug (external review): deletePayment could void the hold of a placed order.
    mock.onGet(`${PAYMENTS}/pay_1`).reply(200, { ...createdPayment, status: "AUTHORIZED" });
    paymentSessionService.list.mockResolvedValue([
      { id: SESSION_ID, authorized_at: new Date("2026-11-13T10:00:00Z") },
    ]);

    await expect(provider.deletePayment({ data: sessionData })).resolves.toEqual({});

    expect(mock.history.post).toHaveLength(0);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/payses_01.*is authorized/));
  });

  it("does not cancel when the named session no longer exists", async () => {
    // Bug: the session_id of a deleted session still reached the cancel.
    mock.onGet(`${PAYMENTS}/pay_1`).reply(200, createdPayment);
    paymentSessionService.list.mockResolvedValue([]);

    await provider.deletePayment({ data: sessionData });

    expect(mock.history.post).toHaveLength(0);
  });

  it("does not cancel and resolves when the session lookup fails", async () => {
    // Bug: a lookup error either cancels unchecked or throws into every cart change.
    mock.onGet(`${PAYMENTS}/pay_1`).reply(200, createdPayment);
    paymentSessionService.list.mockRejectedValue(new Error("db down"));

    await expect(provider.deletePayment({ data: sessionData })).resolves.toEqual({});
    expect(mock.history.post).toHaveLength(0);
  });

  it("does nothing without a payment id", async () => {
    await provider.deletePayment({ data: { session_id: SESSION_ID } });

    expect(mock.history.get).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("resolves without retry when MONEI refuses the cancel", async () => {
    // Bug: a throw fails validateDeletedPaymentSessionsStep on every later cart
    // change (MONEI refuses to cancel some pending payments).
    mock.onGet(`${PAYMENTS}/pay_1`).reply(200, createdPayment);
    mock.onPost(`${PAYMENTS}/pay_1/cancel`).reply(400, moneiError(400));

    await expect(provider.deletePayment({ data: sessionData })).resolves.toEqual({});
    expect(mock.history.get).toHaveLength(1);
    expect(mock.history.post).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("pay_1"));
  });

  it("logs an error and does not cancel a SUCCEEDED payment", async () => {
    // Bug: money taken for a deleted session left only a debug trace.
    mock.onGet(`${PAYMENTS}/pay_1`).reply(200, { ...createdPayment, status: "SUCCEEDED" });

    await expect(provider.deletePayment({ data: sessionData })).resolves.toEqual({});
    expect(mock.history.post).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/pay_1 of 19\.99 EUR is SUCCEEDED but its session payses_01/),
    );
  });

  it("logs an error when an AUTHORIZED payment refuses the cancel", async () => {
    // Bug: a held authorization left behind blocks the buyer's money for days.
    mock.onGet(`${PAYMENTS}/pay_1`).reply(200, { ...createdPayment, status: "AUTHORIZED" });
    mock.onPost(`${PAYMENTS}/pay_1/cancel`).reply(400, moneiError(400));

    await provider.deletePayment({ data: sessionData });

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/pay_1.*19\.99 EUR, session payses_01/),
    );
  });

  it("resolves without retry when the GET fails", async () => {
    mock.onGet(`${PAYMENTS}/pay_1`).reply(503, moneiError(503));

    await expect(provider.deletePayment({ data: sessionData })).resolves.toEqual({});
    expect(mock.history.get).toHaveLength(1);
    expect(mock.history.post).toHaveLength(0);
  });
});
