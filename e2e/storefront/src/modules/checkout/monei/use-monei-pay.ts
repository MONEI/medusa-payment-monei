"use client"

import { HttpTypes } from "@medusajs/types"
import { TransactionType } from "@monei-js/components"
import { confirmPayment } from "@monei-js/react-components"
import { useParams, useRouter } from "next/navigation"
import { useCallback, useEffect, useMemo, useState } from "react"
import {
  completeMoneiCart,
  confirmWithMoneiSavedCard,
  getMoneiCapture,
  getMoneiPaymentStatus,
  type MoneiConfirmResult,
} from "./actions"
import { moneiReturnUrl } from "./constants"
import { useMoneiCheckout } from "./context"
import { messageOf } from "./message"

type ConfirmParams = Omit<Parameters<typeof confirmPayment>[0], "paymentId">

/** Where the browser goes after a confirm: the order page, or the return page, which waits for the order. */
function useMoneiNavigation(cartId: string) {
  const router = useRouter()
  const { countryCode } = useParams<{ countryCode: string }>()

  return useMemo(
    () => ({
      /** Places the order; true when the browser moved on to it. */
      async toOrder(): Promise<boolean> {
        // A failed call leaves a paid payment: the caller sends the browser to the
        // return page, which waits for the order.
        const placed = await completeMoneiCart(cartId).catch(() => null)
        if (!placed?.orderId) return false
        router.push(
          `/${placed.countryCode || countryCode}/order/${placed.orderId}/confirmed`
        )
        return true
      },
      toReturnPage(sessionId: string) {
        const url = new URL(moneiReturnUrl(countryCode, cartId))
        url.searchParams.set("session_id", sessionId)
        window.location.assign(url.toString())
      },
    }),
    [cartId, countryCode, router]
  )
}

/**
 * Confirms the session's MONEI payment in the browser (3DS and the Bizum wait run in
 * the monei.js modal), then places the order. Returns an error message to show, or
 * null when the browser moved on to the order or the return page.
 */
export function useMoneiPay(cart: Pick<HttpTypes.StoreCart, "id">) {
  const { toOrder, toReturnPage } = useMoneiNavigation(cart.id)
  const { setFailedSessionId } = useMoneiCheckout()

  return useCallback(
    async (
      session: HttpTypes.StorePaymentSession,
      params: ConfirmParams
    ): Promise<string | null> => {
      const paymentId = session.data?.id
      if (typeof paymentId !== "string") {
        return "This payment cannot be confirmed. Go back to the payment step."
      }

      let status: string
      let statusMessage: string | undefined
      try {
        ;({ status, statusMessage } = await confirmPayment({ paymentId, ...params }))
      } catch (error) {
        // A failed call (5xx, lost response) can hide a confirm that went through.
        const live = await getMoneiPaymentStatus(cart.id, session.id).catch(
          () => "unknown" as const
        )
        if (live === "captured" || live === "authorized") {
          if (!(await toOrder())) toReturnPage(session.id)
          return null
        }
        return messageOf(error, "The payment could not be confirmed.")
      }

      const paid = status === "SUCCEEDED" || status === "AUTHORIZED"
      if (paid && (await toOrder())) return null
      if (paid || status === "PENDING") {
        // Not placed yet (the callback holds the cart, or the payment is still pending).
        toReturnPage(session.id)
        return null
      }

      setFailedSessionId(session.id)
      return statusMessage || "The payment was not completed."
    },
    [cart.id, toOrder, toReturnPage, setFailedSessionId]
  )
}

/**
 * Pays the session with a saved card through the plugin's confirm route. A 3DS
 * challenge comes back as a pending status with MONEI's redirect URL; the hosted
 * challenge then lands on the return page. A route error can hide a confirm that went
 * through (timeout, lost response), so the live status decides what follows: only a
 * failed payment gets its session replaced. Returns an error message to show, or null
 * when the browser moved on.
 */
export function useMoneiSavedCardPay(cart: HttpTypes.StoreCart) {
  const { toOrder, toReturnPage } = useMoneiNavigation(cart.id)
  const { setFailedSessionId } = useMoneiCheckout()

  return useCallback(
    async (
      session: HttpTypes.StorePaymentSession,
      paymentMethodId: string
    ): Promise<string | null> => {
      // A failed server-action call can also hide a confirm that went through.
      const result = await confirmWithMoneiSavedCard(session.id, paymentMethodId).catch(
        (error): MoneiConfirmResult => ({ error: messageOf(error) })
      )
      if (result.error !== undefined) {
        const status = await getMoneiPaymentStatus(cart.id, session.id)
        if (status === "captured" || status === "authorized") {
          if (!(await toOrder())) toReturnPage(session.id)
          return null
        }
        // Pending (or unknown) keeps the session: a confirm still in flight must not
        // lose it, and the shopper can retry on the same payment.
        if (status === "error") setFailedSessionId(session.id)
        return result.error
      }

      const paid = result.status === "captured" || result.status === "authorized"
      if (paid && (await toOrder())) return null
      // MONEI also names its complete URL on a finished payment: follow the redirect
      // only while the payment waits for the buyer.
      if (result.status === "pending" && result.redirectUrl) {
        window.location.assign(result.redirectUrl)
        return null
      }
      if (result.status !== "error") {
        toReturnPage(session.id)
        return null
      }

      setFailedSessionId(session.id)
      return "The payment was not completed."
    },
    [cart.id, toOrder, toReturnPage, setFailedSessionId]
  )
}

/**
 * The `transactionType` every PayPal component needs: monei.js loads PayPal with the
 * capture intent unless it gets AUTH, and a capture order cannot pay the AUTH payment
 * the plugin makes with `capture: false`. Null until the plugin answered.
 */
export function usePayPalTransactionType(): {
  transactionType: TransactionType | null
  error: string | null
} {
  const [state, setState] = useState<{
    transactionType: TransactionType | null
    error: string | null
  }>({ transactionType: null, error: null })
  useEffect(() => {
    let live = true
    getMoneiCapture()
      .catch((error) => ({ error: messageOf(error) }))
      .then((result) => {
        if (!live) return
        setState(
          result.error !== undefined
            ? { transactionType: null, error: result.error }
            : {
                transactionType: result.capture
                  ? TransactionType.SALE
                  : TransactionType.AUTH,
                error: null,
              }
        )
      })
    return () => {
      live = false
    }
  }, [])
  return state
}
