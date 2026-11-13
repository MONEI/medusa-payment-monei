"use client"

import { HttpTypes } from "@medusajs/types"
import {
  CardCvc,
  CardExpiry,
  CardInput,
  CardInputHandle,
  CardNumber,
  PaymentRequest,
  useCardGroup,
} from "@monei-js/react-components"
import ErrorMessage from "@modules/checkout/components/error-message"
import { useCallback, useEffect, useRef, useState } from "react"
import { MoneiSavedCard, listMoneiSavedCards } from "./actions"
import { toMinor } from "./constants"
import { moneiSessionStale, useMoneiCheckout } from "./context"
import { messageOf } from "./message"
import { useMoneiPay } from "./use-monei-pay"

/**
 * Card (single or split fields) and the Apple Pay / Google Pay button. They mount with
 * the account id and a monei.js session id, not a payment id, so a cart total change
 * that replaces the Medusa session (and its MONEI payment) leaves the card untouched.
 * The session id is the cart id: the storefront sends it as `monei_session_id` with every
 * session of this cart, and MONEI accepts the token only for a payment made with it.
 */
export default function MoneiCardFields({
  cart,
  session,
}: {
  cart: HttpTypes.StoreCart
  session?: HttpTypes.StorePaymentSession
}) {
  const { ui, accountId, cardholderName, setCardholderName, savedCardId } =
    useMoneiCheckout()

  if (!accountId) {
    return (
      <ErrorMessage
        error="NEXT_PUBLIC_MONEI_ACCOUNT_ID is not set."
        data-testid="monei-card-error-message"
      />
    )
  }

  return (
    <div className="flex flex-col gap-y-3 mt-2" data-testid="monei-card-fields">
      <MoneiWallet cart={cart} session={session} accountId={accountId} />
      <SavedCards />
      {!savedCardId && (
        <NewCard
          accountId={accountId}
          sessionId={cart.id}
          layout={ui.cardLayout}
          cardholderName={cardholderName}
          setCardholderName={setCardholderName}
        />
      )}
    </div>
  )
}

/**
 * The signed-in shopper's saved cards (plugin route) and the save choice for a new card.
 * Picking or saving changes the session the payment step makes.
 */
function SavedCards() {
  const { savedCardId, setSavedCardId, saveCard, setSaveCard } =
    useMoneiCheckout()
  const [signedIn, setSignedIn] = useState(false)
  const [cards, setCards] = useState<MoneiSavedCard[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listMoneiSavedCards()
      .then(({ signedIn, cards }) => {
        setSignedIn(signedIn)
        setCards(cards)
      })
      .catch((e) => setError(messageOf(e)))
  }, [])

  if (!signedIn) {
    return <ErrorMessage error={error} data-testid="monei-saved-cards-error" />
  }

  return (
    <div className="flex flex-col gap-y-2" data-testid="monei-saved-cards">
      {cards.map((card) => (
        <label
          key={card.id}
          className="flex items-center gap-x-2"
          data-testid="monei-saved-card"
        >
          <input
            type="radio"
            name="monei-card-choice"
            checked={savedCardId === card.id}
            onChange={() => setSavedCardId(card.id)}
          />
          <span className="capitalize">{card.brand ?? "Card"}</span>
          <span>•••• {card.last4}</span>
        </label>
      ))}
      {cards.length > 0 && (
        <label className="flex items-center gap-x-2">
          <input
            type="radio"
            name="monei-card-choice"
            checked={!savedCardId}
            onChange={() => setSavedCardId(null)}
            data-testid="monei-new-card-radio"
          />
          New card
        </label>
      )}
      {!savedCardId && (
        <label className="flex items-center gap-x-2">
          <input
            type="checkbox"
            checked={saveCard}
            onChange={(e) => setSaveCard(e.target.checked)}
            data-testid="monei-save-card-checkbox"
          />
          Save this card for future payments
        </label>
      )}
      <ErrorMessage error={error} data-testid="monei-saved-cards-error" />
    </div>
  )
}

