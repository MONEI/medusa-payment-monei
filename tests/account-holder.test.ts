import MockAdapter from "axios-mock-adapter";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import MoneiCardService from "../src/providers/monei/services/monei-card";
import { moneiError } from "./helpers";

const API = "https://api.monei.com/v1";
const SESSION_ID = "payses_01";

const createdPayment = {
  id: "pay_1",
  amount: 1999,
  currency: "EUR",
  orderId: SESSION_ID,
  status: "PENDING",
};

let logger: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
let provider: MoneiCardService;
let mock: MockAdapter;

beforeEach(() => {
  logger = { warn: vi.fn(), info: vi.fn() };
  provider = new MoneiCardService(
    { logger },
    { apiKey: "pk_test_x", backendUrl: "https://shop.test" },
  );
  mock = new MockAdapter(provider["client_"].client);
});

const initiateWithHolder = (data: Record<string, unknown> = {}) =>
  provider.initiatePayment({
    amount: 19.99,
    currency_code: "eur",
    data: { session_id: SESSION_ID, save_card: true, ...data },
    context: { account_holder: { data: { id: "cus_1" } } },
  });

describe("createAccountHolder", () => {
  it("creates the MONEI customer from the Medusa customer and stores its id in data", async () => {
    // Bugs: a holder without `data.id` makes every card payment customer-less
    // (Medusa gives initiatePayment only `data`); missing contact fields.
    mock.onPost(`${API}/customers`).reply(200, { id: "cus_1", email: "ana@example.com" });

    const holder = await provider.createAccountHolder({
      context: {
        customer: {
          id: "cus_medusa",
          email: "ana@example.com",
          first_name: "Ana",
          last_name: "Silva",
          phone: "+34600000000",
          company_name: null,
        },
      },
    });

    expect(holder).toEqual({ id: "cus_1", data: { id: "cus_1" } });
    expect(JSON.parse(mock.history.post[0].data)).toEqual({
      email: "ana@example.com",
      name: "Ana Silva",
      phone: "+34600000000",
    });
  });
});

describe("deleteAccountHolder", () => {
  it("resolves when MONEI no longer has the customer", async () => {
    // Bug: Medusa deletes its row before this call, so a throw on 404 leaves
    // nothing to retry and fails the customer deletion for no reason.
    mock.onDelete(`${API}/customers/cus_1`).reply(404, moneiError(404));

    await expect(
      provider.deleteAccountHolder({ context: { account_holder: { data: { id: "cus_1" } } } }),
    ).resolves.toEqual({});
    expect(mock.history.delete).toHaveLength(1);
  });

  it("resolves on a 404 without a body", async () => {
    // Bug: the SDK builds an ApiException only from a response body; a check on
    // ApiException alone throws on a bare 404.
    mock.onDelete(`${API}/customers/cus_1`).reply(404);

    await expect(
      provider.deleteAccountHolder({ context: { account_holder: { data: { id: "cus_1" } } } }),
    ).resolves.toEqual({});
  });

  it("throws on a MONEI outage", async () => {
    // Bug: a catch-all would report a customer as deleted while MONEI still holds
    // it and its saved cards.
    mock.onDelete(`${API}/customers/cus_1`).reply(503, moneiError(503));

    await expect(
      provider.deleteAccountHolder({ context: { account_holder: { data: { id: "cus_1" } } } }),
    ).rejects.toMatchObject({ type: "unexpected_state" });
  });
});

