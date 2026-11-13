import type { Logger } from "@medusajs/framework/types";
import { PaymentActions, PaymentSessionStatus } from "@medusajs/framework/utils";
import { PaymentStatus } from "@monei-js/node-sdk";

const SESSION_STATUS: Record<string, PaymentSessionStatus> = {
  [PaymentStatus.AUTHORIZED]: PaymentSessionStatus.AUTHORIZED,
  [PaymentStatus.SUCCEEDED]: PaymentSessionStatus.CAPTURED,
  [PaymentStatus.PARTIALLY_REFUNDED]: PaymentSessionStatus.CAPTURED,
  [PaymentStatus.REFUNDED]: PaymentSessionStatus.CAPTURED,
  [PaymentStatus.PENDING]: PaymentSessionStatus.PENDING,
  [PaymentStatus.FAILED]: PaymentSessionStatus.ERROR,
  [PaymentStatus.CANCELED]: PaymentSessionStatus.ERROR,
  [PaymentStatus.EXPIRED]: PaymentSessionStatus.ERROR,
};

const WEBHOOK_ACTION: Record<string, PaymentActions> = {
  [PaymentStatus.AUTHORIZED]: PaymentActions.AUTHORIZED,
  [PaymentStatus.SUCCEEDED]: PaymentActions.SUCCESSFUL,
  [PaymentStatus.FAILED]: PaymentActions.FAILED,
  [PaymentStatus.CANCELED]: PaymentActions.FAILED,
  [PaymentStatus.EXPIRED]: PaymentActions.FAILED,
  [PaymentStatus.PENDING]: PaymentActions.PENDING,
};

export const REFUNDED = new Set<string>([PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUNDED]);

/** Captured money: a cancel must refuse it (refund instead). */
export const CAPTURED = new Set<string>([PaymentStatus.SUCCEEDED, ...REFUNDED]);

export const CANCELABLE = new Set<string>([PaymentStatus.PENDING, PaymentStatus.AUTHORIZED]);

export const ALREADY_VOID = new Set<string>([
  PaymentStatus.CANCELED,
  PaymentStatus.EXPIRED,
  PaymentStatus.FAILED,
]);

/** Money that moved or is held: the only statuses worth an orphan alert. */
export const HELD_OR_MOVED = new Set<string>([PaymentStatus.AUTHORIZED, PaymentStatus.SUCCEEDED]);

/** MONEI payment status to Medusa session status. */
export function toSessionStatus(
  status: string,
  logger: Pick<Logger, "warn">,
): PaymentSessionStatus {
  const mapped = SESSION_STATUS[status];
  if (!mapped) {
    logger.warn(`MONEI payment status "${status}" is not mapped, treating it as pending`);
    return PaymentSessionStatus.PENDING;
  }
  return mapped;
}

/** MONEI payment status to Medusa webhook action; refunded and unknown statuses are not supported. */
export function toWebhookAction(status: string): PaymentActions {
  return WEBHOOK_ACTION[status] ?? PaymentActions.NOT_SUPPORTED;
}