function NewCard({
  accountId,
  sessionId,
  layout,
  cardholderName,
  setCardholderName,
}: {
  accountId: string
  sessionId: string
  layout: "single" | "split"
  cardholderName: string
  setCardholderName: (name: string) => void
}) {
  return (
    <>
      <input
        className="pt-4 pb-1 px-4 h-11 w-full border rounded-md bg-ui-bg-field border-ui-border-base"
        placeholder="Cardholder name"
        autoComplete="cc-name"
        value={cardholderName}
        onChange={(e) => setCardholderName(e.target.value)}
        data-testid="cardholder-name-input"
      />
      {layout === "split" ? (
        <SplitCard accountId={accountId} sessionId={sessionId} />
      ) : (
        <SingleCard accountId={accountId} sessionId={sessionId} />
      )}
    </>
  )
}

function SingleCard({
  accountId,
  sessionId,
}: {
  accountId: string
  sessionId: string
}) {
  const { tokenizer } = useMoneiCheckout()
  const card = useRef<CardInputHandle>(null)

  useEffect(() => {
    tokenizer.current = async () =>
      card.current
        ? card.current.submit()
        : { error: "The card form is still loading." }
    return () => {
      tokenizer.current = null
    }
  }, [tokenizer])

  return (
    <div id="monei-card-input">
      <CardInput ref={card} accountId={accountId} sessionId={sessionId} />
    </div>
  )
}

// monei.js puts its state classes on the element it renders into the mount.
const SPLIT_PART =
  "[&>div]:border [&>div]:rounded-md [&>div]:border-ui-border-base [&>.monei-component--focus]:border-ui-border-interactive [&>.monei-component--invalid]:border-ui-border-error"

function SplitCard({
  accountId,
  sessionId,
}: {
  accountId: string
  sessionId: string
}) {
  const { tokenizer } = useMoneiCheckout()
  const group = useCardGroup({ accountId, sessionId })

  useEffect(() => {
    tokenizer.current = () => group.submit()
    return () => {
      tokenizer.current = null
    }
  }, [tokenizer, group])

  return (
    <div className="flex flex-col gap-y-2">
      <div id="monei-card-number" className={SPLIT_PART}>
        <CardNumber group={group} />
      </div>
      <div className="grid grid-cols-2 gap-x-2">
        <div id="monei-card-expiry" className={SPLIT_PART}>
          <CardExpiry group={group} />
        </div>
        <div id="monei-card-cvc" className={SPLIT_PART}>
          <CardCvc group={group} />
        </div>
      </div>
    </div>
  )
}

function MoneiWallet({
  cart,
  session,
  accountId,
}: {
  cart: HttpTypes.StoreCart
  session?: HttpTypes.StorePaymentSession
  accountId: string
}) {
  const checkout = useMoneiCheckout()
  const pay = useMoneiPay(cart)
  const [error, setError] = useState<string | null>(null)
  // The payment step is replacing a stale session; paying it could leave a payment
  // with no order.
  const stale = moneiSessionStale(
    session,
    checkout,
    cart.billing_address?.country_code
  )
  // The bridge re-sends every changed prop to its iframe; keep the handler stable.
  const latest = useRef({ session, stale, pay })
  latest.current = { session, stale, pay }

  const onSubmit = useCallback(
    async ({ token, error }: { token?: string; error?: string }) => {
      const { session, stale, pay } = latest.current
      if (!token) return setError(error ?? "The wallet returned no payment.")
      if (!session || stale) {
        return setError("The payment is being prepared. Try again.")
      }
      setError(
        await pay(session, { paymentToken: token }).catch((e) => messageOf(e))
      )
    },
    []
  )

  const amount = toMinor(cart.total)
  const currency = cart.currency_code?.toUpperCase()

  return (
    <div id="monei-wallet">
      {/* monei.js 2.5.0 reads the amount once, at load, and binds the token to it. */}
      <PaymentRequest
        key={`${amount}-${currency}`}
        accountId={accountId}
        sessionId={cart.id}
        amount={amount}
        currency={currency}
        onSubmit={onSubmit}
      />
      <ErrorMessage error={error} data-testid="monei-wallet-error-message" />
    </div>
  )
}
