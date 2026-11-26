import MockAdapter from "axios-mock-adapter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { clearCredentialsCache } from "../src/providers/monei/core/credentials";
import { API_KEY, hmac, MONEI_PAYMENT_ID, sign, signV2, T, TestProvider } from "./helpers";

const mocks = vi.hoisted(() => new Map<string, MockAdapter>());
vi.mock("../src/providers/monei/core/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/providers/monei/core/client")>();
  return {
    ...actual,
    createMoneiClient: (options: Parameters<typeof actual.createMoneiClient>[0]) => {
      const client = actual.createMoneiClient(options);
      mocks.set(options.apiKey, new MockAdapter(client.client));
      return client;
    },
  };
});

const SESSION_ID = "payses_01";
const PAYMENT = `https://api.monei.com/v1/payments/${MONEI_PAYMENT_ID}`;
const OTHER_ID = "abcdef0123456789abcdef0123456789abcdef01";
const LIVE_KEY = "pk_live_x";
const CONNECTED_KEY = "mk_test_x";
const SECRET = "mksec_test_fixture";

// The callback body MONEI posts is a Payment.
const paymentBody = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: MONEI_PAYMENT_ID,
    status: "SUCCEEDED",
    orderId: SESSION_ID,
    livemode: false,
    ...overrides,
  });
const body = paymentBody();

const fetched = (overrides: Record<string, unknown> = {}) => ({
  id: MONEI_PAYMENT_ID,
  amount: 1999,
  currency: "EUR",
  orderId: SESSION_ID,
  status: "SUCCEEDED",
  livemode: false,
  ...overrides,
});

const NOT_SUPPORTED = { action: "not_supported" };

let logger: Record<"warn" | "info" | "error", ReturnType<typeof vi.fn>>;
let provider: TestProvider;
let mock: MockAdapter;
let paymentSessionService: { list: ReturnType<typeof vi.fn> };
let clock = Date.now();

async function useCredentials(
  apiKey: string,
  options: { connected?: boolean; accountId?: string } = {},
) {
  const rows = options.connected
    ? [
        {
          id: "credential",
          mode: "test",
          account_id: "merchant",
          api_key: CONNECTED_KEY,
          signing_secret: SECRET,
        },
      ]
    : [];
  provider = new TestProvider(
    {
      logger,
      paymentSessionService,
      __pg_connection__: { raw: async () => ({ rows: [{ rows, storedMode: "test" }] }) },
    },
    { apiKey, accountId: options.accountId, backendUrl: "https://shop.test" },
  );
  await provider["client"]();
  mock = mocks.get(options.connected ? CONNECTED_KEY : apiKey)!;
  mock.onGet(PAYMENT).reply(200, fetched());
}

beforeEach(async () => {
  clearCredentialsCache();
  mocks.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime((clock += 120_000));
  logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  // Only SESSION_ID exists in Medusa.
  paymentSessionService = {
    list: vi.fn(async ({ id }: { id: string }) => (id === SESSION_ID ? [{ id }] : [])),
  };
  await useCredentials(API_KEY);
});
afterEach(() => vi.useRealTimers());

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
      id: MONEI_PAYMENT_ID,
      status: "SUCCEEDED",
      livemode: false,
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
    ["a tampered body", paymentBody({ id: OTHER_ID }), { "monei-signature": sign(body) }],
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
  ])(
    "refuses %s for an unknown session instead of treating it as signed",
    async (_, rawData, headers) => {
      paymentSessionService.list.mockResolvedValue([]);
      await expect(webhook(rawData, headers)).resolves.toEqual(NOT_SUPPORTED);
      expect(mock.history.get).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledOnce();
    },
  );

  it("lets a current v2 callback through without spending any fallback slots", async () => {
    await useCredentials(API_KEY, { connected: true });
    const signed = paymentBody({ orderId: "not_used_for_signed_callbacks" });
    await expect(
      webhook(signed, { "monei-signature": signV2(signed, SECRET) }),
    ).resolves.toMatchObject({
      action: "captured",
    });
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      `MONEI callback verified (v2) payment=${MONEI_PAYMENT_ID}`,
    );
    expect(mock.history.get).toHaveLength(1);
    for (let index = 0; index < 5; index++) {
      await expect(webhook(paymentBody({ updatedAt: index }), {})).resolves.toMatchObject({
        action: "captured",
      });
    }
    expect(logger.error).not.toHaveBeenCalled();
    expect(mock.history.get).toHaveLength(6);
  });

  it("checks v1 with the env key when v2 is unknown and fetches with the connected key", async () => {
    await useCredentials(API_KEY, { connected: true });
    const signed = paymentBody({ orderId: "not_used_for_signed_callbacks" });
    const signature = `${sign(signed)},v2=${hmac(signed, "old_secret")}`;

    await expect(webhook(signed, { "monei-signature": signature })).resolves.toMatchObject({
      action: "captured",
    });
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      `MONEI callback verified (v1) payment=${MONEI_PAYMENT_ID}`,
    );
    expect(mock.history.get).toHaveLength(1);
  });

  it("accepts a partner v1 callback for a live merchant on a test master key", async () => {
    await useCredentials(API_KEY, { accountId: "merchant" });
    const raw = paymentBody({ livemode: true });

    await expect(webhook(raw, { "monei-signature": sign(raw) })).resolves.toMatchObject({
      action: "captured",
    });
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      `MONEI callback verified (v1) payment=${MONEI_PAYMENT_ID}`,
    );
    expect(mock.history.get).toHaveLength(1);
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
    objectId: MONEI_PAYMENT_ID,
    createdAt: 1762970000,
    // Never trusted: a stale status, another session and another amount.
    object: { id: MONEI_PAYMENT_ID, status: "PENDING", orderId: "payses_other", amount: 50000 },
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
    const raw = paymentBody(extra);

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
      "objectType is not charge",
    ],
    // Bug: a loose compare accepts an objectType MONEI does not send for payments.
    ["objectType in another case", envelope({ objectType: "Charge" }), "objectType is not charge"],
    // Bug: a typeof check sends a null objectType down the payment path and fetches the event id.
    ["a null objectType", envelope({ objectType: null }), "objectType is not charge"],
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
  ])("refuses %s without fetching", async (_, raw, signature) => {
    await expect(webhook(raw, { "monei-signature": signature })).resolves.toEqual(NOT_SUPPORTED);
    expect(mock.history.get).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("signature verification failed"),
    );
  });

  it("does not verify an inner payment body with the envelope's signature", async () => {
    const event = envelope({ object: JSON.parse(body) });

    await expect(webhook(body, { "monei-signature": sign(event) })).resolves.toMatchObject({
      action: "captured",
    });
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      `MONEI callback fallback fetch payment=${MONEI_PAYMENT_ID}`,
    );
  });
});

