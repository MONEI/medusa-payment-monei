"use client"

import { Heading, Text } from "@medusajs/ui"
import LocalizedClientLink from "@modules/common/components/localized-client-link"
import { useRouter, useSearchParams } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import {
  completeMoneiCart,
  getMoneiCartState,
  getMoneiPaymentStatus,
  type MoneiCartState,
} from "./actions"
import { isMultibanco } from "./constants"

const POLL_INTERVAL_MS = 2_000
const POLL_LIMIT_MS = 5 * 60_000

type View =
  | { kind: "checking" }
  | { kind: "processing"; multibanco: boolean }
  | { kind: "confirming" }
  | { kind: "stale" }
  | { kind: "failed"; canceled: boolean }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Landing page of the MONEI hosted page (complete, fail and cancel URLs). The cart is
 * the source of truth: the callback may complete it before, after or instead of this
 * page, so an order is shown only from `cart.complete`, never from the URL.
 */
export default function MoneiReturn({ countryCode }: { countryCode: string }) {
  const params = useSearchParams()
  const router = useRouter()
  const [view, setView] = useState<View>({ kind: "checking" })
  const started = useRef(false)

  const cartId = params.get("cart_id") ?? ""
  const sessionId = params.get("session_id") ?? ""
  const canceled = params.get("monei_canceled") === "1"

  useEffect(() => {
    if (started.current) return
    started.current = true

    const showOrder = (orderId: string, orderCountry: string) =>
      router.replace(`/${orderCountry || countryCode}/order/${orderId}/confirmed`)

    const run = async () => {
      if (!cartId || !sessionId) return setView({ kind: "stale" })
      // A rejected call (network, server action) is retried on the next poll: the
      // payment may be paid, so a failure here must not end on "confirming" early.
      const deadline = Date.now() + POLL_LIMIT_MS
      let first: MoneiCartState | null = null
      while (!first && Date.now() < deadline) {
        first = await getMoneiCartState(cartId).catch(() => null)
        if (!first) await sleep(POLL_INTERVAL_MS)
      }
      if (!first) return setView({ kind: "confirming" })
      if (!first.found || first.sessionId !== sessionId) {
        return setView({ kind: "stale" })
      }
      const multibanco = isMultibanco(first.providerId)

      // A completed cart returns its order; otherwise this authorizes the session.
      const initial = await completeMoneiCart(cartId).catch(() => null)
      if (initial?.orderId) return showOrder(initial.orderId, initial.countryCode)

      while (Date.now() < deadline) {
        const state = await getMoneiCartState(cartId).catch(() => null)
        if (!state) {
          await sleep(POLL_INTERVAL_MS)
          continue
        }
        if (state.found && state.completed) {
          // The callback placed the order. A failed fetch tries again on the next poll.
          const result = await completeMoneiCart(cartId).catch(() => null)
          if (result?.orderId) return showOrder(result.orderId, result.countryCode)
          await sleep(POLL_INTERVAL_MS)
          continue
        }
        if (state.found && state.sessionId !== sessionId) {
          return setView({ kind: "stale" })
        }

        const status = await getMoneiPaymentStatus(cartId, sessionId).catch(
          () => "unknown" as const
        )
        // A paid payment waits for the callback to complete the cart. A hosted-page
        // cancel leaves the payment PENDING; only the cancel URL carries the marker.
        if (status === "error" || (status === "pending" && canceled)) {
          return setView({ kind: "failed", canceled })
        }
        setView({ kind: "processing", multibanco })
        await sleep(POLL_INTERVAL_MS)
      }
      setView({ kind: "confirming" })
    }

    run().catch(() => setView({ kind: "confirming" }))
  }, [cartId, sessionId, canceled, countryCode, router])

  return (
    <div className="content-container py-12 flex flex-col gap-y-4 max-w-xl">
      <Heading level="h1" className="text-2xl-regular">
        Payment
      </Heading>
      {view.kind === "checking" && (
        <Text data-testid="monei-return-checking">
          Checking your payment.
        </Text>
      )}
      {view.kind === "processing" && (
        <Text data-testid="monei-return-processing">
          {view.multibanco
            ? "Reference issued. The order is confirmed when you pay."
            : "We are processing your payment. Do not close this page."}
        </Text>
      )}
      {view.kind === "confirming" && (
        <Text data-testid="monei-return-confirming">
          We are confirming your payment. You will receive an email when your
          order is confirmed.
        </Text>
      )}
      {view.kind === "stale" && (
        <Text data-testid="monei-return-stale">
          This payment page is no longer valid for your cart. Go back to the
          checkout to pay.
        </Text>
      )}
      {view.kind === "failed" && (
        <Text data-testid="monei-return-error">
          {view.canceled
            ? "You canceled the payment. Your cart is still open."
            : "The payment was not completed. Your cart is still open."}
        </Text>
      )}
      {(view.kind === "stale" || view.kind === "failed") && (
        <LocalizedClientLink
          href="/checkout?step=payment"
          className="text-ui-fg-interactive"
          data-testid="monei-return-checkout-link"
        >
          Back to checkout
        </LocalizedClientLink>
      )}
    </div>
  )
}
