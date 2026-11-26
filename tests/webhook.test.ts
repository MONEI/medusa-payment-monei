import MockAdapter from "axios-mock-adapter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createMoneiClient } from "../src/providers/monei/core/client";
import {
  API_KEY,
  emptyCredentialsStore,
  hmac,
  MONEI_PAYMENT_ID,
  sign,
  signV2,
  T,
  type TestProvider,
} from "./helpers";

const mocks = vi.hoisted(() => new Map<string, MockAdapter>());
vi.mock("../src/providers/monei/core/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/providers/monei/core/client")>();
  return {
    ...actual,
    createMoneiClient: vi.fn((options: Parameters<typeof actual.createMoneiClient>[0]) => {
      const client = actual.createMoneiClient(options);
      mocks.set(options.apiKey, new MockAdapter(client.client));
      return client;
    }),
  };
});

const SESSION_ID = "payses_01";
const PAYMENT = `https://api.monei.com/v1/payments/${MONEI_PAYMENT_ID}`;
const OTHER_ID = "abcdef0123456789abcdef0123456789abcdef01";
const LIVE_KEY = "mk_live_x";
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
let Provider: typeof TestProvider;
const session = (id = SESSION_ID, paymentId = MONEI_PAYMENT_ID) => ({
  id,
  provider_id: "pp_monei_monei",
  data: { id: paymentId },
});

async function useCredentials(
  apiKey: string | undefined,
  {
    mode,
    key,
    accountId,
    accountWebhookSigningSecrets,
    providerType = Provider,
  }: {
    mode?: "live" | "test";
    key?: string;
    accountId?: string;
    accountWebhookSigningSecrets?: Record<string, string>;
    providerType?: typeof TestProvider;
  } = {},
) {
  const connectedKey = mode ? (key ?? CONNECTED_KEY) : undefined;
  const rows = connectedKey
    ? [
        {
          id: "credential",
          mode,
          account_id: "merchant",
          api_key: connectedKey,
          signing_secret: SECRET,
        },
      ]
    : [];
  const readCredentials = vi.fn(async () => ({ rows: [{ rows, storedMode: mode ?? null }] }));
  provider = new providerType(
    {
      logger,
      paymentSessionService,
      __pg_connection__: { raw: readCredentials },
    },
    { apiKey, accountId, accountWebhookSigningSecrets, backendUrl: "https://shop.test" },
  );
  await provider["client"]();
  mock = mocks.get((connectedKey ?? apiKey)!)!;
  mock.onGet(PAYMENT).reply(200, fetched());
  return readCredentials;
}

