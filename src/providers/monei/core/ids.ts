import { createHash } from "node:crypto";

/** The `id` the plugin must be registered with in medusa-config. */
export const PROVIDER_ID = "monei";

export const CARD_IDENTIFIER = "monei";

/** The card provider, the only one with account holders. Medusa ids are `pp_<identifier>_<id>`. */
export const CARD_PROVIDER_ID = `pp_${CARD_IDENTIFIER}_${PROVIDER_ID}`;

/** Every service identifier starts with `monei` (`monei`, `monei-bizum`, ...). */
export function isMoneiProvider(id: string): boolean {
  return id.startsWith("pp_monei");
}

/** MONEI `orderId` is the Medusa payment session id; any other prefix is another integration. */
export function sessionIdOf(orderId: string | undefined): string | undefined {
  return orderId?.startsWith("payses_") ? orderId : undefined;
}

/** The MONEI customer id the card provider stores in an account holder's `data`. */
export function moneiCustomerIdOf(
  holder: { data?: Record<string, unknown> | null } | null | undefined,
): string | undefined {
  const id = holder?.data?.id;
  return typeof id === "string" && id ? id : undefined;
}

/** Opaque id of a saved card: the token itself never leaves the backend. */
export function opaqueId(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
