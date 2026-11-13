"use client"

import { HttpTypes } from "@medusajs/types"
import { Button } from "@medusajs/ui"
import { Bizum, PayPal } from "@monei-js/react-components"
import ErrorMessage from "@modules/checkout/components/error-message"
import { useCallback, useEffect, useRef, useState } from "react"
import { MONEI_BIZUM, MONEI_CARD } from "./constants"
import { moneiSessionStale, useMoneiCheckout } from "./context"
import { messageOf } from "./message"
import {
  useMoneiPay,
  useMoneiSavedCardPay,
  usePayPalTransactionType,
} from "./use-monei-pay"

/**
 * "Place order" of the embedded flow. Card: token from the card component of the
 * payment step, then confirm. Bizum and PayPal: their own button, mounted with the
 * session's MONEI payment id, replaces "Place order".
 */
export default function MoneiEmbeddedButton({
  cart,
  session,
  notReady,
  "data-testid": dataTestId,
}: {
  cart: HttpTypes.StoreCart
  session: HttpTypes.StorePaymentSession
  notReady: boolean
  "data-testid"?: string
}) {
  const checkout = useMoneiCheckout()
  const { tokenizer, cardholderName, savedCardId, selectedProviderId } = checkout
  const pay = useMoneiPay(cart)
  const paySavedCard = useMoneiSavedCardPay(cart)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The payment step is replacing this session (another method picked, failed, other
  // billing country or save choice): paying it could leave a payment with no order.
  const usable =
    session.provider_id === selectedProviderId &&
    !moneiSessionStale(session, checkout, cart.billing_address?.country_code)
  const paymentId = session.data?.id as string | undefined

  // Bridge components re-send changed props to their iframe; keep the handler stable.
  const latest = useRef({ session, pay, usable })
  latest.current = { session, pay, usable }
  const onWalletSubmit = useCallback(
    async ({ token, error }: { token?: string; error?: string }) => {
      if (!token) return setError(error ?? "The payment was not completed.")
      const { pay, session, usable } = latest.current
      if (!usable) return setError("The payment is being prepared. Try again.")
      setError(null)
      setError(await pay(session, { paymentToken: token }).catch((e) => messageOf(e)))
    },
    []
  )
  const onComponentError = useCallback(
    (e: { message?: string }) => setError(e?.message ?? String(e)),
    []
  )

  const placeSavedCardOrder = async (paymentMethodId: string) => {
    setError(null)
    setSubmitting(true)
    let movedOn = false
    try {
      const message = await paySavedCard(session, paymentMethodId)
      movedOn = message === null
      setError(message)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      if (!movedOn) setSubmitting(false)
    }
  }

  const placeCardOrder = async () => {
    if (savedCardId) return placeSavedCardOrder(savedCardId)
    setError(null)
    const name = cardholderName.trim()
    if (!name) return setError("Enter the cardholder name.")
    const tokenize = tokenizer.current
    if (!tokenize) return setError("Enter your card details in the payment step.")
    setSubmitting(true)
    // Stays loading once the browser moves on to the order or the return page.
    let movedOn = false
    try {
      const { token, error } = await tokenize()
      if (!token) return setError(error ?? "Check your card details.")
      const message = await pay(session, {
        paymentToken: token,
        paymentMethod: { card: { cardholderName: name } },
      })
      movedOn = message === null
      setError(message)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      if (!movedOn) setSubmitting(false)
    }
  }

  let control: React.ReactNode
  if (session.provider_id === MONEI_CARD) {
    control = (
      <Button
        disabled={notReady || !usable}
        isLoading={submitting || !usable}
        onClick={placeCardOrder}
        size="large"
        data-testid={dataTestId}
      >
        Place order
      </Button>
    )
  } else if (notReady || !usable || !paymentId) {
    control = (
      <Button disabled isLoading={!usable} size="large">
        Place order
      </Button>
    )
  } else if (session.provider_id === MONEI_BIZUM) {
    control = (
      <div id="monei-bizum-container" className="max-w-sm">
        <Bizum
          key={session.id}
          paymentId={paymentId}
          onSubmit={onWalletSubmit}
          onError={onComponentError}
        />
      </div>
    )
  } else {
    control = (
      // Not id="monei-paypal": element ids are window properties, and the PayPal SDK
      // reads window["monei-paypal"] as its namespace.
      <div id="monei-paypal-container" className="max-w-sm">
        <MoneiPayPal
          key={session.id}
          paymentId={paymentId}
          onSubmit={onWalletSubmit}
          onError={onComponentError}
          onOpen={() => setError(null)}
          onClose={() => setError(PAYPAL_CLOSED)}
        />
      </div>
    )
  }

  return (
    <>
      {control}
      <ErrorMessage error={error} data-testid="monei-payment-error-message" />
    </>
  )
}

const PAYPAL_CLOSED = "The PayPal window was closed before the payment was approved."
// An approval also removes the overlay; its onSubmit arrives after PayPal returns the order.
const PAYPAL_APPROVAL_GRACE_MS = 3_000

type WalletSubmit = (result: { token?: string; error?: string }) => void

/**
 * monei.js reports no PayPal cancel. The PayPal SDK keeps a `paypal-overlay-*` element
 * on <body> while its popup is open, so the overlay leaving without an approval means
 * the buyer closed or cancelled the popup.
 */
function MoneiPayPal({
  paymentId,
  onSubmit,
  onError,
  onOpen,
  onClose,
}: {
  paymentId: string
  onSubmit: WalletSubmit
  onError: (e: { message?: string }) => void
  onOpen: () => void
  onClose: () => void
}) {
  const latest = useRef({ onSubmit, onOpen, onClose })
  latest.current = { onSubmit, onOpen, onClose }
  const approved = useRef(false)
  const paypal = usePayPalTransactionType()

  useEffect(() => {
    let open = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const isOverlay = (node: Node) =>
      node instanceof HTMLElement && node.id.startsWith("paypal-overlay-")
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (Array.from(record.addedNodes).some(isOverlay)) {
          open = true
          approved.current = false
          if (timer) clearTimeout(timer)
          latest.current.onOpen()
        }
        if (open && Array.from(record.removedNodes).some(isOverlay)) {
          open = false
          timer = setTimeout(() => {
            if (!approved.current) latest.current.onClose()
          }, PAYPAL_APPROVAL_GRACE_MS)
        }
      }
    })
    observer.observe(document.body, { childList: true })
    return () => {
      observer.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [])

  const submit = useCallback<WalletSubmit>((result) => {
    approved.current = true
    latest.current.onSubmit(result)
  }, [])

  if (!paypal.transactionType) {
    return paypal.error ? (
      <ErrorMessage error={paypal.error} data-testid="monei-paypal-config-error" />
    ) : (
      <Button disabled isLoading size="large">
        Place order
      </Button>
    )
  }
  return (
    <PayPal
      paymentId={paymentId}
      transactionType={paypal.transactionType}
      onSubmit={submit}
      onError={onError}
    />
  )
}
