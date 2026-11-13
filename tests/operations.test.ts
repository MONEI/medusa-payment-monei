import MockAdapter from "axios-mock-adapter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { TestProvider } from "./helpers";

const SESSION_ID = "payses_01";
const PAYMENT = "https://api.monei.com/v1/payments/pay_1";

const storedData = {
  id: "pay_1",
  session_id: SESSION_ID,
  amount: 18,
  currency: "EUR",
  status: "AUTHORIZED",
  redirect_url: undefined,
  monei_customer_missing: true,
};

const fetched = (overrides: Record<string, unknown> = {}) => ({
  id: "pay_1",
  amount: 1800,
  currency: "EUR",
  orderId: SESSION_ID,
  status: "AUTHORIZED",
  ...overrides,
});

// Session data stored by 0.1.x: `amount` in MONEI minor units, a status from
// session creation, and `client_secret`. Payments in flight at the upgrade carry it.
const legacyData = {
  id: "pay_1",
  status: "PENDING",
  amount: 1800,
  currency: "EUR",
  session_id: SESSION_ID,
  redirect_url: null,
  client_secret: "pay_1",
};

// What v1 returns for `legacyData`: major units, no `client_secret`.
const fromLegacy = (status: string) => ({
  id: "pay_1",
  session_id: SESSION_ID,
  amount: 18,
  currency: "EUR",
  status,
  redirect_url: undefined,
  monei_customer_missing: false,
});

// Medusa passes `refund.raw_amount`.
const NINE = { value: "9", precision: 20 };

let logger: Record<"warn" | "info" | "error", ReturnType<typeof vi.fn>>;
let provider: TestProvider;
let mock: MockAdapter;

beforeEach(() => {
  logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  provider = new TestProvider({ logger }, { apiKey: "pk_test_x", backendUrl: "https://shop.test" });
  mock = new MockAdapter(provider["client_"].client);
});

afterEach(() => {
  vi.useRealTimers();
});

const posts = (path: string) => mock.history.post.filter((r) => r.url === `${PAYMENT}/${path}`);

describe("capturePayment", () => {
  it("returns explicit data without a capture request when already SUCCEEDED", async () => {
    // Bugs: a second capture that MONEI refuses fails an auto-captured payment;
    // returning the fetched payment leaks `paymentToken` through `payment.data`.
    mock.onGet(PAYMENT).reply(200, fetched({ status: "SUCCEEDED", paymentToken: "tok_permanent" }));

    await expect(provider.capturePayment({ data: storedData })).resolves.toEqual({
      data: { ...storedData, status: "SUCCEEDED" },
    });
    expect(mock.history.post).toHaveLength(0);
  });

  it.each([
    ["a network error", (r: MockAdapter.RequestHandler) => r.networkError()],
    ["a timeout", (r: MockAdapter.RequestHandler) => r.timeout()],
    // Bug: API Gateway or MONEI answers 5xx after the capture ran.
    ["a 503", (r: MockAdapter.RequestHandler) => r.reply(503, { statusCode: 503, message: "x" })],
  ])("succeeds after %s when the re-fetch shows SUCCEEDED", async (_form, fail) => {
    // Bug: the capture reached MONEI but its answer was lost; Medusa records a
    // failed capture for money that was taken.
    mock
      .onGet(PAYMENT)
      .replyOnce(200, fetched())
      .onGet(PAYMENT)
      .replyOnce(200, fetched({ status: "SUCCEEDED" }));
    fail(mock.onPost(`${PAYMENT}/capture`));

    await expect(provider.capturePayment({ data: storedData })).resolves.toMatchObject({
      data: { status: "SUCCEEDED" },
    });
    expect(posts("capture")).toHaveLength(1);
    expect(JSON.parse(posts("capture")[0].data ?? "{}")).not.toHaveProperty("amount");
  });

  it("throws after a network error when the payment is still AUTHORIZED, with no retry", async () => {
    // Bug: an automatic retry; a blind success reports money that was not captured.
    mock.onGet(PAYMENT).reply(200, fetched());
    mock.onPost(`${PAYMENT}/capture`).networkError();

    await expect(provider.capturePayment({ data: storedData })).rejects.toThrow(
      /AUTHORIZED; check the MONEI dashboard before retrying/,
    );
    expect(posts("capture")).toHaveLength(1);
  });
});