beforeEach(async () => {
  vi.resetModules();
  ({ TestProvider: Provider } = await import("./helpers"));
  vi.mocked(createMoneiClient).mockClear();
  mocks.clear();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  // Only SESSION_ID exists in Medusa.
  paymentSessionService = {
    list: vi.fn(async ({ id }: { id: string }) => (id === SESSION_ID ? [session()] : [])),
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
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      `MONEI callback verified (v1) payment=${MONEI_PAYMENT_ID}`,
    );
    expect(mock.history.get).toHaveLength(1);
  });

  it("accepts rawData as a JSON-serialized Buffer", async () => {
    // Bug: the event bus serializes the Buffer and only the core subscriber
    // rebuilds it; any other caller would have every callback refused.
    const serialized = JSON.parse(JSON.stringify(Buffer.from(body)));

    await expect(webhook(serialized, { "monei-signature": sign(body) })).resolves.toEqual({
      action: "captured",
      data: { session_id: SESSION_ID, amount: 19.99 },
    });
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      `MONEI callback verified (v1) payment=${MONEI_PAYMENT_ID}`,
    );
    expect(mock.history.get).toHaveLength(1);
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
    await useCredentials(API_KEY, { mode: "test" });
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
    await useCredentials(API_KEY, { mode: "test" });
    const signed = paymentBody({ orderId: "not_used_for_signed_callbacks" });
    const signature = `${sign(signed)},v2=${hmac(signed, "old_secret")}`;

    await expect(webhook(signed, { "monei-signature": signature })).resolves.toMatchObject({
      action: "captured",
    });
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      `MONEI callback verified (v1) payment=${MONEI_PAYMENT_ID}`,
    );
    expect(mock.history.get).toHaveLength(1);
    expect(createMoneiClient).toHaveBeenCalledWith({ apiKey: API_KEY });
    expect(mocks.get(API_KEY)!.history.get).toHaveLength(0);
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

  it.each([
    ["payment was replaced", { data: { id: OTHER_ID } }],
    ["session belongs to another provider", { provider_id: "pp_monei-paypal_monei" }],
  ])("does not settle a verified callback when the %s", async (_, change) => {
    paymentSessionService.list.mockResolvedValue([{ ...session(), ...change }]);

    await expect(webhook(body, { "monei-signature": sign(body) })).resolves.toEqual(NOT_SUPPORTED);
    expect(mock.history.get).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("this provider and payment"));
  });

  it.each([
    [
      "refuses a replacement that would capture the original hold",
      MONEI_PAYMENT_ID,
      OTHER_ID,
      "not_supported",
    ],
    [
      "settles the original hold after the session is repointed",
      OTHER_ID,
      MONEI_PAYMENT_ID,
      "captured",
    ],
    [
      "refuses to act on an existing payment with no stored id",
      MONEI_PAYMENT_ID,
      undefined,
      "not_supported",
    ],
  ])("%s", async (_, sessionPaymentId, attachedPaymentId, action) => {
    paymentSessionService.list.mockImplementation(async (_filters, { relations }) => [
      {
        ...session(SESSION_ID, sessionPaymentId),
        payment: relations?.includes("payment") ? { data: { id: attachedPaymentId } } : undefined,
      },
    ]);

    await expect(webhook(body, { "monei-signature": sign(body) })).resolves.toMatchObject({
      action,
    });
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
  it.each(["card", "PayPal"])(
    "uses the %s account webhook's own secret for dashboard captures",
    async (method) => {
      const cardSecret = "whsec_" + "a".repeat(43);
      const paypalSecret = "whsec_" + "b".repeat(43);
      const isCard = method === "card";
      const { default: PaypalProvider } =
        await import("../src/providers/monei/services/monei-paypal");
      await useCredentials(undefined, {
        mode: "test",
        accountWebhookSigningSecrets: {
          pp_monei_monei: cardSecret,
          "pp_monei-paypal_monei": paypalSecret,
        },
        providerType: isCard ? Provider : PaypalProvider,
      });
      paymentSessionService.list.mockResolvedValue([
        {
          ...session(),
          provider_id: isCard ? "pp_monei_monei" : "pp_monei-paypal_monei",
          authorized_at: new Date(),
          payment: { captured_at: null, data: { id: MONEI_PAYMENT_ID } },
        },
      ]);
      const raw = envelope({ type: "charge.captured" });

      await expect(
        webhook(raw, { "monei-signature": signV2(raw, isCard ? paypalSecret : cardSecret) }),
      ).resolves.toEqual(NOT_SUPPORTED);
      expect(mock.history.get).toHaveLength(0);
      await expect(
        webhook(raw, { "monei-signature": signV2(raw, isCard ? cardSecret : paypalSecret) }),
      ).resolves.toMatchObject({ action: "captured" });
      expect(logger.info).toHaveBeenCalledExactlyOnceWith(
        `MONEI callback verified (v2) payment=${MONEI_PAYMENT_ID}`,
      );
      expect(fetchedUrls()).toEqual([PAYMENT]);
    },
  );

  it("does not use an account webhook secret to verify a bare payment callback", async () => {
    const secret = "whsec_" + "a".repeat(43);
    await useCredentials(undefined, {
      mode: "test",
      accountWebhookSigningSecrets: { pp_monei_monei: secret },
    });
    const raw = paymentBody({ orderId: "payses_deleted" });

    await expect(webhook(raw, { "monei-signature": signV2(raw, secret) })).resolves.toEqual(
      NOT_SUPPORTED,
    );
    expect(mock.history.get).toHaveLength(0);
  });

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
    ["a Test callback on a Live backend", "live", false],
    ["a Live callback on a Test backend", "test", true],
    ["a callback that omits its mode", "test", undefined],
    ["a callback with a string instead of a boolean mode", "test", "false"],
  ] as const)("refuses %s even with a valid signature", async (_, mode, livemode) => {
    await useCredentials(undefined, { mode, key: mode === "live" ? LIVE_KEY : CONNECTED_KEY });
    const raw = makeBody({ livemode });

    await expect(webhook(raw, { "monei-signature": signV2(raw, SECRET) })).resolves.toEqual(
      NOT_SUPPORTED,
    );
    expect(mock.history.get).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("livemode"));
  });
});

