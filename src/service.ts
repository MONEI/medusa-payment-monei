import { AbstractPaymentProvider, BigNumber } from "@medusajs/framework/utils"
import { MedusaError } from "@medusajs/framework/utils"
import type {
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

export type MoneiOptions = {
  apiKey: string
  capture?: boolean
}

type InjectedDependencies = {
  logger: Logger
}

class MoneiPaymentProviderService extends AbstractPaymentProvider<MoneiOptions> {
  static identifier = "monei"

  protected logger_: Logger
  protected options_: MoneiOptions
  protected monei_: any

  constructor(container: InjectedDependencies, options: MoneiOptions) {
    super(container, options)
    this.logger_ = container.logger
    this.options_ = options
    this.monei_ = new Monei(options.apiKey)
  }

  static validateOptions(options: Record<any, any>) {
    if (!options.apiKey) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "MONEI API key is required. Get it from MONEI Dashboard → Settings → API Access."
      )
    }
  }

  // -- Helpers ----------------------------------------------------------------

  private getStatus(s: string): PaymentSessionStatus {
    switch (s) {
      case "AUTHORIZED": return "authorized" as PaymentSessionStatus
      case "SUCCEEDED":
      case "REFUNDED":
      case "PARTIALLY_REFUNDED": return "captured" as PaymentSessionStatus
      case "CANCELED": return "canceled" as PaymentSessionStatus
      case "FAILED":
      case "EXPIRED": return "error" as PaymentSessionStatus
      default: return "pending" as PaymentSessionStatus
    }
  }

  private toInt(amount: any): number {
    return Math.round(Number(amount))
  }

  private async api(path: string, method = "POST", body?: any): Promise<any> {
    const res = await fetch(`https://api.monei.com/v1${path}`, {
      method,
      headers: {
        Authorization: this.options_.apiKey,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`MONEI ${res.status}: ${err}`)
    }
    return res.json()
  }

  // -- Lifecycle --------------------------------------------------------------

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const { amount, currency_code, context } = input
    const sessionId = (input.data?.session_id as string) ||
      `medusa_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`

    try {
      const body: any = {
        amount: this.toInt(amount),
        currency: currency_code.toUpperCase(),
        orderId: sessionId,
        description: `Medusa order ${sessionId}`,
        transactionType: this.options_.capture ? "SALE" : "AUTH",
        metadata: { session_id: sessionId, source: "medusa" },
      }

      if (context?.customer) {
        const c = context.customer as any
        body.customer = {
          email: c.email,
          name: c.first_name ? `${c.first_name} ${c.last_name || ""}`.trim() : undefined,
          phone: c.phone || undefined,
        }
      }

      if (context?.billing_address) {
        const a = context.billing_address as any
        body.billingDetails = {
          name: a.first_name ? `${a.first_name} ${a.last_name || ""}`.trim() : undefined,
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

      if ((context as any)?.webhook_url) {
        body.callbackUrl = (context as any).webhook_url
      }

      const payment = await this.api("/payments", "POST", body)

      this.logger_.info(`MONEI: Created ${payment.id} (session: ${sessionId}, amount: ${payment.amount})`)

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
      this.logger_.error(`MONEI: initiatePayment failed: ${error.message}`)
      throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, `MONEI: ${error.message}`)
    }
  }

  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const paymentId = input.data?.id as string
    if (!paymentId) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "MONEI payment ID not found")
    }

    try {
      const payment = await this.api(`/payments/${paymentId}`, "GET")
      this.logger_.info(`MONEI: authorize ${paymentId} → ${payment.status}`)

      if (payment.status === "AUTHORIZED" ||
          (this.options_.capture && payment.status === "SUCCEEDED")) {
        return {
          status: "authorized" as PaymentSessionStatus,
          data: { ...input.data, id: payment.id, status: payment.status },
        }
      }

      if (payment.status === "PENDING") {
        return {
          status: "requires_more" as PaymentSessionStatus,
          data: { ...input.data, id: payment.id, status: payment.status },
        }
      }

      return {
        status: this.getStatus(payment.status),
        data: { ...input.data, id: payment.id, status: payment.status },
      }
    } catch (error: any) {
      this.logger_.error(`MONEI: authorizePayment failed: ${error.message}`)
      throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, `MONEI: ${error.message}`)
    }
  }

  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    const paymentId = input.data?.id as string
    if (!paymentId) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "MONEI payment ID not found")
    }

    try {
      if (this.options_.capture) {
        const existing = await this.api(`/payments/${paymentId}`, "GET")
        if (existing.status === "SUCCEEDED") {
          return { data: { ...input.data, id: existing.id, status: existing.status, captured_at: new Date().toISOString() } }
        }
      }

      const body: any = {}
      if ((input as any).amount) body.amount = this.toInt((input as any).amount)

      const payment = await this.api(`/payments/${paymentId}/capture`, "POST", Object.keys(body).length ? body : undefined)
      this.logger_.info(`MONEI: Captured ${paymentId} → ${payment.status}`)

      return { data: { ...input.data, id: payment.id, status: payment.status, captured_at: new Date().toISOString() } }
    } catch (error: any) {
      this.logger_.error(`MONEI: capturePayment failed: ${error.message}`)
      throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, `MONEI: ${error.message}`)
    }
  }

  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    const paymentId = input.data?.id as string
    if (!paymentId) return { data: input.data }

    try {
      const payment = await this.api(`/payments/${paymentId}/cancel`, "POST")
      this.logger_.info(`MONEI: Canceled ${paymentId}`)
      return { data: { ...input.data, id: payment.id, status: payment.status } }
    } catch (error: any) {
      this.logger_.warn(`MONEI: cancelPayment: ${error.message}`)
      return { data: { ...input.data, cancel_error: error.message } }
    }
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    const paymentId = input.data?.id as string
    if (!paymentId) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "MONEI payment ID not found")
    }

    try {
      const body: any = {}
      if (input.amount) body.amount = this.toInt(input.amount)

      const payment = await this.api(`/payments/${paymentId}/refund`, "POST", Object.keys(body).length ? body : undefined)
      this.logger_.info(`MONEI: Refunded ${paymentId} (amount: ${body.amount || "full"})`)

      return { data: { ...input.data, id: paymentId, status: payment.status, refunded_at: new Date().toISOString() } }
    } catch (error: any) {
      this.logger_.error(`MONEI: refundPayment failed: ${error.message}`)
      throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, `MONEI: ${error.message}`)
    }
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    const paymentId = input.data?.id as string
    if (paymentId) {
      try { await this.api(`/payments/${paymentId}/cancel`, "POST") } catch {}
    }
    return { data: input.data }
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const paymentId = input.data?.id as string
    if (!paymentId) return { status: "pending" as PaymentSessionStatus }

    try {
      const payment = await this.api(`/payments/${paymentId}`, "GET")
      return { status: this.getStatus(payment.status) }
    } catch {
      return { status: "pending" as PaymentSessionStatus }
    }
  }

  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    const paymentId = input.data?.id as string
    if (!paymentId) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "MONEI payment ID not found")
    }
    return await this.api(`/payments/${paymentId}`, "GET")
  }

  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    const existingId = input.data?.id as string
    if (existingId && input.data?.amount === this.toInt(input.amount)) {
      return input.data as any
    }
    if (existingId) {
      try { await this.api(`/payments/${existingId}/cancel`, "POST") } catch {}
    }
    const result = await this.initiatePayment({
      amount: input.amount,
      currency_code: input.currency_code,
      context: input.context,
      data: input.data || {},
    } as InitiatePaymentInput)
    return result as any
  }

  // -- Webhooks ---------------------------------------------------------------

  async getWebhookActionAndData(payload: ProviderWebhookPayload["payload"]): Promise<WebhookActionResult> {
    const { data, rawData, headers } = payload

    try {
      let payment: any

      const sig = (headers?.["monei-signature"] || headers?.["MONEI-Signature"]) as string
      if (sig) {
        const body = typeof rawData === "string" ? rawData : rawData.toString()
        try {
          const verified = this.monei_.verifySignature(body, sig)
          payment = verified?.object || verified
        } catch {
          payment = data
        }
      } else {
        payment = data
      }

      const sessionId = payment?.metadata?.session_id || payment?.orderId || ""
      const amount = payment?.amount || 0

      this.logger_.info(`MONEI: Webhook → ${payment?.id}, status: ${payment?.status}, session: ${sessionId}`)

      switch (payment?.status) {
        case "AUTHORIZED":
          return { action: "authorized", data: { session_id: sessionId, amount: new BigNumber(amount) } }
        case "SUCCEEDED":
          return {
            action: this.options_.capture ? "authorized" : "captured",
            data: { session_id: sessionId, amount: new BigNumber(amount) },
          }
        case "FAILED":
        case "EXPIRED":
          return { action: "failed", data: { session_id: sessionId, amount: new BigNumber(amount) } }
        default:
          return { action: "not_supported", data: { session_id: sessionId, amount: new BigNumber(0) } }
      }
    } catch (error: any) {
      this.logger_.error(`MONEI: Webhook error: ${error.message}`)
      return {
        action: "failed",
        data: {
          session_id: (data as any)?.metadata?.session_id || (data as any)?.orderId || "",
          amount: new BigNumber(0),
        },
      }
    }
  }
}

export default MoneiPaymentProviderService
