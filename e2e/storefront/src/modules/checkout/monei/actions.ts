"use server"

import { sdk } from "@lib/config"
import { getAuthHeaders, getCacheTag, getCartId, removeCartId } from "@lib/data/cookies"
import { HttpTypes } from "@medusajs/types"
import { revalidateTag } from "next/cache"
import { isMonei } from "./constants"
import { messageOf } from "./message"

export type MoneiCartState =
  | { found: false }
  | {
      found: true
      completed: boolean
      /** The cart's MONEI session, whatever its status. */
      sessionId?: string
      providerId?: string
    }

/**
 * Uncached: the return page polls it while the callback completes the cart. Only a 404
 * means no cart; any other failure throws, so the return page polls again instead of
 * calling a paid cart stale.
 */
export async function getMoneiCartState(cartId: string): Promise<MoneiCartState> {
  const cart = await sdk.client
    .fetch<HttpTypes.StoreCartResponse>(`/store/carts/${cartId}`, {
      query: {
        fields:
          "id,completed_at,payment_collection.payment_sessions.id,payment_collection.payment_sessions.provider_id",
      },
      headers: { ...(await getAuthHeaders()) },
      cache: "no-store",
    })
    .then(({ cart }) => cart)
    .catch((error) => {
      if ((error as { status?: number } | null)?.status === 404) return null
      throw error
    })
  if (!cart) return { found: false }
  const session = cart.payment_collection?.payment_sessions?.find((s) =>
    isMonei(s.provider_id)
  )
  return {
    found: true,
    completed: !!(cart as { completed_at?: string | null }).completed_at,
    sessionId: session?.id,
    providerId: session?.provider_id,
  }
}

export type MoneiCompleteResult =
  | { orderId: string; countryCode: string }
  | { orderId?: undefined; error: string }

/**
 * `cart.complete`, without the starter's redirect. Any answer other than an order
 * (payment not authorized yet, 409 while the callback holds the cart) is not final.
 */
export async function completeMoneiCart(
  cartId: string
): Promise<MoneiCompleteResult> {
  try {
    const result = await sdk.store.cart.complete(
      cartId,
      {},
      { ...(await getAuthHeaders()) }
    )
    revalidateTag(await getCacheTag("carts"))
    if (result.type !== "order") {
      return { error: result.error?.message ?? "The cart is not completed" }
    }
    revalidateTag(await getCacheTag("orders"))
    if ((await getCartId()) === cartId) await removeCartId()
    return {
      orderId: result.order.id,
      countryCode:
        result.order.shipping_address?.country_code?.toLowerCase() ?? "",
    }
  } catch (error) {
    return { error: messageOf(error) }
  }
}

export type MoneiPaymentStatus =
  | "pending"
  | "authorized"
  | "captured"
  | "error"
  | "unknown"

/** The live MONEI status through the plugin route; Medusa records no failure itself. */
export async function getMoneiPaymentStatus(
  cartId: string,
  sessionId: string
): Promise<MoneiPaymentStatus> {
  return sdk.client
    .fetch<{ status: MoneiPaymentStatus }>(`/store/monei/payment-status`, {
      query: { cart_id: cartId, session_id: sessionId },
      cache: "no-store",
    })
    .then(({ status }) => status)
    .catch(() => "unknown" as const)
}

/** The plugin's `capture` option (`GET /store/monei/config`). */
export async function getMoneiCapture(): Promise<
  { capture: boolean; error?: undefined } | { error: string }
> {
  try {
    const { capture } = await sdk.client.fetch<{ capture: boolean }>(
      `/store/monei/config`,
      { cache: "no-store" }
    )
    return { capture }
  } catch (error) {
    return { error: messageOf(error) }
  }
}

/** A saved card as the plugin route returns it: an opaque id, never the MONEI token. */
export type MoneiSavedCard = {
  id: string
  brand: string | null
  last4: string | null
  /** Seconds since the Unix epoch. */
  expires_at: number | null
}

const signedInHeaders = async () => {
  const headers = await getAuthHeaders()
  return "authorization" in headers ? headers : null
}

/** The signed-in shopper's saved cards; a guest has none. */
export async function listMoneiSavedCards(): Promise<{
  signedIn: boolean
  cards: MoneiSavedCard[]
}> {
  const headers = await signedInHeaders()
  if (!headers) return { signedIn: false, cards: [] }
  const { payment_methods } = await sdk.client.fetch<{
    payment_methods: MoneiSavedCard[]
  }>(`/store/monei/payment-methods`, { headers, cache: "no-store" })
  return { signedIn: true, cards: payment_methods }
}

export async function deleteMoneiSavedCard(id: string): Promise<void> {
  const headers = await signedInHeaders()
  if (!headers) throw new Error("Sign in to manage your saved cards.")
  await sdk.client.fetch(
    `/store/monei/payment-methods/${encodeURIComponent(id)}`,
    { method: "DELETE", headers }
  )
}

export type MoneiConfirmResult =
  | { status: MoneiPaymentStatus; redirectUrl: string | null; error?: undefined }
  | { error: string }

/**
 * Pays the session with a saved card on the server (`POST /store/monei/confirm`): the
 * permanent token never reaches the browser.
 */
export async function confirmWithMoneiSavedCard(
  sessionId: string,
  paymentMethodId: string
): Promise<MoneiConfirmResult> {
  const headers = await signedInHeaders()
  if (!headers) return { error: "Sign in to pay with a saved card." }
  try {
    const { status, redirect_url } = await sdk.client.fetch<{
      status: MoneiPaymentStatus
      redirect_url: string | null
    }>(`/store/monei/confirm`, {
      method: "POST",
      headers,
      body: { payment_session_id: sessionId, payment_method_id: paymentMethodId },
    })
    return { status, redirectUrl: redirect_url }
  } catch (error) {
    return { error: messageOf(error) }
  }
}