describe("getWebhookActionAndData: fetch fallback", () => {
  it("keeps settlement quota for the current payment when unsigned callbacks name an unrelated id", async () => {
    paymentSessionService.list.mockResolvedValue([
      { ...session(SESSION_ID, OTHER_ID), payment: { data: { id: MONEI_PAYMENT_ID } } },
    ]);
    for (let index = 0; index < 6; index++) {
      await expect(webhook(paymentBody({ id: OTHER_ID, updatedAt: index }), {})).resolves.toEqual(
        NOT_SUPPORTED,
      );
    }
    expect(fetchedUrls()).toEqual([]);
    await expect(webhook(body, {})).resolves.toMatchObject({ action: "captured" });
    expect(fetchedUrls()).toEqual([PAYMENT]);
  });

  it("does not settle a payment replaced during a fallback fetch", async () => {
    mock.onGet(PAYMENT).reply(() => {
      paymentSessionService.list.mockResolvedValue([{ ...session(), data: { id: OTHER_ID } }]);
      return [200, fetched()];
    });

    await expect(webhook(body, {})).resolves.toEqual(NOT_SUPPORTED);
    expect(fetchedUrls()).toEqual([PAYMENT]);
  });

  it.each([
    ["a revoked signing key", { "monei-signature": signV2(body, "old_secret") }],
    ["a missing v2 signature", { "monei-signature": sign(body, CONNECTED_KEY) }],
  ])("settles an open session after %s with the current key", async (_, headers) => {
    await useCredentials(API_KEY, { mode: "test" });

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
        {
          ...session(id),
          payment: relations?.includes("payment")
            ? { data: { id: MONEI_PAYMENT_ID }, [field]: new Date() }
            : undefined,
        },
      ]);

      await expect(webhook(body, {})).resolves.toEqual(NOT_SUPPORTED);
      expect(mock.history.get).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("captured or canceled"));
    },
  );

  it("lets fallback settle a capture when the Medusa payment is still authorized", async () => {
    paymentSessionService.list.mockResolvedValue([
      {
        ...session(),
        authorized_at: new Date(),
        payment: { captured_at: null, canceled_at: null, data: { id: MONEI_PAYMENT_ID } },
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
    provider = new Provider(
      { logger, paymentSessionService, __pg_connection__: emptyCredentialsStore },
      { backendUrl: "https://shop.test" },
    );

    vi.mocked(createMoneiClient).mockClear();
    await expect(webhook(body, {})).resolves.toEqual(NOT_SUPPORTED);
    expect(paymentSessionService.list).not.toHaveBeenCalled();
    expect(createMoneiClient).not.toHaveBeenCalled();
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

  it("fetches with the replacement key when the same delivery arrives after reconnect", async () => {
    const headers = { "monei-signature": signV2(body, "old_secret") };
    await useCredentials(undefined, { mode: "test" });
    const original = mock;
    await expect(webhook(body, headers)).resolves.toMatchObject({ action: "captured" });

    await useCredentials(undefined, { mode: "test", key: "mk_test_replacement" });
    mock.onGet(PAYMENT).reply(200, fetched({ status: "AUTHORIZED" }));

    await expect(webhook(body, headers)).resolves.toMatchObject({ action: "authorized" });
    expect(original.history.get).toHaveLength(1);
    expect(fetchedUrls()).toEqual([PAYMENT]);
  });

  it("refreshes a successful fallback after its minute-long memo expires", async () => {
    await expect(webhook(body, {})).resolves.toMatchObject({ action: "captured" });
    mock.onGet(PAYMENT).reply(200, fetched({ status: "AUTHORIZED" }));
    vi.setSystemTime(Date.now() + 59_000);
    await expect(webhook(body, {})).resolves.toMatchObject({ action: "captured" });
    expect(fetchedUrls()).toEqual([PAYMENT]);
    vi.setSystemTime(Date.now() + 2_000);
    await expect(webhook(body, {})).resolves.toMatchObject({ action: "authorized" });
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

  it("refuses a sixth fallback immediately so it cannot block verified jobs", async () => {
    for (let index = 0; index < 5; index++) {
      await expect(webhook(paymentBody({ updatedAt: index }), {})).resolves.toMatchObject({
        action: "captured",
      });
    }
    const refused = vi.fn();
    const attempt = webhook(body, {}).then(refused);
    await vi.advanceTimersByTimeAsync(0);
    expect(refused).toHaveBeenCalledExactlyOnceWith(NOT_SUPPORTED);
    expect(vi.getTimerCount()).toBe(0);
    await attempt;
    expect(mock.history.get).toHaveLength(5);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      `MONEI webhook refused: fallback fetch quota reached payment=${MONEI_PAYMENT_ID}`,
    );
    await expect(webhook(body, { "monei-signature": sign(body) })).resolves.toMatchObject({
      action: "captured",
    });

    vi.setSystemTime(Date.now() + 60_000);
    await expect(webhook(body, {})).resolves.toMatchObject({ action: "captured" });
    expect(mock.history.get).toHaveLength(7);
  });

  it("limits distinct sessions to sixty fallback fetches in a minute", async () => {
    paymentSessionService.list.mockImplementation(async ({ id }) => [
      session(id, Number(id.slice("payses_".length)).toString(16).padStart(32, "0")),
    ]);
    const attempt = async (index: number) => {
      const orderId = `payses_${index}`;
      const id = index.toString(16).padStart(32, "0");
      mock.onGet(`https://api.monei.com/v1/payments/${id}`).reply(200, fetched({ id, orderId }));
      return webhook(paymentBody({ id, orderId }), {});
    };
    for (let index = 0; index < 60; index++) {
      await expect(attempt(index)).resolves.toMatchObject({ action: "captured" });
    }
    const refused = vi.fn();
    const excess = attempt(60).then(refused);
    await vi.advanceTimersByTimeAsync(0);
    expect(refused).toHaveBeenCalledExactlyOnceWith(NOT_SUPPORTED);
    expect(vi.getTimerCount()).toBe(0);
    await excess;
    expect(mock.history.get).toHaveLength(60);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      `MONEI webhook refused: fallback fetch quota reached payment=${(60).toString(16).padStart(32, "0")}`,
    );

    vi.setSystemTime(Date.now() + 60_000);
    await expect(attempt(60)).resolves.toMatchObject({ action: "captured" });
    expect(mock.history.get).toHaveLength(61);
  });

  it("never fetches with a key retained by a quota-refused callback after reconnect", async () => {
    const readCredentials = await useCredentials(undefined, { mode: "test" });
    const original = mock;
    for (let index = 0; index < 5; index++) {
      await webhook(paymentBody({ updatedAt: index }), {});
    }
    const excess = webhook(body, {});
    await vi.advanceTimersByTimeAsync(0);
    const key = "mk_test_replacement";
    const snapshot = await readCredentials();
    snapshot.rows[0].rows[0].api_key = key;
    const { clearCredentialsCache } = await import("../src/providers/monei/core/credentials");
    clearCredentialsCache();
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(excess).resolves.toEqual(NOT_SUPPORTED);
    expect(original.history.get).toHaveLength(5);
    await provider["client"]();
    mock = mocks.get(key)!;
    expect(mock.history.get).toHaveLength(0);
    mock.onGet(PAYMENT).reply(200, fetched());
    await expect(webhook(body, {})).resolves.toMatchObject({ action: "captured" });
    expect(fetchedUrls()).toEqual([PAYMENT]);
  });
});
