import { getHttpResponseFromError } from "@medusajs/framework/http";
import { Monei } from "@monei-js/node-sdk";
import MockAdapter from "axios-mock-adapter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import middlewares, {
  refusePartialMoneiCapture,
  refuseReservedMoneiSessionData,
} from "../src/api/middlewares";
import { POST as confirm } from "../src/api/store/monei/confirm/route";
import { DELETE as deleteMethod } from "../src/api/store/monei/payment-methods/[id]/route";
import { GET as listMethods } from "../src/api/store/monei/payment-methods/route";
import { GET as getConfig } from "../src/api/store/monei/config/route";
import { GET as paymentStatus } from "../src/api/store/monei/payment-status/route";
import { opaqueId } from "../src/providers/monei/core/ids";
import { fakeGraph } from "./helpers";

// Routes build their own client; hand them one whose axios instance is mocked.
const shared = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock("../src/providers/monei/core/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createMoneiClient: () => shared.client,
}));

const API = "https://api.monei.com/v1";
const TOKEN_A = "tok_permanent_ANA_7f3c";
const TOKEN_B = "tok_permanent_BEA_91d2";

const savedCard = (token: string, last4: string) => ({
  id: token,
  type: "STICKY",
  sequence: false,
  paymentMethod: { method: "card", card: { brand: "visa", last4, expiration: 1924991999 } },
});

const moneiPayment = (overrides: Record<string, unknown> = {}) => ({
  id: "pay_A",
  orderId: "payses_A",
  customerId: "mcus_A",
  amount: 1800,
  currency: "EUR",
  status: "PENDING",
  ...overrides,
});

const holder = (id: string) => ({ provider_id: "pp_monei_monei", data: { id } });

const tables: Record<string, Record<string, unknown>[]> = {
  customer: [
    {
      id: "cus_A",
      account_holders: [{ provider_id: "pp_stripe_stripe", data: { id: "x" } }, holder("mcus_A")],
    },
    { id: "cus_B", account_holders: [holder("mcus_B")] },
    { id: "cus_C", account_holders: [] },
    { id: "cus_D", account_holders: [holder("mcus_D1"), holder("mcus_D2")] },
  ],
  cart: [
    { id: "cart_A", customer_id: "cus_A" },
    { id: "cart_B", customer_id: "cus_B" },
    { id: "cart_C", customer_id: "cus_C" },
    { id: "cart_G", customer_id: null },
    { id: "cart_D", customer_id: "cus_D" },
  ],
  cart_payment_collection: [
    { cart_id: "cart_A", payment_collection_id: "pc_A" },
    { cart_id: "cart_B", payment_collection_id: "pc_B" },
    { cart_id: "cart_C", payment_collection_id: "pc_C" },
    { cart_id: "cart_G", payment_collection_id: "pc_G" },
    { cart_id: "cart_D", payment_collection_id: "pc_D" },
  ],
  payment_session: [
    {
      id: "payses_A",
      payment_collection_id: "pc_A",
      provider_id: "pp_monei_monei",
      data: { id: "pay_A" },
    },
    {
      id: "payses_Z",
      payment_collection_id: "pc_A",
      provider_id: "pp_monei-bizum_monei",
      data: { id: "pay_Z" },
    },
    {
      id: "payses_B",
      payment_collection_id: "pc_B",
      provider_id: "pp_monei_monei",
      data: { id: "pay_B" },
    },
    {
      id: "payses_C",
      payment_collection_id: "pc_C",
      provider_id: "pp_monei_monei",
      data: { id: "pay_C" },
    },
    {
      id: "payses_G",
      payment_collection_id: "pc_G",
      provider_id: "pp_monei_monei",
      data: { id: "pay_G" },
    },
    {
      id: "payses_D",
      payment_collection_id: "pc_D",
      provider_id: "pp_monei_monei",
      data: { id: "pay_D" },
    },
  ],
  payment: [
    { id: "pay_monei", provider_id: "pp_monei_monei", amount: 18, currency_code: "eur" },
    { id: "pay_taxed", provider_id: "pp_monei_monei", amount: 6.034, currency_code: "eur" },
    { id: "pay_stripe", provider_id: "pp_stripe_stripe", amount: 18, currency_code: "eur" },
  ],
};