describe.each([
  ["payment body", paymentBody],
  ["event envelope", envelope],
] as const)("getWebhookActionAndData: verified %s mode", (_, makeBody) => {
  it.each([
    ["a Test callback on a Live backend", LIVE_KEY, false],
    ["a Live callback on a Test backend", API_KEY, true],
    ["a callback that omits its mode", API_KEY, undefined],
    ["a callback with a string instead of a boolean mode", API_KEY, "false"],
  ] as const)("refuses %s even with a valid signature", async (_, key, livemode) => {
    await useCredentials(key);
    const raw = makeBody({ livemode });

    await expect(webhook(raw, { "monei-signature": sign(raw, key) })).resolves.toEqual(
      NOT_SUPPORTED,
    );
    expect(mock.history.get).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("livemode"));
  });
});

describe("getWebhookActionAndData: fetch fallback", () => {
  it.each([
    ["a revoked signing key", { "monei-signature": signV2(body, "old_secret") }],
    ["a missing v2 signature", { "monei-signature": sign(body, CONNECTED_KEY) }],
  ])("settles an open session after %s with the current key", async (_, headers) => {
    await useCredentials(API_KEY, { connected: true });

    await expect(webhook(body, headers)).resolves.toEqual({
      action: "captured",
      data: { session_id: SESSION_ID, amount: 19.99 },
    });
    expect(fetchedUrls()).toEqual([PAYMENT]);
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      `MONEI callback fallback fetch payment=${MONEI_PAYMENT_ID}`,
    );
  });

  it("warns and never fetches an unverified account-webhook event", async () => {
    const raw = envelope({ object: JSON.parse(body) });

    await expect(webhook(raw, {})).resolves.toEqual(NOT_SUPPORTED);
    expect(mock.history.get).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("account-webhook event"),
    );
  });

  it.each([
    ["a malformed payment id", { id: "pay_invalid" }],
    ["an order id of another integration", { orderId: "wc_123" }],
    ["an order without a Medusa session id", { orderId: "payses_" }],
  ])("checks %s before looking up the session or fetching", async (_, overrides) => {
    await expect(webhook(paymentBody(overrides), {})).resolves.toEqual(NOT_SUPPORTED);
    expect(paymentSessionService.list).not.toHaveBeenCalled();
    expect(mock.history.get).toHaveLength(0);
  });

  it("never fetches an unverified payment of a deleted session", async () => {
    await expect(webhook(paymentBody({ orderId: "payses_deleted" }), {})).resolves.toEqual(
      NOT_SUPPORTED,
    );
    expect(mock.history.get).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(MONEI_PAYMENT_ID));
  });

  it.each(["captured_at", "canceled_at"])(
    "blocks an unsigned replay after the Medusa payment has %s",
    async (field) => {
      paymentSessionService.list.mockImplementation(async ({ id }, { relations }) => [
        { id, payment: relations?.includes("payment") ? { [field]: new Date() } : undefined },
      ]);

      await expect(webhook(body, {})).resolves.toEqual(NOT_SUPPORTED);
      expect(mock.history.get).toHaveLength(0);
    },
  );

  it("captures an authorized Medusa payment that MONEI captured in its dashboard", async () => {
    paymentSessionService.list.mockResolvedValue([
      {
        id: SESSION_ID,
        authorized_at: new Date(),
        payment: { captured_at: null, canceled_at: null },
      },
    ]);

    await expect(webhook(body, {})).resolves.toMatchObject({ action: "captured" });
    expect(fetchedUrls()).toEqual([PAYMENT]);
  });

  it.each([
    ["id differs from the callback", { id: OTHER_ID }],
    ["orderId differs from the callback", { orderId: "payses_other" }],
    ["livemode belongs to the other mode", { livemode: true }],
    ["livemode is absent", { livemode: undefined }],
  ])("refuses a fallback payment whose %s", async (_, overrides) => {
    mock.onGet(PAYMENT).reply(200, fetched(overrides));

    await expect(webhook(body, {})).resolves.toEqual(NOT_SUPPORTED);
    expect(fetchedUrls()).toEqual([PAYMENT]);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("does not log a payment id containing a newline", async () => {
    const id = `${MONEI_PAYMENT_ID}\nforged log line`;
    await expect(webhook(paymentBody({ id }), {})).resolves.toEqual(NOT_SUPPORTED);
    expect(mock.history.get).toHaveLength(0);
    for (const level of Object.values(logger)) {
      expect(JSON.stringify(level.mock.calls)).not.toContain("forged log line");
    }
  });

  it("returns not_supported without constructing a client when the backend has no key", async () => {
    provider = new TestProvider(
      { logger, paymentSessionService },
      { backendUrl: "https://shop.test" },
    );

    await expect(webhook(body, {})).resolves.toEqual(NOT_SUPPORTED);
    expect(paymentSessionService.list).not.toHaveBeenCalled();
    expect(mock.history.get).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("not connected"));
  });

  it("fetches again after a temporary API failure for the same delivery", async () => {
    mock.resetHandlers();
    mock.onGet(PAYMENT).replyOnce(503, { statusCode: 503, message: "Service unavailable" });
    mock.onGet(PAYMENT).reply(200, fetched());

    await expect(webhook(body, {})).rejects.toMatchObject({ type: "unexpected_state" });
    await expect(webhook(body, {})).resolves.toMatchObject({ action: "captured" });
    expect(fetchedUrls()).toEqual([PAYMENT, PAYMENT]);
  });

  it("fetches a capture delivered within a minute of the same payment's authorization", async () => {
    mock.resetHandlers();
    mock.onGet(PAYMENT).replyOnce(200, fetched({ status: "AUTHORIZED" }));
    mock.onGet(PAYMENT).reply(200, fetched());

    await expect(webhook(paymentBody({ status: "AUTHORIZED" }), {})).resolves.toMatchObject({
      action: "authorized",
    });
    await expect(webhook(body, {})).resolves.toMatchObject({ action: "captured" });
    expect(fetchedUrls()).toEqual([PAYMENT, PAYMENT]);
  });

  it("limits one session to five fallback fetches in a minute", async () => {
    for (let index = 0; index < 5; index++) {
      await expect(webhook(paymentBody({ updatedAt: index }), {})).resolves.toMatchObject({
        action: "captured",
      });
    }
    await expect(webhook(body, {})).resolves.toEqual(NOT_SUPPORTED);
    expect(mock.history.get).toHaveLength(5);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("quota exceeded"));

    vi.setSystemTime((clock += 61_000));
    await expect(webhook(body, {})).resolves.toMatchObject({ action: "captured" });
    expect(mock.history.get).toHaveLength(6);
  });

  it("limits distinct sessions to sixty fallback fetches in a minute", async () => {
    paymentSessionService.list.mockImplementation(async ({ id }) => [{ id }]);
    const attempt = async (index: number) => {
      const orderId = `payses_${index}`;
      const id = index.toString(16).padStart(32, "0");
      mock.onGet(`https://api.monei.com/v1/payments/${id}`).reply(200, fetched({ id, orderId }));
      return webhook(paymentBody({ id, orderId }), {});
    };
    for (let index = 0; index < 60; index++) {
      await expect(attempt(index)).resolves.toMatchObject({ action: "captured" });
    }
    await expect(attempt(60)).resolves.toEqual(NOT_SUPPORTED);
    expect(mock.history.get).toHaveLength(60);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("quota exceeded"));

    vi.setSystemTime((clock += 61_000));
    await expect(attempt(60)).resolves.toMatchObject({ action: "captured" });
    expect(mock.history.get).toHaveLength(61);
  });
});
