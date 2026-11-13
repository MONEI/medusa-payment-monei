import type {
  AuthorizePaymentInput,
  BigNumberInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  Logger,
  PaymentAddressDTO,
  PaymentCustomerDTO,
  PaymentProviderContext,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types";
import {
  AbstractPaymentProvider,
  MedusaError,
  PaymentActions,
  PaymentSessionStatus,
} from "@medusajs/framework/utils";
import {
  type CreatePaymentRequest,
  type Monei,
  type Payment,
  PaymentCancellationReason,
  PaymentStatus,
  PaymentTransactionType,
} from "@monei-js/node-sdk";
import type { MoneiOptions } from "../types";
import { fromMinorUnits, toMinorUnits } from "../utils/amount";
import { compact, fullName } from "../utils/fields";
import {
  ALREADY_VOID,
  CANCELABLE,
  CAPTURED,
  REFUNDED,
  toSessionStatus,
  toWebhookAction,
} from "../utils/status";
import { createMoneiClient, validateOptions } from "./client";
import { callMonei, isClientError, toMedusaError } from "./errors";
import { PROVIDER_ID, sessionIdOf } from "./ids";
import { verifyWebhook } from "./webhook";

/** The keys every payment provider method returns in `data`; the store cart API exposes them. */
type MoneiSessionData = {
  id: string;
  session_id: string | undefined;
  amount: number;
  currency: string;
  status: PaymentStatus;
  redirect_url: string | undefined;
  monei_customer_missing: boolean;
};

export type ResolvedCustomer = { customerId?: string; missing: boolean };

// A Record, not a tuple: a key added to MoneiSessionData fails to compile until listed here.
export const SESSION_DATA_KEYS = Object.keys({
  id: true,
  session_id: true,
  amount: true,
  currency: true,
  status: true,
  redirect_url: true,
  monei_customer_missing: true,
} satisfies Record<keyof MoneiSessionData, true>) as (keyof MoneiSessionData)[];

/** Carried forward by every method: Medusa replaces `session.data` with each output. */
function customerMissing(data: Record<string, unknown> | undefined): boolean {
  return data?.monei_customer_missing === true;
}

const COUNTRY_CODE = /^[A-Za-z]{2}$/;

/** `billing_country` from the storefront: an ISO 3166-1 alpha-2 code, or 400. */
function billingCountry(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !COUNTRY_CODE.test(value)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "`billing_country` must be a 2-letter ISO country code",
    );
  }
  return value.toUpperCase();
}