describe("initiatePayment on a card session", () => {
  it("drops the customer and sets the flag when MONEI no longer has it", async () => {
    // Bug: sending a deleted customerId makes MONEI refuse every payment of a
    // shopper whose customer was deleted at MONEI only; the flag drives the
    // subscriber that removes the stale account holder.
    mock.onGet(`${API}/customers/cus_1`).reply(404, moneiError(404));
    mock.onPost(`${API}/payments`).reply(200, createdPayment);

    const result = await initiateWithHolder();

    const request = JSON.parse(mock.history.post[0].data);
    expect(request).not.toHaveProperty("customerId");
    expect(request).not.toHaveProperty("generatePaymentToken");
    expect(result.data?.monei_customer_missing).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("cus_1 no longer exists"));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("the card is not saved"));
  });

  it("links a live customer and ignores a storefront flag", async () => {
    // Bugs: a storefront `monei_customer_missing: true` that survives would make
    // the subscriber delete a live account holder; save card not requested.
    mock.onGet(`${API}/customers/cus_1`).reply(200, { id: "cus_1" });
    mock.onPost(`${API}/payments`).reply(200, createdPayment);

    const result = await initiateWithHolder({ monei_customer_missing: true });

    const request = JSON.parse(mock.history.post[0].data);
    expect(request.customerId).toBe("cus_1");
    expect(request.generatePaymentToken).toBe(true);
    expect(result.data?.monei_customer_missing).toBe(false);
  });

  it("does not save the card of a live customer who did not ask", async () => {
    // Bug: `generatePaymentToken` keyed on the customer alone saves every signed-in
    // shopper's card without consent.
    mock.onGet(`${API}/customers/cus_1`).reply(200, { id: "cus_1" });
    mock.onPost(`${API}/payments`).reply(200, createdPayment);

    await initiateWithHolder({ save_card: false });

    const request = JSON.parse(mock.history.post[0].data);
    expect(request.customerId).toBe("cus_1");
    expect(request).not.toHaveProperty("generatePaymentToken");
  });

  it("throws on a MONEI outage instead of dropping the customer", async () => {
    // Bug: treating any error as "missing" would flag a live customer, and the
    // subscriber path would then rely on a second check to not delete it.
    mock.onGet(`${API}/customers/cus_1`).reply(503, moneiError(503));

    await expect(initiateWithHolder()).rejects.toMatchObject({ type: "unexpected_state" });
    expect(mock.history.post).toHaveLength(0);
  });

  it("sends no customer lookup for a guest", async () => {
    // Bug: a lookup of an undefined id 404s and flags every guest session as a
    // stale customer.
    mock.onPost(`${API}/payments`).reply(200, createdPayment);

    const result = await provider.initiatePayment({
      amount: 19.99,
      currency_code: "eur",
      data: { session_id: SESSION_ID, save_card: true },
    });

    expect(mock.history.get).toHaveLength(0);
    expect(JSON.parse(mock.history.post[0].data)).not.toHaveProperty("generatePaymentToken");
    expect(result.data?.monei_customer_missing).toBe(false);
    // Bug: the storefront's save request vanished without a trace.
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("the card is not saved"));
  });
});

describe("payment methods", () => {
  const TOKEN = "tok_permanent_1";
  // sha256 of TOKEN, the id GET /store/monei/payment-methods returns.
  const OPAQUE_ID = "185f00929453d1604e29bb2ae61dfa996b6e3eaaecf5eb00121a6acc2cb0bec5";
  const context = { account_holder: { data: { id: "cus_1" } } };

  beforeEach(() => {
    mock.onGet(`${API}/customers/cus_1/payment-methods`).reply(200, [
      {
        id: TOKEN,
        type: "STICKY",
        paymentMethod: {
          method: "card",
          card: { brand: "visa", last4: "4242", expiration: 1924991999 },
        },
      },
    ]);
  });

  it("lists the opaque id and display fields, never the token", async () => {
    // Bug: merchant code that returns the module result sends a permanent token to the browser.
    const methods = await provider.listPaymentMethods({ context });

    expect(methods).toEqual([
      { id: OPAQUE_ID, data: { brand: "visa", last4: "4242", expires_at: 1924991999 } },
    ]);
    expect(JSON.stringify(methods)).not.toContain(TOKEN);
  });

  it("deletes the token that the opaque id maps to", async () => {
    // Bug: the opaque id sent to MONEI as the token, or the customer id and token swapped.
    mock.onDelete(`${API}/customers/cus_1/payment-methods/${TOKEN}`).reply(200, { success: true });

    await provider.deletePaymentMethod({ context, data: { id: OPAQUE_ID } });

    expect(mock.history.delete).toHaveLength(1);
  });

  it.each([
    ["an id not in the customer's list", "f".repeat(64)],
    ["the raw token", TOKEN],
  ])("refuses %s without a delete call", async (_, id) => {
    // Bug: a guessed or leaked id deletes a card the customer does not hold.
    await expect(provider.deletePaymentMethod({ context, data: { id } })).rejects.toMatchObject({
      type: "not_found",
    });
    expect(mock.history.delete).toHaveLength(0);
  });
});
