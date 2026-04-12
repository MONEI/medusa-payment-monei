import { AbstractPaymentProvider, BigNumber } from "@medusajs/framework/utils"
import { MedusaError } from "@medusajs/framework/utils"
import {
  AuthorizePaymentInput,
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
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  ProviderWebhookPayload,
  WebhookActionResult,
  Logger,
  PaymentSessionStatus,
} from "@medusajs/framework/types"
import { Monei } from "@monei-js/node-sdk"

/**
 * MONEI payment statuses returned by the API.
 * @see https://docs.monei.com/apis/rest/payments/
 */
enum MoneiPaymentStatus {
  PENDING = "PENDING",
  SUCCEEDED = "SUCCEEDED",
  AUTHORIZED = "AUTHORIZED",
  FAILED = "FAILED",
  CANCELED = "CANCELED",
  EXPIRED = "EXPIRED",
  REFUNDED = "REFUNDED",
  PARTIALLY_REFUNDED = "PARTIALLY_REFUNDED",
}

export type MoneiPaymentProviderOptions = {
  /**
   * MONEI API Key from Dashboard → Settings → API Access.
   * Starts with `pk_test_` (test) or `pk_live_` (production).
   */
  apiKey: string
  /**
   * Whether to auto-capture payments on authorization (default: false).
   * When false, payments are created with transactionType: AUTH and must
   * be captured separately. When true, transactionType: SALE is used.
   */
  capture?: boolean
}

type InjectedDependencies = {
  logger: Logger
}

class MoneiPaymentProviderService extends AbstractPaymentProvider<MoneiPaymentProviderOptions> {
  static identifier = "monei"

  protected logger_: Logger
  protected options_: MoneiPaymentProviderOptions
  protected monei_: InstanceType<typeof Monei>

  constructor(container: InjectedDependencies, options: MoneiPaymentProviderOptions) {
    super(container, options)

    this.logger_ = container.logger
    this.options_ = options
    this.monei_ = new Monei(options.apiKey)
  }

  static validateOptions(options: Record<any, any>) {
    if (!options.apiKey) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "MONEI API key is required in the provider's options. " +
          "Get it from MONEI Dashboard → Settings → API Access."
      )
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Map MONEI payment status to Medusa PaymentSessionStatus.
   */
  private getStatus(moneiStatus: string): PaymentSessionStatus {
    switch (moneiStatus) {
      case MoneiPaymentStatus.AUTHORIZED:
        return "authorized" as PaymentSessionStatus
      case MoneiPaymentStatus.SUCCEEDED:
      case MoneiPaymentStatus.REFUNDED:
      case MoneiPaymentStatus.PARTIALLY_REFUNDED:
        return "captured" as PaymentSessionStatus
      case MoneiPaymentStatus.CANCELED:
        return "canceled" as PaymentSessionStatus
      case MoneiPaymentStatus.FAILED:
      case MoneiPaymentStatus.EXPIRED:
        return "error" as PaymentSessionStatus
      case MoneiPaymentStatus.PENDING:
      default:
        return "pending" as PaymentSessionStatus
    }
  }

  /**
   * MONEI amounts are integers in smallest currency unit (cents).
   * Medusa v2 amounts are also in smallest unit, so we just ensure integer.
   */
  private toMoneiAmount(amount: number | BigNumber): number {
    const num = typeof amount === "number" ? amount : Number(amount)
    return Math.round(num)
  }

  /**
   * Direct REST call to MONEI API.
   *
   * Used for capture and cancel — the Node SDK v2 is auto-generated from
   * OpenAPI and likely has monei.payments.capture() / monei.payments.cancel(),
   * but since they're not in the README, we use direct calls for safety.
   *
   * TODO(dima): Confirm SDK methods and replace these calls.
   */
  private async moneiRest(
    path: string,
    method: "GET" | "POST" = "POST",
    body?: Record<string, any>
  ): Promise<Record<string, any>> {
    const url = `https://api.monei.com/v1${path}`
    const headers: Record<string, string> = {
      Authorization: this.options_.apiKey,
      "Content-Type": "application/json",
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!res.ok) {
      const errorBody = await res.text()
      throw new Error(`MONEI API ${res.status}: ${errorBody}`)
    }

    return res.json()
  }