describe("cancelPayment", () => {
  it("cancels an AUTHORIZED payment with the reason", async () => {
    // Bug: an AUTH hold left on the buyer's card after Medusa cancels the order.
    mock.onGet(PAYMENT).reply(200, fetched());
    mock.onPost(`${PAYMENT}/cancel`).reply(200, fetched({ status: "CANCELED" }));

    await expect(provider.cancelPayment({ data: storedData })).resolves.toMatchObject({
      data: { status: "CANCELED", monei_customer_missing: true },
    });
    expect(JSON.parse(posts("cancel")[0].data)).toEqual({
      cancellationReason: "requested_by_customer",
    });
  });

  it("returns data without a request when already CANCELED", async () => {
    // Bug: MONEI refuses a second cancel, so Medusa never sets `canceled_at`.
    mock.onGet(PAYMENT).reply(200, fetched({ status: "CANCELED" }));

    await expect(provider.cancelPayment({ data: storedData })).resolves.toMatchObject({
      data: { status: "CANCELED" },
    });
    expect(mock.history.post).toHaveLength(0);
  });

  it("throws on a SUCCEEDED payment", async () => {
    // Bug: returning lets Medusa mark charged money as canceled.
    mock.onGet(PAYMENT).reply(200, fetched({ status: "SUCCEEDED" }));

    await expect(provider.cancelPayment({ data: storedData })).rejects.toThrow(
      "MONEI payment pay_1 is captured, refund it instead",
    );
    expect(mock.history.post).toHaveLength(0);
  });
});

describe("refundPayment", () => {
  const captured = { ...storedData, status: "SUCCEEDED" };
  const refund = () => provider.refundPayment({ data: captured, amount: NINE });

  it("sends minor units and returns explicit data", async () => {
    // Bugs: major units sent as cents turn a 9 EUR refund into 0.09 EUR; an absent
    // `refundedAmount` baseline gives `undefined + 900` = NaN, and every first refund throws.
    mock.onGet(PAYMENT).reply(200, fetched({ status: "SUCCEEDED" }));
    mock
      .onPost(`${PAYMENT}/refund`)
      .reply(200, fetched({ status: "PARTIALLY_REFUNDED", refundedAmount: 900 }));

    await expect(refund()).resolves.toEqual({
      data: { ...captured, status: "PARTIALLY_REFUNDED" },
    });
    expect(JSON.parse(posts("refund")[0].data)).toEqual({ amount: 900 });
  });

  it("throws when MONEI did not apply an equal refund", async () => {
    // Bug: MONEI can merge two equal refunds sent close together, but Medusa
    // records both, so its refund total exceeds what the buyer got back.
    mock.onGet(PAYMENT).reply(200, fetched({ status: "PARTIALLY_REFUNDED", refundedAmount: 900 }));
    mock
      .onPost(`${PAYMENT}/refund`)
      .reply(200, fetched({ status: "PARTIALLY_REFUNDED", refundedAmount: 900 }));

    await expect(refund()).rejects.toThrow(/did not apply the refund of 900 EUR/);
  });

  it("passes when a second refund adds to the baseline", async () => {
    // Bug: comparing against the refund amount alone refuses every second refund.
    mock.onGet(PAYMENT).reply(200, fetched({ status: "PARTIALLY_REFUNDED", refundedAmount: 900 }));
    mock
      .onPost(`${PAYMENT}/refund`)
      .reply(200, fetched({ status: "REFUNDED", refundedAmount: 1800 }));

    await expect(refund()).resolves.toMatchObject({ data: { status: "REFUNDED" } });
  });

  it("logs when the refund POST left and when MONEI answered", async () => {
    // Bug: without both timestamps the e2e equal-refunds spec cannot tell whether
    // the two refunds were close enough to merge.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T10:00:00.000Z"));
    mock.onGet(PAYMENT).reply(200, fetched({ status: "SUCCEEDED" }));
    mock.onPost(`${PAYMENT}/refund`).reply(() => {
      vi.setSystemTime(new Date("2026-11-12T10:00:01.250Z"));
      return [200, fetched({ status: "PARTIALLY_REFUNDED", refundedAmount: 900 })];
    });

    await refund();

    expect(logger.info).toHaveBeenCalledWith(
      "MONEI refund POST: payment=pay_1 amount=900 currency=EUR sent_at=2026-11-12T10:00:00.000Z answered_at=2026-11-12T10:00:01.250Z outcome=ok",
    );
  });

  it.each([
    ["a network error", (r: MockAdapter.RequestHandler) => r.networkError()],
    // Bugs: MONEI can answer 5xx after the refund ran (a gateway timeout, a failed
    // step after the provider call); a gateway body without statusCode looked clean.
    // Medusa soft-deletes the refund, the admin retries, and the buyer is refunded twice.
    ["a 503", (r: MockAdapter.RequestHandler) => r.reply(503, { statusCode: 503, message: "x" })],
    [
      "a 502 with an HTML body",
      (r: MockAdapter.RequestHandler) => r.reply(502, "<html>Bad Gateway</html>"),
    ],
  ])("throws after one refund POST on %s, with no re-fetch", async (_form, fail) => {
    // Bug: a retry or a re-fetch-and-retry refunds the buyer twice.
    mock.onGet(PAYMENT).reply(200, fetched({ status: "SUCCEEDED" }));
    fail(mock.onPost(`${PAYMENT}/refund`));

    await expect(refund()).rejects.toThrow(/may have been applied, check the MONEI dashboard/);
    expect(posts("refund")).toHaveLength(1);
    expect(mock.history.get).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("outcome=no_answer"));
  });

  it("reports a 4xx refusal as invalid data", async () => {
    // Bug: a refused refund reported as "may have been applied" sends the admin to
    // the dashboard for nothing and hides MONEI's reason.
    mock.onGet(PAYMENT).reply(200, fetched({ status: "SUCCEEDED" }));
    mock.onPost(`${PAYMENT}/refund`).reply(400, { statusCode: 400, message: "Amount too high" });

    await expect(refund()).rejects.toMatchObject({
      type: "invalid_data",
      message: expect.stringContaining("Amount too high"),
    });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("outcome=error"));
  });
});

