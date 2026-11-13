import MockAdapter from "axios-mock-adapter";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { API_KEY, hmac, sign, T, TestProvider } from "./helpers";

const SESSION_ID = "payses_01";
const PAYMENT = "https://api.monei.com/v1/payments/pay_1";

// The callback body MONEI posts is a Payment.
const body = JSON.stringify({ id: "pay_1", status: "SUCCEEDED", orderId: SESSION_ID });

const fetched = (overrides: Record<string, unknown> = {}) => ({
  id: "pay_1",
  amount: 1999,
  currency: "EUR",
  orderId: SESSION_ID,
  status: "SUCCEEDED",
  ...overrides,
});

const NOT_SUPPORTED = { action: "not_supported" };

let logger: Record<"warn" | "info" | "error", ReturnType<typeof vi.fn>>;
let provider: TestProvider;
let mock: MockAdapter;
let paymentSessionService: { list: ReturnType<typeof vi.fn> };

beforeEach(() => {
  logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  // Only SESSION_ID exists in Medusa.
  paymentSessionService = {
    list: vi.fn(async ({ id }: { id: string }) => (id === SESSION_ID ? [{ id }] : [])),
  };
  provider = new TestProvider(
    { logger, paymentSessionService },
    { apiKey: API_KEY, backendUrl: "https://shop.test" },
  );
  mock = new MockAdapter(provider["client_"].client);
  mock.onGet(PAYMENT).reply(200, fetched());
});

const webhook = (rawData: unknown, headers: Record<string, unknown>) =>
  provider.getWebhookActionAndData({
    // Medusa's parsed body; never trusted, so it names another payment and session.
    data: { id: "pay_other", status: "SUCCEEDED", orderId: "payses_other" },
    rawData: rawData as string,
    headers,
  });

describe("getWebhookActionAndData: signature", () => {
  it("takes session, status and amount from the fetched payment for a valid signature", async () => {
    // Bugs: session id from the body or metadata (a signed callback of one session
    // completes another cart); amount sent as 1999 major units.
    const raw = JSON.stringify({
      id: "pay_1",
      status: "SUCCEEDED",
      amount: 50000,
      orderId: "payses_other",
      metadata: { session_id: "payses_other" },
    });

    await expect(webhook(raw, { "monei-signature": sign(raw) })).resolves.toEqual({
      action: "captured",
      data: { session_id: SESSION_ID, amount: 19.99 },
    });
  });

  it("accepts the header name in uppercase", async () => {
    // Bug: an exact-case lookup drops every callback from a proxy that keeps the case.
    await expect(webhook(body, { "MONEI-SIGNATURE": sign(body) })).resolves.toEqual({
      action: "captured",
      data: { session_id: SESSION_ID, amount: 19.99 },
    });
  });

  it("accepts rawData as a JSON-serialized Buffer", async () => {
    // Bug: the event bus serializes the Buffer and only the core subscriber
    // rebuilds it; any other caller would have every callback refused.
    const serialized = JSON.parse(JSON.stringify(Buffer.from(body)));

    await expect(webhook(serialized, { "monei-signature": sign(body) })).resolves.toEqual({
      action: "captured",
      data: { session_id: SESSION_ID, amount: 19.99 },
    });
  });

  it.each([
    // Bug: the signature is checked against a body other than the one used.
    ["a tampered body", body.replace("pay_1", "pay_2"), { "monei-signature": sign(body) }],
    ["an HMAC made with another key", body, { "monei-signature": sign(body, "pk_test_other") }],
    ["a missing header", body, {}],
    // Bug: unwrapping or joining the array accepts a duplicated header.
    ["the header as an array", body, { "monei-signature": [sign(body)] }],
    ["t only", body, { "monei-signature": `t=${T}` }],
    ["v1 only", body, { "monei-signature": `v1=${hmac(body)}` }],
    // Bug: re-stringifying a parsed body verifies a body MONEI never signed.
    ["rawData as a parsed object", JSON.parse(body), { "monei-signature": sign(body) }],
    // Bug: an empty body signs as `<t>.` and would pass the HMAC check.
    ["empty rawData", "", { "monei-signature": sign("") }],
  ])("refuses %s without fetching the payment", async (_, rawData, headers) => {
    await expect(webhook(rawData, headers)).resolves.toEqual(NOT_SUPPORTED);
    expect(mock.history.get).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});

describe("getWebhookActionAndData: fetched payment", () => {
  it("returns pending when the body says SUCCEEDED but MONEI says PENDING", async () => {
    // Bug: status from the body; a forged or stale body would complete the cart.
    mock.onGet(PAYMENT).reply(200, fetched({ status: "PENDING" }));

    await expect(webhook(body, { "monei-signature": sign(body) })).resolves.toEqual({
      action: "pending",
      data: { session_id: SESSION_ID, amount: 19.99 },
    });
  });

  it("returns not_supported for a payment without a Medusa session", async () => {
    // Bugs: a payment of another integration on the same account is processed;
    // converting its amount first throws on a non-2-decimal currency, so the
    // event bus retries a callback that can never succeed.
    mock.onGet(PAYMENT).reply(200, fetched({ orderId: "wc_123", currency: "JPY" }));

    await expect(webhook(body, { "monei-signature": sign(body) })).resolves.toEqual(NOT_SUPPORTED);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("wc_123"));
  });

  it("returns not_supported when the payment's session no longer exists", async () => {
    // Bug: a late AUTHORIZED callback of a deleted session reached core and could
    // complete the wrong cart.
    mock.onGet(PAYMENT).reply(200, fetched({ orderId: "payses_deleted", status: "AUTHORIZED" }));

    await expect(webhook(body, { "monei-signature": sign(body) })).resolves.toEqual(NOT_SUPPORTED);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("payses_deleted"));
  });

  it("throws when the payment cannot be fetched", async () => {
    // Bug: returning not_supported drops a paid callback; a throw lets the event bus retry.
    mock.onGet(PAYMENT).reply(503, { message: "Service Unavailable" });

    await expect(webhook(body, { "monei-signature": sign(body) })).rejects.toMatchObject({
      type: "unexpected_state",
    });
  });
});