  // ---------------------------------------------------------------------------
  // Core Payment Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Create a MONEI payment when customer selects MONEI at checkout.
   *
   * SDK: monei.payments.create() ✓ (documented)
   * @see https://docs.monei.com/apis/rest/payments-create/
   *
   * Response includes `nextAction.redirectUrl` for the hosted payment page
   * and the payment `id` for use with monei.js embedded components.
   */
  async initiatePayment(
    input: InitiatePaymentInput
  ): Promise<InitiatePaymentOutput> {
    const { amount, currency_code, context } = input

    const sessionId =
      (input.data?.session_id as string) ||
      (context as any)?.session_id ||
      `medusa_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`

    try {
      const payload: Record<string, any> = {
        amount: this.toMoneiAmount(amount as number),
        currency: currency_code.toUpperCase(),
        orderId: sessionId,
        description: `Medusa order ${sessionId}`,
        transactionType: this.options_.capture ? "SALE" : "AUTH",
        metadata: {
          session_id: sessionId,
          source: "medusa",
        },
      }

      // Customer info
      if (context?.customer) {
        const c = context.customer as Record<string, any>
        payload.customer = {
          email: c.email,
          name: c.first_name
            ? `${c.first_name} ${c.last_name || ""}`.trim()
            : undefined,
          phone: c.phone || undefined,
        }
      }

      // Billing address
      if (context?.billing_address) {
        const a = context.billing_address as Record<string, any>
        payload.billingDetails = {
          name: a.first_name
            ? `${a.first_name} ${a.last_name || ""}`.trim()
            : undefined,
          email: (context.customer as any)?.email,
          phone: a.phone || undefined,
          address: {
            country: a.country_code?.toUpperCase(),
            city: a.city,
            line1: a.address_1,
            line2: a.address_2 || undefined,
            zip: a.postal_code,
            state: a.province || undefined,
          },
        }
      }

      // Webhook callback
      if ((context as any)?.webhook_url) {
        payload.callbackUrl = (context as any).webhook_url
      }

      const payment = await this.monei_.payments.create(payload)

      this.logger_.info(
        `MONEI: Created payment ${payment.id} (session: ${sessionId}, ` +
          `amount: ${payment.amount}, status: ${payment.status})`
      )

      return {
        id: payment.id,
        data: {
          id: payment.id,
          status: payment.status,
          amount: payment.amount,
          currency: payment.currency,
          session_id: sessionId,
          redirect_url: payment.nextAction?.redirectUrl || null,
          client_secret: payment.id,
        },
      }
    } catch (error: any) {
      this.logger_.error(
        `MONEI: initiatePayment failed (session: ${sessionId}): ${error.message}`
      )
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Failed to create MONEI payment: ${error.message}`
      )
    }
  }

  /**
   * Authorize the payment — called during cart completion.
   *
   * SDK: monei.payments.get() ✓ (documented)
   *
   * MONEI authorization is async: customer completes 3DS / hosted page,
   * then MONEI webhook fires. This method polls current status.
   * Returns `requires_more` if not yet authorized.
   */
  async authorizePayment(
    input: AuthorizePaymentInput
  ): Promise<AuthorizePaymentOutput> {
    const paymentId = input.data?.id as string

    if (!paymentId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "MONEI payment ID not found in session data"
      )
    }

    try {
      const payment = await this.monei_.payments.get(paymentId)

      this.logger_.info(
        `MONEI: authorizePayment ${paymentId} → ${payment.status}`
      )

      // SALE flow: SUCCEEDED = authorized + captured
      if (
        this.options_.capture &&
        payment.status === MoneiPaymentStatus.SUCCEEDED
      ) {
        return {
          status: "authorized" as PaymentSessionStatus,
          data: { ...input.data, id: payment.id, status: payment.status },
        }
      }

      // AUTH flow: AUTHORIZED = ready to capture
      if (payment.status === MoneiPaymentStatus.AUTHORIZED) {
        return {
          status: "authorized" as PaymentSessionStatus,
          data: { ...input.data, id: payment.id, status: payment.status },
        }
      }

      // PENDING = customer still on hosted page / 3DS
      if (payment.status === MoneiPaymentStatus.PENDING) {
        return {
          status: "requires_more" as PaymentSessionStatus,
          data: { ...input.data, id: payment.id, status: payment.status },
        }
      }

      // Terminal: FAILED, EXPIRED, CANCELED
      return {
        status: this.getStatus(payment.status),
        data: { ...input.data, id: payment.id, status: payment.status },
      }
    } catch (error: any) {
      this.logger_.error(
        `MONEI: authorizePayment failed for ${paymentId}: ${error.message}`
      )
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Failed to authorize MONEI payment: ${error.message}`
      )
    }
  }

  /**
   * Capture a previously authorized payment.
   *
   * REST: POST /v1/payments/{id}/capture
   * Supports partial captures (pass amount).
   *
   * ⏰ Cards = 7 days capture window, Bizum = 30 days.
   *
   * TODO(dima): Replace moneiRest with monei.payments.capture() if available.
   */
  async capturePayment(
    input: CapturePaymentInput
  ): Promise<CapturePaymentOutput> {
    const paymentId = input.data?.id as string

    if (!paymentId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "MONEI payment ID not found in payment data"
      )
    }

    try {
      // Auto-capture: already SUCCEEDED
      if (this.options_.capture) {
        const existing = await this.monei_.payments.get(paymentId)
        if (existing.status === MoneiPaymentStatus.SUCCEEDED) {
          this.logger_.info(`MONEI: ${paymentId} already captured (SALE flow)`)
          return {
            data: {
              ...input.data,
              id: existing.id,
              status: existing.status,
              captured_at: new Date().toISOString(),
            },
          }
        }
      }

      const body: Record<string, any> = {}
      if ((input as any).amount) {
        body.amount = this.toMoneiAmount((input as any).amount)
      }

      const payment = await this.moneiRest(
        `/payments/${paymentId}/capture`,
        "POST",
        Object.keys(body).length > 0 ? body : undefined
      )

      this.logger_.info(
        `MONEI: Captured ${paymentId} (status: ${payment.status})`
      )

      return {
        data: {
          ...input.data,
          id: payment.id,
          status: payment.status,
          captured_at: new Date().toISOString(),
        },
      }
    } catch (error: any) {
      this.logger_.error(
        `MONEI: capturePayment failed for ${paymentId}: ${error.message}`
      )
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Failed to capture MONEI payment: ${error.message}`
      )
    }
  }

  /**
   * Cancel a payment (pre-capture only).
   *
   * REST: POST /v1/payments/{id}/cancel
   *
   * TODO(dima): Replace moneiRest with monei.payments.cancel() if available.
   */
  async cancelPayment(
    input: CancelPaymentInput
  ): Promise<CancelPaymentOutput> {
    const paymentId = input.data?.id as string

    if (!paymentId) {
      return { data: input.data }
    }

    try {
      const payment = await this.moneiRest(
        `/payments/${paymentId}/cancel`,
        "POST"
      )

      this.logger_.info(
        `MONEI: Canceled ${paymentId} (status: ${payment.status})`
      )

      return {
        data: {
          ...input.data,
          id: payment.id,
          status: payment.status,
          canceled_at: new Date().toISOString(),
        },
      }
    } catch (error: any) {
      this.logger_.warn(
        `MONEI: cancelPayment failed for ${paymentId}: ${error.message}`
      )
      return {
        data: { ...input.data, cancel_error: error.message },
      }
    }
  }

  /**
   * Refund a captured payment (full or partial).
   *
   * SDK: monei.refunds.create() ✓ (documented)
   * @see https://docs.monei.com/apis/rest/payments-refund/
   *
   * Cards: refundable within 1 year. Bizum: within 365 days.
   */
  async refundPayment(
    input: RefundPaymentInput
  ): Promise<RefundPaymentOutput> {
    const paymentId = input.data?.id as string

    if (!paymentId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "MONEI payment ID not found in payment data"
      )
    }

    try {
      const refundPayload: Record<string, any> = {
        paymentId,
      }

      if (input.amount) {
        refundPayload.amount = this.toMoneiAmount(input.amount as number)
      }

      const refund = await this.monei_.refunds.create(refundPayload)

      this.logger_.info(
        `MONEI: Refunded ${paymentId} (amount: ${refundPayload.amount || "full"}, ` +
          `refund: ${refund.id})`
      )

      return {
        data: {
          ...input.data,
          id: paymentId,
          refund_id: refund.id,
          refunded_at: new Date().toISOString(),
        },
      }
    } catch (error: any) {
      this.logger_.error(
        `MONEI: refundPayment failed for ${paymentId}: ${error.message}`
      )
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Failed to refund MONEI payment: ${error.message}`
      )
    }
  }

  /**
   * Delete/cancel a payment session (customer switches payment method).
   */
  async deletePayment(
    input: DeletePaymentInput
  ): Promise<DeletePaymentOutput> {
    const paymentId = input.data?.id as string

    if (!paymentId) {
      return { data: input.data }
    }

    try {
      await this.moneiRest(`/payments/${paymentId}/cancel`, "POST")
      this.logger_.info(`MONEI: Deleted session ${paymentId}`)
    } catch {
      // Graceful — session is being abandoned
    }

    return { data: input.data }
  }

  // ---------------------------------------------------------------------------
  // Status & Retrieval
  // ---------------------------------------------------------------------------

  /**
   * SDK: monei.payments.get() ✓
   */
  async getPaymentStatus(
    input: GetPaymentStatusInput
  ): Promise<GetPaymentStatusOutput> {
    const paymentId = input.data?.id as string

    if (!paymentId) {
      return { status: "pending" as PaymentSessionStatus }
    }

    try {
      const payment = await this.monei_.payments.get(paymentId)
      return {
        status: this.getStatus(payment.status),
        data: {
          monei_status: payment.status,
          status_code: payment.statusCode,
        },
      }
    } catch (error: any) {
      this.logger_.warn(
        `MONEI: getPaymentStatus failed for ${paymentId}: ${error.message}`
      )
      return { status: "pending" as PaymentSessionStatus }
    }
  }

  /**
   * SDK: monei.payments.get() ✓
   */
  async retrievePayment(
    input: RetrievePaymentInput
  ): Promise<RetrievePaymentOutput> {
    const paymentId = input.data?.id as string

    if (!paymentId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "MONEI payment ID not found"
      )
    }

    try {
      const payment = await this.monei_.payments.get(paymentId)
      return payment as unknown as Record<string, unknown>
    } catch (error: any) {
      this.logger_.error(
        `MONEI: retrievePayment failed for ${paymentId}: ${error.message}`
      )
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Failed to retrieve MONEI payment: ${error.message}`
      )
    }
  }

  /**
   * Update payment session (cart amount changes).
   * MONEI payments are immutable — cancel + recreate.
   */
  async updatePayment(
    input: UpdatePaymentInput
  ): Promise<UpdatePaymentOutput> {
    const { amount, currency_code, context } = input
    const existingId = input.data?.id as string

    if (
      existingId &&
      input.data?.amount === this.toMoneiAmount(amount as number)
    ) {
      return input.data as UpdatePaymentOutput
    }

    if (existingId) {
      try {
        await this.moneiRest(`/payments/${existingId}/cancel`, "POST")
      } catch {
        // Ignore — old payment may be terminal
      }
    }

    const result = await this.initiatePayment({
      amount,
      currency_code,
      context,
      data: input.data || {},
    } as InitiatePaymentInput)

    return result as unknown as UpdatePaymentOutput
  }

  // ---------------------------------------------------------------------------
  // Webhooks
  // ---------------------------------------------------------------------------

  /**
   * Process MONEI webhook callbacks.
   *
   * SDK: monei.verifySignature(body, signature) ✓ (documented)
   *
   * MONEI sends the Payment object as webhook body with `MONEI-Signature`
   * header. The SDK v2 verifySignature may return:
   *   - { type: "payment.succeeded", object: Payment } (event envelope)
   *   - or the Payment object directly (callback style)
   *
   * We handle both formats.
   *
   * Medusa webhook route: {server_url}/hooks/payment/monei_{id}
   */
  async getWebhookActionAndData(
    payload: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    const { data, rawData, headers } = payload

    try {
      let payment: Record<string, any>

      const signature =
        (headers?.["monei-signature"] as string) ||
        (headers?.["MONEI-Signature"] as string)

      if (signature) {
        const body =
          typeof rawData === "string" ? rawData : rawData.toString()

        try {
          const verified = this.monei_.verifySignature(body, signature) as any
          // Handle event envelope vs direct payment
          payment = verified.object || verified
        } catch (sigError: any) {
          this.logger_.warn(
            `MONEI: Webhook signature failed: ${sigError.message}`
          )
          payment = data as Record<string, any>
        }
      } else {
        payment = data as Record<string, any>
      }

      const sessionId =
        payment.metadata?.session_id || payment.orderId || ""
      const moneiAmount = payment.amount || 0

      this.logger_.info(
        `MONEI: Webhook → payment ${payment.id}, status: ${payment.status}, ` +
          `session: ${sessionId}`
      )

      switch (payment.status) {
        case MoneiPaymentStatus.AUTHORIZED:
          return {
            action: "authorized",
            data: {
              session_id: sessionId,
              amount: new BigNumber(moneiAmount),
            },
          }

        case MoneiPaymentStatus.SUCCEEDED:
          // SALE flow: SUCCEEDED is the first terminal state → "authorized"
          //   (Medusa needs to complete the cart first)
          // AUTH flow: SUCCEEDED after capture → "captured"
          return {
            action: this.options_.capture ? "authorized" : "captured",
            data: {
              session_id: sessionId,
              amount: new BigNumber(moneiAmount),
            },
          }

        case MoneiPaymentStatus.FAILED:
        case MoneiPaymentStatus.EXPIRED:
          return {
            action: "failed",
            data: {
              session_id: sessionId,
              amount: new BigNumber(moneiAmount),
            },
          }

        default:
          return {
            action: "not_supported",
            data: {
              session_id: sessionId,
              amount: new BigNumber(0),
            },
          }
      }
    } catch (error: any) {
      this.logger_.error(
        `MONEI: Webhook error: ${error.message}`
      )
      return {
        action: "failed",
        data: {
          session_id:
            (data as any)?.metadata?.session_id ||
            (data as any)?.orderId ||
            "",
          amount: new BigNumber(0),
        },
      }
    }
  }
}

export default MoneiPaymentProviderService