let mock: MockAdapter;
let graph: ReturnType<typeof vi.fn>;
let scope: { resolve: (key: string) => unknown };
let bodies: unknown[];

beforeEach(() => {
  const client = new Monei("pk_test_x");
  shared.client = client;
  mock = new MockAdapter(client.client);
  graph = vi.fn(fakeGraph(tables));
  const deps: Record<string, unknown> = {
    query: { graph },
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    configModule: {
      projectConfig: { http: { jwtSecret: "test-secret" } },
      modules: {
        payment: {
          options: {
            providers: [
              { id: "monei", options: { apiKey: "pk_test_x", backendUrl: "https://shop.test" } },
            ],
          },
        },
      },
    },
  };
  scope = { resolve: (key) => deps[key] };
  bodies = [];
});

afterEach(() => {
  // The permanent tokens must never reach a store response, error bodies included.
  const all = JSON.stringify(bodies);
  expect(all).not.toContain(TOKEN_A);
  expect(all).not.toContain(TOKEN_B);
});

type Handler = (req: never, res: never, next: never) => unknown;

/** Runs the plugin's middlewares for the route, then the handler, like the Medusa router. */
async function dispatch(
  method: string,
  matcher: string,
  handler: Handler,
  req: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const route = middlewares.routes?.find(
    (r) => r.matcher === matcher && (r.methods as string[] | undefined)?.includes(method),
  );
  const chain = [...((route?.middlewares ?? []) as Handler[]), handler];
  const request = { scope, headers: {}, params: {}, query: {}, ...req };
  let status = 200;
  let body: unknown;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: unknown) {
      body = value;
      return res;
    },
  };
  try {
    for (const fn of chain) {
      let proceed = false;
      let error: unknown;
      await fn(
        request as never,
        res as never,
        ((err?: unknown) => {
          proceed = true;
          error = err;
        }) as never,
      );
      if (error) throw error;
      if (!proceed) break;
    }
  } catch (error) {
    ({ statusCode: status, body } = getHttpResponseFromError(error as Error));
  }
  bodies.push(body);
  return { status, body };
}

const asCustomer = (id: string) => ({
  session: {
    auth_context: {
      actor_id: id,
      actor_type: "customer",
      auth_identity_id: "ai_1",
      app_metadata: {},
    },
  },
});

const confirmAs = (customerId: string, body: Record<string, unknown>) =>
  dispatch("POST", "/store/monei/confirm", confirm as Handler, { ...asCustomer(customerId), body });

const capture = async (paymentId: string, body: Record<string, unknown>) => {
  const next = vi.fn();
  const req = { scope, params: { id: paymentId }, body };
  try {
    await refusePartialMoneiCapture(req as never, {} as never, next);
    return { status: next.mock.calls.length ? "next" : "stopped", next };
  } catch (error) {
    return { status: getHttpResponseFromError(error as Error).statusCode, next };
  }
};

describe("admin capture guard", () => {
  it("refuses a partial capture of a MONEI payment before the capture route runs", async () => {
    // Bug: the provider gets no amount, so MONEI captures 18 while Medusa records 9.
    const result = await capture("pay_monei", { amount: 9 });

    expect(result.status).toBe(400);
    expect(result.next).not.toHaveBeenCalled();
  });

  it("lets a full capture of a MONEI payment through, with or without the amount", async () => {
    // Bug: the default admin capture (no amount) or the exact amount is refused.
    expect((await capture("pay_monei", { amount: 18 })).next).toHaveBeenCalledWith();
    expect((await capture("pay_monei", {})).next).toHaveBeenCalledWith();
  });

  it("compares at cent precision: 6.03 captures a 6.034 payment in full, 6.02 does not", async () => {
    // Bug: MONEI holds 6.03 for a 6.034 tax-maths amount, so an unrounded compare
    // refuses the full capture.
    expect((await capture("pay_taxed", { amount: 6.03 })).next).toHaveBeenCalledWith();
    expect((await capture("pay_taxed", { amount: 6.02 })).status).toBe(400);
  });

  it("does not touch partial captures of other providers", async () => {
    // Bug: the guard blocks Stripe partial captures in the same store.
    expect((await capture("pay_stripe", { amount: 9 })).next).toHaveBeenCalledWith();
  });

  it("is registered on the core capture route", () => {
    // Bug: a wrong matcher or method leaves the guard unmounted.
    const route = middlewares.routes?.find((r) => r.matcher === "/admin/payments/:id/capture");
    expect(route?.methods).toEqual(["POST"]);
    expect(route?.middlewares).toContain(refusePartialMoneiCapture);
  });
});