// An account-webhook event from a MONEI dashboard webhook: its own id is the event
// id; `object` is the charge (the payment).
const envelope = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "evt_1",
    type: "charge.succeeded",
    livemode: false,
    accountId: "acc_1",
    objectType: "charge",
    objectId: "pay_1",
    createdAt: 1762970000,
    // Never trusted: a stale status, another session and another amount.
    object: { id: "pay_1", status: "PENDING", orderId: "payses_other", amount: 50000 },
    ...overrides,
  });

const fetchedUrls = () => mock.history.get.map((request) => request.url);

describe("getWebhookActionAndData: account-webhook event", () => {
  it("fetches the event's payment, never the event id", async () => {
    // Bug: the event id is fetched as a payment id (404, the event bus retries
    // forever) or the envelope's charge fields are used as the payment.
    const raw = envelope();

    await expect(webhook(raw, { "monei-signature": sign(raw) })).resolves.toEqual({
      action: "captured",
      data: { session_id: SESSION_ID, amount: 19.99 },
    });
    expect(fetchedUrls()).toEqual([PAYMENT]);
  });

  it.each([
    // Bug: a payment body with an `object` field is read as an envelope.
    ["an object with another id", { object: { id: "pay_other" } }],
    [
      "a whole charge event",
      { object: JSON.parse(envelope({ objectId: "pay_other", object: { id: "pay_other" } })) },
    ],
  ])("fetches the payment's own id from a payment body with %s", async (_, extra) => {
    const raw = JSON.stringify({ id: "pay_1", status: "SUCCEEDED", orderId: SESSION_ID, ...extra });

    await expect(webhook(raw, { "monei-signature": sign(raw) })).resolves.toMatchObject({
      action: "captured",
    });
    expect(fetchedUrls()).toEqual([PAYMENT]);
  });

  it.each([
    // Bug: a subscription or account event names the same id and is fetched as a payment.
    [
      "an event for a non-payment object",
      envelope({ type: "subscription.activated", objectType: "subscription" }),
      "objectType subscription",
    ],
    // Bug: a loose compare accepts an objectType MONEI does not send for payments.
    ["objectType in another case", envelope({ objectType: "Charge" }), "objectType Charge"],
    // Bug: a typeof check sends a null objectType down the payment path and fetches the event id.
    ["a null objectType", envelope({ objectType: null }), "objectType null"],
    ["an event without objectId", envelope({ objectId: undefined }), "no objectId"],
    // Bug: one id is checked and the other fetched.
    [
      "objectId that differs from the object id",
      envelope({ object: { id: "pay_2" } }),
      "does not match",
    ],
    // Bug: reading object.id without a check throws, and the event bus retries a bad event.
    ["an event without object", envelope({ object: undefined }), "does not match"],
    // Bug: the dashboard's test request reaches the payment API with no id.
    ["the dashboard test request", JSON.stringify({ type: "webhook.test" }), "no payment id"],
    // Bug: the objectType check throws on a signed primitive instead of refusing it.
    ["a signed null", "null", "not a JSON object"],
  ])("refuses %s without fetching", async (_, raw, reason) => {
    await expect(webhook(raw, { "monei-signature": sign(raw) })).resolves.toEqual(NOT_SUPPORTED);
    expect(mock.history.get).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(reason));
  });

  it.each([
    // Bug: the signature is checked against a body other than the one used.
    [
      "an envelope changed after signing",
      envelope({ objectId: "pay_2", object: { id: "pay_2" } }),
      sign(envelope()),
    ],
    // Bug: the inner object is verified while the envelope is read, or the reverse.
    [
      "an envelope signed over its inner object",
      envelope(),
      sign(JSON.stringify(JSON.parse(envelope()).object)),
    ],
    [
      "an inner object signed as the envelope",
      JSON.stringify(JSON.parse(envelope()).object),
      sign(envelope()),
    ],
  ])("refuses %s without fetching", async (_, raw, signature) => {
    await expect(webhook(raw, { "monei-signature": signature })).resolves.toEqual(NOT_SUPPORTED);
    expect(mock.history.get).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("signature verification failed"),
    );
  });
});