describe("0.1.x session data", () => {
  it("captures a 0.1.x payment in full and returns v1 data", async () => {
    // Bugs: the stale stored `PENDING` decides instead of MONEI's `AUTHORIZED`, so
    // a pre-upgrade AUTH is never captured; the stored minor `amount` (1800) is sent
    // or returned as 1800 EUR; `client_secret` stays in data the store cart API returns.
    mock.onGet(PAYMENT).reply(200, fetched());
    mock.onPost(`${PAYMENT}/capture`).reply(200, fetched({ status: "SUCCEEDED" }));

    await expect(provider.capturePayment({ data: legacyData })).resolves.toEqual({
      data: fromLegacy("SUCCEEDED"),
    });
    expect(JSON.parse(posts("capture")[0].data ?? "{}")).not.toHaveProperty("amount");
  });

  it("cancels a 0.1.x payment that MONEI holds as AUTHORIZED", async () => {
    // Bug: the stored `PENDING` is read as "not AUTHORIZED", the cancel throws, and
    // the hold stays on the buyer's card after Medusa cancels the order.
    mock.onGet(PAYMENT).reply(200, fetched());
    mock.onPost(`${PAYMENT}/cancel`).reply(200, fetched({ status: "CANCELED" }));

    await expect(provider.cancelPayment({ data: legacyData })).resolves.toEqual({
      data: fromLegacy("CANCELED"),
    });
  });

  it("refunds the Medusa amount, not the stored 0.1.x amount", async () => {
    // Bugs: the stored minor `amount` used as the refund (1800 EUR) or as the
    // baseline; the uppercase 0.1.x `currency` refused.
    mock.onGet(PAYMENT).reply(200, fetched({ status: "SUCCEEDED" }));
    mock
      .onPost(`${PAYMENT}/refund`)
      .reply(200, fetched({ status: "PARTIALLY_REFUNDED", refundedAmount: 900 }));

    await expect(provider.refundPayment({ data: legacyData, amount: NINE })).resolves.toEqual({
      data: fromLegacy("PARTIALLY_REFUNDED"),
    });
    expect(JSON.parse(posts("refund")[0].data)).toEqual({ amount: 900 });
  });
});