const createSession = (body: unknown) => {
  const next = vi.fn();
  try {
    refuseReservedMoneiSessionData({ body } as never, {} as never, next);
    return { status: next.mock.calls.length ? "next" : "stopped", next };
  } catch (error) {
    return { status: getHttpResponseFromError(error as Error).statusCode, next };
  }
};

describe("store create-session guard", () => {
  it.each([
    "id",
    "session_id",
    "amount",
    "currency",
    "status",
    "redirect_url",
    "monei_customer_missing",
  ])("refuses `%s` in the data of a MONEI session", (key) => {
    // Bug (external review): only the provider may set these keys; deletePayment trusts
    // `id` and `session_id`, and the storefront trusts the others.
    const result = createSession({ provider_id: "pp_monei-bizum_monei", data: { [key]: "x" } });
    expect(result.status).toBe(400);
    expect(result.next).not.toHaveBeenCalled();
  });

  it("refuses a reserved key whatever its value: null, object or array", () => {
    // Bug: a type check on the value lets `{ id: null }` or `{ id: ["pay_x"] }` through.
    for (const value of [null, {}, ["pay_x"], 0, false]) {
      expect(createSession({ provider_id: "pp_monei_monei", data: { id: value } }).status).toBe(
        400,
      );
    }
  });

  it("refuses `__proto__`, which a later object copy turns into an inherited `id`", () => {
    // Bug: `{ ...data }` or a JSON round trip makes `data.id` resolve through the prototype.
    const body = JSON.parse('{"provider_id":"pp_monei_monei","data":{"__proto__":{"id":"pay_x"}}}');
    expect(createSession(body).status).toBe(400);
  });

  it("allows the documented keys, nested reserved names and other cases", () => {
    // Bug: storefront checkouts refused. The provider reads only top-level keys, and
    // JSON keys are case-sensitive, so `ID` and `metadata.id` never reach a MONEI call.
    const data = {
      return_url: "https://shop.test/return",
      monei_session_id: "cart_1",
      save_card: true,
      billing_country: "es",
      expected_amount: "22.50",
      ID: "pay_x",
      metadata: { id: "pay_x", session_id: "payses_x" },
    };
    expect(createSession({ provider_id: "pp_monei_monei", data }).next).toHaveBeenCalledWith();
    expect(createSession({ provider_id: "pp_monei_monei" }).next).toHaveBeenCalledWith();
  });

  it("does not touch other providers' session data", () => {
    // Bug: a Stripe session with `data.amount` is refused in the same store.
    expect(
      createSession({ provider_id: "pp_stripe_stripe", data: { id: "x" } }).next,
    ).toHaveBeenCalledWith();
  });

  it("is registered on the core create-session route", () => {
    // Bug: a wrong matcher or method leaves the guard unmounted.
    const route = middlewares.routes?.find(
      (r) => r.matcher === "/store/payment-collections/:id/payment-sessions",
    );
    expect(route?.methods).toEqual(["POST"]);
    expect(route?.middlewares).toContain(refuseReservedMoneiSessionData);
  });
});