/** Express: `expected` (major units) is the session amount once both are rounded to cents. */
function matchesAmount(expected: unknown, minorAmount: number, currency: string): boolean {
  if (typeof expected !== "number" && typeof expected !== "string") return false;
  try {
    return toMinorUnits(expected, currency).amount === minorAmount;
  } catch {
    return false;
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Added to `cancelUrl` only. MONEI appends nothing on a hosted-page cancel and the
 * payment stays `PENDING`, so without it a cancel looks like a payment in progress.
 */
const CANCELED_PARAM = "monei_canceled";

function withSessionId(returnUrl: string, sessionId: string, canceled = false): string {
  let url: URL;
  try {
    url = new URL(returnUrl);
  } catch {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `\`return_url\` must be an absolute URL, got "${returnUrl}"`,
    );
  }
  url.searchParams.set("session_id", sessionId);
  if (canceled) url.searchParams.set(CANCELED_PARAM, "1");
  return url.toString();
}

/**
 * `country` is the checkout billing country sent by the storefront. The customer's
 * saved address is sent only when it is in that country (or none was sent): its
 * street lines never go out with another country.
 */
function customerFields(
  customer: PaymentCustomerDTO | undefined,
  country: string | undefined,
): Pick<CreatePaymentRequest, "customer" | "billingDetails"> {
  // Customer addresses carry names; `PaymentAddressDTO` does not declare them.
  const saved = customer?.billing_address as
    | (PaymentAddressDTO & { first_name?: string | null; last_name?: string | null })
    | null
    | undefined;
  // Medusa stores lowercase; MONEI routing compares the country case-sensitively.
  const savedCountry = saved?.country_code?.toUpperCase();
  const billing = saved && (!country || country === savedCountry) ? saved : undefined;
  const name = fullName(customer?.first_name, customer?.last_name);
  return {
    customer: customer
      ? compact({ email: customer.email, name, phone: customer.phone })
      : undefined,
    billingDetails: compact({
      name: fullName(billing?.first_name, billing?.last_name) ?? name,
      email: customer?.email,
      phone: billing?.phone ?? customer?.phone,
      company: billing?.company ?? customer?.company_name,
      address: billing
        ? compact({
            country: savedCountry,
            city: billing.city,
            line1: billing.address_1,
            line2: billing.address_2,
            zip: billing.postal_code,
            state: billing.province,
          })
        : country
          ? { country }
          : undefined,
    }),
  };
}

/** The payment module's internal session service, in the provider's cradle. */
type SessionLookup = {
  list(
    filters: { id: string },
    config: { select: string[] },
  ): Promise<
    {
      id: string;
      amount?: BigNumberInput;
      currency_code?: string;
      authorized_at?: Date | string | null;
    }[]
  >;
};

export abstract class MoneiBase extends AbstractPaymentProvider<MoneiOptions> {
  /** The single MONEI payment method this provider offers, e.g. `["card"]`. */
  protected abstract readonly allowedPaymentMethods: string[];
  /** Whether `capture: false` turns payments into AUTH (card and PayPal only). */
  protected abstract readonly authAllowed: boolean;

  protected readonly options_: MoneiOptions;
  protected readonly client_: Monei;
  protected readonly logger_: Logger;

  static validateOptions(options: Record<string, unknown>): void {
    validateOptions(options);
  }

  constructor(cradle: Record<string, unknown>, options: MoneiOptions) {
    super(cradle, options);
    this.options_ = validateOptions(options);
    this.client_ = createMoneiClient(this.options_);
    this.logger_ = cradle.logger as Logger;
  }

  protected call<T>(action: string, fn: () => Promise<T>): Promise<T> {
    return callMonei(action, fn);
  }

  /** The MONEI customer of the session; only the card provider has account holders. */
  protected async resolveCustomer(_context?: PaymentProviderContext): Promise<ResolvedCustomer> {
    return { missing: false };
  }

  /** `data` is the stored session data: it carries the session id and the customer flag. */
  protected toSessionData(
    payment: Payment,
    data: Record<string, unknown> | undefined,
    sessionId = stringOrUndefined(data?.session_id),
  ): MoneiSessionData {
    return {
      id: payment.id,
      session_id: sessionId,
      amount: fromMinorUnits(payment.amount, payment.currency),
      currency: payment.currency,
      status: payment.status,
      redirect_url: payment.nextAction?.redirectUrl,
      monei_customer_missing: customerMissing(data),
    };
  }

  protected async fetchPayment(data: Record<string, unknown> | undefined): Promise<Payment> {
    const id = data?.id;
    if (typeof id !== "string" || !id) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "MONEI payment id is missing");
    }
    return this.call("get payment", () => this.client_.payments.get(id));
  }

  async initiatePayment({
    amount,
    currency_code,
    data,
    context,
  }: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const minor = toMinorUnits(amount, currency_code);
    const sessionId = data?.session_id;
    if (typeof sessionId !== "string" || !sessionId) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "Payment session id is missing");
    }

    // Express checkout: the amount the buyer saw in the wallet sheet, in major units.
    // The session amount keeps tax maths decimals (6.0379); the wallet showed 6.04.
    const expected = data?.expected_amount;
    if (
      expected !== undefined &&
      expected !== null &&
      !matchesAmount(expected, minor.amount, minor.currency)
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Expected amount ${String(expected)} does not match the cart amount ${String(amount)}`,
      );
    }

    const country = billingCountry(data?.billing_country);
    const customer = await this.resolveCustomer(context);
    const saveCard = data?.save_card === true;
    if (saveCard && !customer.customerId) {
      this.logger_.warn(
        `MONEI initiatePayment: session ${sessionId} asked to save the card, but it has no MONEI customer (guest, or the customer was deleted); the card is not saved`,
      );
    }
    const returnUrl = stringOrUndefined(data?.return_url);
    const completeUrl = returnUrl !== undefined ? withSessionId(returnUrl, sessionId) : undefined;
    const cancelUrl =
      returnUrl !== undefined ? withSessionId(returnUrl, sessionId, true) : undefined;
    const moneiSessionId =
      typeof data?.monei_session_id === "string" && data.monei_session_id
        ? data.monei_session_id
        : undefined;

    const request: CreatePaymentRequest = {
      amount: minor.amount,
      currency: minor.currency,
      orderId: sessionId,
      allowedPaymentMethods: this.allowedPaymentMethods,
      transactionType:
        this.options_.capture === false && this.authAllowed
          ? PaymentTransactionType.AUTH
          : PaymentTransactionType.SALE,
      callbackUrl: `${this.options_.backendUrl}/hooks/payment/${this.getIdentifier()}_${PROVIDER_ID}`,
      completeUrl,
      failUrl: completeUrl,
      cancelUrl,
      sessionId: moneiSessionId,
      customerId: customer.customerId,
      generatePaymentToken: customer.customerId && saveCard ? true : undefined,
      ...customerFields(context?.customer, country),
    };

    const payment = await this.call("create payment", () => this.client_.payments.create(request));

    return {
      id: payment.id,
      status: toSessionStatus(payment.status, this.logger_),
      // `data` is storefront input here: the flag comes from the MONEI customer lookup.
      data: this.toSessionData(payment, { monei_customer_missing: customer.missing }, sessionId),
    };
  }

  async updatePayment({
    amount,
    currency_code,
    data,
  }: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    const sameCurrency =
      typeof data?.currency === "string" &&
      data.currency.toUpperCase() === currency_code.toUpperCase();
    // Compare in minor units: the session amount may carry more decimals than the
    // stored amount, which comes back rounded from MONEI.
    const sameAmount =
      sameCurrency && (typeof data?.amount === "number" || typeof data?.amount === "string")
        ? toMinorUnits(data.amount, currency_code).amount ===
          toMinorUnits(amount, currency_code).amount
        : false;
    if (!sameCurrency || !sameAmount) {
      // Medusa deletes and recreates sessions on a total change; it never updates the amount.
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "A MONEI payment amount or currency cannot change; create a new payment session",
      );
    }
    return { data };
  }

  /** Best effort: a throw here would fail every later cart change in Medusa. */
  async deletePayment({ data }: DeletePaymentInput): Promise<DeletePaymentOutput> {
    const id = data?.id;
    const sessionId = data?.session_id;
    if (typeof id !== "string" || typeof sessionId !== "string") {
      this.logger_.warn(
        "MONEI deletePayment: no payment id in the session data, nothing to cancel",
      );
      return {};
    }
    let status: string | undefined;
    let amount: string | undefined;
    try {
      const payment = await this.client_.payments.get(id);
      // Core passes only `data`, never the deleted session's id, and `data` may not come
      // from this provider: cancel only a payment that belongs to the named session.
      if (payment.orderId !== sessionId) {
        this.logger_.warn(
          `MONEI deletePayment: payment ${id} belongs to order ${payment.orderId}, not session ${sessionId}; not canceled`,
        );
        return {};
      }
      // Never cancel the payment of an authorized session: it backs an order (or a
      // completion core already compensates). Only core sets `authorized_at`. The store
      // middleware refuses MONEI keys in storefront session data.
      const [session] = await (this.container.paymentSessionService as SessionLookup).list(
        { id: sessionId },
        { select: ["id", "authorized_at"] },
      );
      if (!session || session.authorized_at) {
        this.logger_.warn(
          `MONEI deletePayment: session ${sessionId} of payment ${id} ${session ? "is authorized" : "no longer exists"}; not canceled`,
        );
        return {};
      }
      status = payment.status;
      amount = `${fromMinorUnits(payment.amount, payment.currency)} ${payment.currency}`;
      if (payment.status === PaymentStatus.SUCCEEDED) {
        this.logger_.error(
          `MONEI deletePayment: payment ${id} of ${amount} is SUCCEEDED but its session ${sessionId} was deleted; refund it in the MONEI dashboard if no order was created`,
        );
      } else if (CANCELABLE.has(payment.status)) {
        await this.client_.payments.cancel(id, {
          cancellationReason: PaymentCancellationReason.REQUESTED_BY_CUSTOMER,
        });
      }
    } catch (error) {
      const message = `MONEI deletePayment: could not cancel payment ${id}: ${toMedusaError(error, "cancel payment").message}`;
      // An authorization left behind holds the buyer's money until it expires.
      if (status === PaymentStatus.AUTHORIZED) {
        this.logger_.error(`${message} (${amount}, session ${sessionId})`);
      } else {
        this.logger_.warn(message);
      }
    }
    return {};
  }

  async authorizePayment({
    data,
    context,
  }: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const payment = await this.fetchPayment(data);
    const sessionId = context?.idempotency_key;
    const refuse = (reason: string): AuthorizePaymentOutput => {
      this.logger_.error(`MONEI authorizePayment: payment ${payment.id} ${reason}`);
      // Medusa stores this data and the store cart API returns it: never the fetched payment.
      const stored = Object.fromEntries(SESSION_DATA_KEYS.map((key) => [key, data?.[key]]));
      return {
        status: PaymentSessionStatus.ERROR,
        data: { ...stored, monei_customer_missing: customerMissing(data) },
      };
    };
    if (!sessionId || payment.orderId !== sessionId) {
      return refuse(`belongs to order ${payment.orderId}, not session ${sessionId}`);
    }
    // Medusa passes no amount and records the session amount as paid. A 0.1.x
    // payment of the session took 1/100 of it.
    const [session] = await (this.container.paymentSessionService as SessionLookup).list(
      { id: sessionId },
      { select: ["id", "amount", "raw_amount", "currency_code"] },
    );
    if (!session || session.amount === undefined || !session.currency_code) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `MONEI authorizePayment: session ${sessionId} or its amount was not found`,
      );
    }
    const expected = toMinorUnits(session.amount, session.currency_code);
    if (
      payment.amount !== expected.amount ||
      payment.currency?.toUpperCase() !== expected.currency
    ) {
      const action = CANCELABLE.has(payment.status)
        ? "; cancel it in the MONEI dashboard"
        : payment.status === PaymentStatus.SUCCEEDED ||
            payment.status === PaymentStatus.PARTIALLY_REFUNDED
          ? "; refund it in the MONEI dashboard"
          : "";
      return refuse(
        `of ${payment.amount} ${payment.currency} (minor units, ${payment.status}) does not match session ${sessionId} of ${expected.amount} ${expected.currency}; no order is created${action}`,
      );
    }
    return {
      // An order must not be created for money that was already returned.
      status: REFUNDED.has(payment.status)
        ? PaymentSessionStatus.ERROR
        : toSessionStatus(payment.status, this.logger_),
      data: this.toSessionData(payment, data, sessionId),
    };
  }

  async getPaymentStatus({ data }: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const payment = await this.fetchPayment(data);
    return {
      status: toSessionStatus(payment.status, this.logger_),
      data: this.toSessionData(payment, data),
    };
  }

  async retrievePayment({ data }: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    const payment = await this.fetchPayment(data);
    return {
      data: this.toSessionData(payment, data),
    };
  }

  async capturePayment({ data }: CapturePaymentInput): Promise<CapturePaymentOutput> {
    const payment = await this.fetchPayment(data);
    if (payment.status === PaymentStatus.SUCCEEDED) {
      return { data: this.toSessionData(payment, data) };
    }
    let captured: Payment;
    try {
      // Medusa passes no amount: always a full capture.
      captured = await this.client_.payments.capture(payment.id);
    } catch (error) {
      if (isClientError(error)) throw toMedusaError(error, "capture payment");
      // Safe to re-fetch once: the capture flips the status, and MONEI refuses a second capture.
      const current = await this.client_.payments.get(payment.id).catch(() => undefined);
      if (current?.status !== PaymentStatus.SUCCEEDED) {
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          `MONEI capture of payment ${payment.id} got no clear answer (${toMedusaError(error, "capture payment").message}) and the payment is ${current?.status ?? "unknown"}; check the MONEI dashboard before retrying`,
        );
      }
      captured = current;
    }
    return { data: this.toSessionData(captured, data) };
  }

  async cancelPayment({ data }: CancelPaymentInput): Promise<CancelPaymentOutput> {
    const payment = await this.fetchPayment(data);
    if (ALREADY_VOID.has(payment.status)) {
      return { data: this.toSessionData(payment, data) };
    }
    if (payment.status !== PaymentStatus.AUTHORIZED) {
      // Returning would let Medusa set `canceled_at` on money that was charged.
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        CAPTURED.has(payment.status)
          ? `MONEI payment ${payment.id} is captured, refund it instead`
          : `MONEI payment ${payment.id} is ${payment.status} and cannot be canceled`,
      );
    }
    const canceled = await this.call("cancel payment", () =>
      this.client_.payments.cancel(payment.id, {
        cancellationReason: PaymentCancellationReason.REQUESTED_BY_CUSTOMER,
      }),
    );
    return { data: this.toSessionData(canceled, data) };
  }

  async refundPayment({ data, amount }: RefundPaymentInput): Promise<RefundPaymentOutput> {
    if (typeof data?.currency !== "string") {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "MONEI payment currency is missing");
    }
    const minor = toMinorUnits(amount, data.currency);
    const payment = await this.fetchPayment(data);
    const baseline = payment.refundedAmount ?? 0;

    const sentAt = new Date().toISOString();
    let refunded: Payment;
    let outcome = "ok";
    try {
      refunded = await this.client_.payments.refund(payment.id, { amount: minor.amount });
    } catch (error) {
      const refused = isClientError(error);
      outcome = refused ? "error" : "no_answer";
      // No re-fetch: another refund can move `refundedAmount` too, so a re-fetch
      // cannot prove this one was applied.
      throw refused
        ? toMedusaError(error, "refund payment")
        : new MedusaError(
            MedusaError.Types.UNEXPECTED_STATE,
            `MONEI refund of payment ${payment.id} got no clear answer (${toMedusaError(error, "refund payment").message}); it may have been applied, check the MONEI dashboard before retrying`,
          );
    } finally {
      // Both timestamps let an operator match an unapplied refund with an equal refund
      // sent just before it.
      this.logger_.info(
        `MONEI refund POST: payment=${payment.id} amount=${minor.amount} currency=${minor.currency} sent_at=${sentAt} answered_at=${new Date().toISOString()} outcome=${outcome}`,
      );
    }

    // MONEI can merge two equal refunds of one payment sent close together.
    if ((refunded.refundedAmount ?? 0) < baseline + minor.amount) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `MONEI did not apply the refund of ${minor.amount} ${minor.currency} to payment ${payment.id} (refunded ${refunded.refundedAmount ?? 0}, was ${baseline}); check the MONEI dashboard before retrying`,
      );
    }
    return { data: this.toSessionData(refunded, data) };
  }

  /**
   * The signed body is only a pointer: the session id, status and amount come from
   * the payment fetched from MONEI.
   */
  async getWebhookActionAndData(
    payload: ProviderWebhookPayload["payload"],
  ): Promise<WebhookActionResult> {
    const notSupported = (reason: string): WebhookActionResult => {
      this.logger_.warn(`MONEI webhook ignored: ${reason}`);
      return { action: PaymentActions.NOT_SUPPORTED };
    };

    const verified = verifyWebhook(this.client_, payload);
    if ("refused" in verified) return notSupported(verified.refused);
    const id = verified.paymentId;

    // A throw lets the event bus retry; a dropped paid callback would leave the cart open.
    const payment = await this.call("get payment", () => this.client_.payments.get(id));
    const sessionId = sessionIdOf(payment.orderId);
    if (!sessionId) {
      return notSupported(
        `payment ${payment.id} has no Medusa session (orderId ${payment.orderId})`,
      );
    }
    // The callback of a deleted session must not complete any cart. The reconcile
    // subscriber reports the orphan payment.
    const sessions = await (this.container.paymentSessionService as SessionLookup).list(
      { id: sessionId },
      { select: ["id"] },
    );
    if (!sessions.length) {
      return notSupported(`payment ${payment.id}: session ${sessionId} no longer exists`);
    }
    return {
      action: toWebhookAction(payment.status),
      data: {
        session_id: sessionId,
        amount: fromMinorUnits(payment.amount, payment.currency),
      },
    };
  }
}
