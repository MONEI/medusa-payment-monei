/** Provider ids are `pp_<identifier>_<id>`; the plugin is registered with `id: "monei"`. */
export const MONEI_CARD = "pp_monei_monei"
export const MONEI_BIZUM = "pp_monei-bizum_monei"
export const MONEI_PAYPAL = "pp_monei-paypal_monei"
export const MONEI_MBWAY = "pp_monei-mbway_monei"
export const MONEI_MULTIBANCO = "pp_monei-multibanco_monei"

export const MONEI_PROVIDER_TITLES: Record<string, string> = {
  [MONEI_CARD]: "Card",
  [MONEI_BIZUM]: "Bizum",
  [MONEI_PAYPAL]: "PayPal",
  [MONEI_MBWAY]: "MB WAY",
  [MONEI_MULTIBANCO]: "Multibanco",
}

export const isMonei = (providerId?: string) =>
  !!providerId && providerId in MONEI_PROVIDER_TITLES

export const isMultibanco = (providerId?: string) =>
  providerId === MONEI_MULTIBANCO

/** Methods with a monei.js component; MB WAY and Multibanco always use the hosted page. */
export const hasMoneiComponent = (providerId?: string) =>
  providerId === MONEI_CARD ||
  providerId === MONEI_BIZUM ||
  providerId === MONEI_PAYPAL

/**
 * Checkout UI switches, read from cookies so one storefront build serves every spec.
 * Default: the hosted page, single card field.
 */
export const MONEI_FLOW_COOKIE = "monei_flow"
export const MONEI_CARD_LAYOUT_COOKIE = "monei_card_layout"

export type MoneiUi = {
  flow: "hosted" | "embedded"
  cardLayout: "single" | "split"
}

/**
 * Where MONEI sends the buyer back. `cart_id` rides in the URL: the cart cookie is
 * `SameSite=Strict`, so the landing request from the MONEI page does not carry it.
 * The plugin adds `session_id` (and `monei_canceled` on the cancel URL).
 */
export const moneiReturnUrl = (countryCode: string, cartId: string) =>
  `${window.location.origin}/${countryCode}/checkout/monei/return?cart_id=${encodeURIComponent(cartId)}`

/**
 * Major to minor units, rounded half up on the decimal value like the plugin. Math.round
 * on `amount * 100` rounds 1.005 to 100 (float error) where the plugin gets 101, and the
 * plugin then refuses `expected_amount`. `"1.005e2"` parses as exactly 100.5.
 */
export const toMinor = (amount: number | null | undefined) => {
  const shifted = Number(`${amount ?? 0}e2`)
  return Math.round(Number.isNaN(shifted) ? (amount ?? 0) * 100 : shifted)
}