describe("GET /store/monei/payment-status", () => {
  const status = (query: Record<string, unknown>) =>
    dispatch("GET", "/store/monei/payment-status", paymentStatus as Handler, { query });

  it("gives a guest who holds the cart id the live MONEI status", async () => {
    // Bug: guests are refused (the return page needs it before any login), or the
    // status comes from Medusa, which never records a failure.
    mock
      .onGet(`${API}/payments/pay_G`)
      .reply(200, moneiPayment({ id: "pay_G", orderId: "payses_G", status: "FAILED" }));

    const { status: code, body } = await status({ cart_id: "cart_G", session_id: "payses_G" });

    expect(code).toBe(200);
    expect(body).toEqual({ status: "error" });
  });

  it("refuses a session of another cart without calling MONEI", async () => {
    // Bug: any session id leaks the payment status of someone else's cart.
    const { status: code } = await status({ cart_id: "cart_G", session_id: "payses_A" });

    expect(code).toBe(403);
    expect(mock.history.get).toHaveLength(0);
  });

  it("refuses a MONEI payment bound to another session", async () => {
    // Bug: a session pointing at another session's payment reports that payment's status.
    mock.onGet(`${API}/payments/pay_G`).reply(200, moneiPayment({ id: "pay_G", status: "FAILED" }));

    const { status: code } = await status({ cart_id: "cart_G", session_id: "payses_G" });

    expect(code).toBe(403);
  });

  it("refuses an array cart id before any query", async () => {
    // Bug: `?cart_id[]=` reaches the query filters as an array.
    const { status: code } = await status({ cart_id: ["cart_G"], session_id: "payses_G" });

    expect(code).toBe(400);
    expect(graph).not.toHaveBeenCalled();
  });
});

describe("GET /store/monei/config", () => {
  const config = () => dispatch("GET", "/store/monei/config", getConfig as Handler, {});

  it("reports capture by default", async () => {
    // Bug: an unset option reads as AUTH, and PayPal loads with intent=authorize for a SALE payment.
    expect(await config()).toEqual({ status: 200, body: { capture: true } });
  });

  it("reports capture: false so PayPal authorizes", async () => {
    // Bug: PayPal keeps intent=capture while the plugin creates AUTH payments.
    const deps = scope.resolve("configModule") as any;
    deps.modules.payment.options.providers[0].options.capture = false;

    expect(await config()).toEqual({ status: 200, body: { capture: false } });
  });

  it("has no authentication middleware", () => {
    // Bug: guests get 401 and the PayPal button never mounts.
    expect(middlewares.routes?.find((r) => r.matcher === "/store/monei/config")).toBeUndefined();
  });
});

describe("saved-card routes: authentication", () => {
  const routes: [string, string, Handler, Record<string, unknown>][] = [
    ["GET", "/store/monei/payment-methods", listMethods as Handler, {}],
    [
      "DELETE",
      "/store/monei/payment-methods/:id",
      deleteMethod as Handler,
      { params: { id: opaqueId(TOKEN_A) } },
    ],
    [
      "POST",
      "/store/monei/confirm",
      confirm as Handler,
      { body: { payment_session_id: "payses_A", payment_method_id: opaqueId(TOKEN_A) } },
    ],
  ];
  const forms: [string, Record<string, unknown>][] = [
    ["no credentials", {}],
    [
      "an admin user session",
      {
        session: {
          auth_context: {
            actor_id: "user_1",
            actor_type: "user",
            auth_identity_id: "ai_9",
            app_metadata: {},
          },
        },
      },
    ],
    ["a forged bearer token", { headers: { authorization: "Bearer not.a.jwt" } }],
  ];

  for (const [method, matcher, handler, req] of routes) {
    for (const [form, credentials] of forms) {
      it(`${method} ${matcher} with ${form} → 401, no query, no MONEI call`, async () => {
        // Bug: a route left unauthenticated exposes or spends a customer's saved cards.
        const { status } = await dispatch(method, matcher, handler, { ...req, ...credentials });

        expect(status).toBe(401);
        expect(graph).not.toHaveBeenCalled();
        expect(
          mock.history.get.length + mock.history.post.length + mock.history.delete.length,
        ).toBe(0);
      });
    }
  }

  it("payment-status has no authentication middleware", () => {
    // Bug: guests on the return page get 401.
    expect(
      middlewares.routes?.find((r) => r.matcher === "/store/monei/payment-status"),
    ).toBeUndefined();
  });
});

