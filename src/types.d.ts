declare module "@medusajs/framework/utils" {
  export class AbstractPaymentProvider<T = any> {
    constructor(container: any, options: T)
    static identifier: string
    static validateOptions(options: Record<any, any>): void
  }
  export class BigNumber {
    constructor(value: any)
  }
  export class MedusaError extends Error {
    static Types: {
      INVALID_DATA: string
      UNEXPECTED_STATE: string
    }
    constructor(type: string, message: string)
  }
  export function ModuleProvider(module: any, config: any): any
  export const Modules: { PAYMENT: string }
}

declare module "@medusajs/framework/types" {
  export type PaymentSessionStatus = "authorized" | "captured" | "canceled" | "pending" | "requires_more" | "error"
  export type Logger = { info: (...args: any[]) => void; error: (...args: any[]) => void; warn: (...args: any[]) => void; debug: (...args: any[]) => void }
  export type BigNumberInput = number | string
  export interface InitiatePaymentInput { amount: BigNumberInput; currency_code: string; context?: any; data?: Record<string, unknown> }
  export interface InitiatePaymentOutput { id?: string; data: Record<string, unknown> }
  export interface AuthorizePaymentInput { data?: Record<string, unknown>; context?: any }
  export interface AuthorizePaymentOutput { status: PaymentSessionStatus; data: Record<string, unknown> }
  export interface CapturePaymentInput { data?: Record<string, unknown>; amount?: BigNumberInput; context?: any }
  export interface CapturePaymentOutput { data: Record<string, unknown> }
  export interface CancelPaymentInput { data?: Record<string, unknown>; context?: any }
  export interface CancelPaymentOutput { data: Record<string, unknown> }
  export interface RefundPaymentInput { data?: Record<string, unknown>; amount?: BigNumberInput; context?: any }
  export interface RefundPaymentOutput { data: Record<string, unknown> }
  export interface DeletePaymentInput { data?: Record<string, unknown>; context?: any }
  export interface DeletePaymentOutput { data: Record<string, unknown> }
  export interface GetPaymentStatusInput { data?: Record<string, unknown>; context?: any }
  export interface GetPaymentStatusOutput { status: PaymentSessionStatus; data?: Record<string, unknown> }
  export interface RetrievePaymentInput { data?: Record<string, unknown>; context?: any }
  export type RetrievePaymentOutput = Record<string, unknown>
  export interface UpdatePaymentInput { data?: Record<string, unknown>; amount: BigNumberInput; currency_code: string; context?: any }
  export type UpdatePaymentOutput = Record<string, unknown>
  export interface ProviderWebhookPayload { payload: { data: Record<string, unknown>; rawData: string | Buffer; headers: Record<string, unknown> } }
  export interface WebhookActionResult { action: string; data: { session_id: string; amount: any } }
}