describe("GET /store/monei/payment-methods", () => {
  const list = (customerId: string) =>
    dispatch("GET", "/store/monei/payment-methods", listMethods as Handler, asCustomer(customerId));

  it("lists the customer's cards with an opaque id instead of the token", async () => {
    // Bug: the permanent token reaches the browser (also checked after each test).
    mock.onGet(`${API}/customers/mcus_A/payment-methods`).reply(200, [savedCard(TOKEN_A, "4242")]);

    const { body } = await list("cus_A");

    expect(body).toEqual({
      payment_methods: [
        {
          // sha256("tok_permanent_ANA_7f3c")
          id: "60e3b6af761ba9aa25d9b312e7b9bb5bf39a145ed4a95ecbc2a4c147f3d90808",
          brand: "visa",
          last4: "4242",
          expires_at: 1924991999,
        },
      ],
    });
  });

  it("returns an empty list when the MONEI customer was deleted", async () => {
    // Bug: a customer deleted at MONEI breaks the checkout of a logged-in shopper.
    mock
      .onGet(`${API}/customers/mcus_A/payment-methods`)
      .reply(404, { statusCode: 404, message: "Not found" });

    expect((await list("cus_A")).body).toEqual({ payment_methods: [] });
  });

  it("returns an empty list without calling MONEI when the customer has no account holder", async () => {
    // Bug: MONEI is called with an undefined customer id.
    expect((await list("cus_C")).body).toEqual({ payment_methods: [] });
    expect(mock.history.get).toHaveLength(0);
  });

  it("lists the cards of every card holder when the shopper has two", async () => {
    // Bug: only the first holder's cards are listed, so a card saved in a session
    // made with the second holder can never reach the confirm route.
    mock.onGet(`${API}/customers/mcus_D1/payment-methods`).reply(200, [savedCard(TOKEN_A, "4242")]);
    mock.onGet(`${API}/customers/mcus_D2/payment-methods`).reply(200, [savedCard(TOKEN_B, "1881")]);

    const { body } = await list("cus_D");

    expect(body.payment_methods.map((m: { last4: string }) => m.last4)).toEqual(["4242", "1881"]);
  });
});

describe("DELETE /store/monei/payment-methods/:id", () => {
  const remove = (customerId: string, id: unknown) =>
    dispatch("DELETE", "/store/monei/payment-methods/:id", deleteMethod as Handler, {
      ...asCustomer(customerId),
      params: { id },
    });

  beforeEach(() => {
    mock.onGet(`${API}/customers/mcus_A/payment-methods`).reply(200, [savedCard(TOKEN_A, "4242")]);
    mock
      .onDelete(new RegExp(`${API}/customers/mcus_A/payment-methods/.+`))
      .reply(200, { id: TOKEN_A, deleted: true });
  });

  it("deletes the card the opaque id maps to", async () => {
    // Bug: the opaque id, not the token, is sent to MONEI.
    const { status } = await remove("cus_A", opaqueId(TOKEN_A));

    expect(status).toBe(200);
    expect(mock.history.delete.map((r) => r.url)).toEqual([
      `${API}/customers/mcus_A/payment-methods/${TOKEN_A}`,
    ]);
  });

  it.each([
    ["another customer's opaque id", opaqueId(TOKEN_B)],
    ["a raw token", TOKEN_A],
  ])("refuses %s with 404 and deletes nothing", async (_form, id) => {
    // Bug: a shopper deletes a card that is not in their own list.
    const { status } = await remove("cus_A", id);

    expect(status).toBe(404);
    expect(mock.history.delete).toHaveLength(0);
  });

  it("deletes a card of the second card holder under that MONEI customer", async () => {
    // Bug: the delete goes to the first holder, and MONEI refuses a token of another customer.
    mock.onGet(`${API}/customers/mcus_D1/payment-methods`).reply(200, []);
    mock.onGet(`${API}/customers/mcus_D2/payment-methods`).reply(200, [savedCard(TOKEN_B, "1881")]);
    mock
      .onDelete(new RegExp(`${API}/customers/mcus_D2/payment-methods/.+`))
      .reply(200, { id: TOKEN_B, deleted: true });

    const { status } = await remove("cus_D", opaqueId(TOKEN_B));

    expect(status).toBe(200);
    expect(mock.history.delete.map((r) => r.url)).toEqual([
      `${API}/customers/mcus_D2/payment-methods/${TOKEN_B}`,
    ]);
  });
});

describe("POST /store/monei/confirm", () => {
  beforeEach(() => {
    mock.onGet(`${API}/customers/mcus_A/payment-methods`).reply(200, [savedCard(TOKEN_A, "4242")]);
    mock.onGet(`${API}/payments/pay_A`).reply(200, moneiPayment());
  });

  it("confirms with the saved token and returns the 3DS redirect without the token", async () => {
    // Bugs: the opaque id is sent as the token; the challenge URL is dropped, so
    // the storefront cannot send the buyer to 3DS; the token leaks in the reply.
    mock.onPost(`${API}/payments/pay_A/confirm`).reply(200, {
      ...moneiPayment({ paymentToken: TOKEN_A }),
      nextAction: {
        type: "CHALLENGE",
        mustRedirect: true,
        redirectUrl: "https://secure.monei.com/3ds/pay_A",
      },
    });

    const { status, body } = await confirmAs("cus_A", {
      payment_session_id: "payses_A",
      payment_method_id: opaqueId(TOKEN_A),
    });

    expect(status).toBe(200);
    expect(body).toEqual({ status: "pending", redirect_url: "https://secure.monei.com/3ds/pay_A" });
    expect(JSON.parse(mock.history.post[0].data)).toEqual({ paymentToken: TOKEN_A });
  });

  it.each([
    ["an opaque id not in the customer's list", opaqueId(TOKEN_B)],
    ["a raw token", TOKEN_A],
  ])("refuses %s with 404 and no confirm call", async (_form, id) => {
    // Bug: a shopper pays with a card that is not theirs.
    const { status } = await confirmAs("cus_A", {
      payment_session_id: "payses_A",
      payment_method_id: id,
    });

    expect(status).toBe(404);
    expect(mock.history.post).toHaveLength(0);
  });

  it.each([
    ["a session of another customer's cart", "cus_A", "payses_B", 403],
    ["a session of a guest cart", "cus_A", "payses_G", 403],
    ["a session of a non-card MONEI provider", "cus_A", "payses_Z", 400],
    ["a customer with no MONEI account holder", "cus_C", "payses_C", 404],
  ])("refuses %s before calling MONEI", async (_form, customerId, sessionId, code) => {
    // Bug: a saved card pays a session the shopper does not own, or one MONEI
    // cannot bind to the card's customer.
    const { status } = await confirmAs(customerId, {
      payment_session_id: sessionId,
      payment_method_id: opaqueId(TOKEN_A),
    });

    expect(status).toBe(code);
    expect(mock.history.get.length + mock.history.post.length).toBe(0);
  });

  it.each([
    ["no customerId", { customerId: undefined }],
    ["another customer's customerId", { customerId: "mcus_B" }],
    ["the orderId of another session", { orderId: "payses_B" }],
  ])("refuses a MONEI payment with %s and does not confirm", async (_form, overrides) => {
    // Bug: MONEI checks a token against the customer only when the payment has
    // one, so a customer-less payment would accept any token.
    mock.onGet(`${API}/payments/pay_A`).reply(200, moneiPayment(overrides));

    const { status } = await confirmAs("cus_A", {
      payment_session_id: "payses_A",
      payment_method_id: opaqueId(TOKEN_A),
    });

    expect(status).toBe(403);
    expect(mock.history.post).toHaveLength(0);
  });

  it("pays with a card of the session's MONEI customer when the shopper has two", async () => {
    // Bug: the first card holder was assumed; a session made with the second one was
    // refused (403), and its saved card could never pay.
    mock
      .onGet(`${API}/payments/pay_D`)
      .reply(200, moneiPayment({ id: "pay_D", orderId: "payses_D", customerId: "mcus_D2" }));
    mock.onGet(`${API}/customers/mcus_D2/payment-methods`).reply(200, [savedCard(TOKEN_A, "4242")]);
    mock.onPost(`${API}/payments/pay_D/confirm`).reply(200, moneiPayment({ status: "SUCCEEDED" }));

    const { status } = await confirmAs("cus_D", {
      payment_session_id: "payses_D",
      payment_method_id: opaqueId(TOKEN_A),
    });

    expect(status).toBe(200);
    expect(JSON.parse(mock.history.post[0].data)).toEqual({ paymentToken: TOKEN_A });
  });

  it("refuses an object as payment_session_id before any query", async () => {
    // Bug: an operator object reaches the query filters and matches other rows.
    const { status } = await confirmAs("cus_A", {
      payment_session_id: { $ne: null },
      payment_method_id: opaqueId(TOKEN_A),
    });

    expect(status).toBe(400);
    expect(graph).not.toHaveBeenCalled();
  });
});
