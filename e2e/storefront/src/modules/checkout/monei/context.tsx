"use client"

import { HttpTypes } from "@medusajs/types"
import {
  MutableRefObject,
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react"
import { MONEI_CARD, MoneiUi } from "./constants"

/** A one-time card token from the mounted card component. */
export type CardTokenizer = () => Promise<{ token?: string; error?: string }>

type MoneiCheckout = {
  ui: MoneiUi
  /** Public MONEI account id: card and wallet components mount with it and a session id. */
  accountId?: string
  /** Set by the mounted card component; called by "Place order" in the review step. */
  tokenizer: MutableRefObject<CardTokenizer | null>
  cardholderName: string
  setCardholderName: (name: string) => void
  /**
   * The session whose MONEI payment failed in the browser. Medusa still reports it as
   * pending, so the payment step replaces it before the buyer can pay again.
   */
  failedSessionId: string | null
  setFailedSessionId: (id: string | null) => void
  /** Opaque id of the saved card the shopper picked; null pays with a new card. */
  savedCardId: string | null
  setSavedCardId: (id: string | null) => void
  /** Save the new card to the shopper's MONEI customer (signed-in shoppers only). */
  saveCard: boolean
  setSaveCard: (save: boolean) => void
  /**
   * The method picked in the payment step. "Place order" pays only a session of this
   * provider: the session of a method the shopper left is being deleted.
   */
  selectedProviderId: string
  setSelectedProviderId: (id: string) => void
}

const MoneiCheckoutContext = createContext<MoneiCheckout | null>(null)

export function MoneiCheckoutProvider({
  ui,
  children,
}: {
  ui: MoneiUi
  children: React.ReactNode
}) {
  const tokenizer = useRef<CardTokenizer | null>(null)
  const [cardholderName, setCardholderName] = useState("")
  const [failedSessionId, setFailedSessionId] = useState<string | null>(null)
  const [savedCardId, setSavedCardId] = useState<string | null>(null)
  const [saveCard, setSaveCard] = useState(false)
  const [selectedProviderId, setSelectedProviderId] = useState("")
  const value = useMemo(
    () => ({
      ui,
      accountId: process.env.NEXT_PUBLIC_MONEI_ACCOUNT_ID,
      tokenizer,
      cardholderName,
      setCardholderName,
      failedSessionId,
      setFailedSessionId,
      savedCardId,
      setSavedCardId,
      saveCard,
      setSaveCard,
      selectedProviderId,
      setSelectedProviderId,
    }),
    [ui, cardholderName, failedSessionId, savedCardId, saveCard, selectedProviderId]
  )
  return (
    <MoneiCheckoutContext.Provider value={value}>
      {children}
    </MoneiCheckoutContext.Provider>
  )
}

export function useMoneiCheckout(): MoneiCheckout {
  const value = useContext(MoneiCheckoutContext)
  if (!value) throw new Error("useMoneiCheckout needs a MoneiCheckoutProvider")
  return value
}

/** A new card is saved only when no saved card is picked. */
export const wantsSavedCard = (
  checkout: Pick<MoneiCheckout, "saveCard" | "savedCardId">
) => checkout.saveCard && !checkout.savedCardId

/** The card session was made with the save choice the shopper has now. */
export const sessionMatchesSaveChoice = (
  session: HttpTypes.StorePaymentSession | undefined,
  checkout: Pick<MoneiCheckout, "saveCard" | "savedCardId">
) => (session?.data?.save_card === true) === wantsSavedCard(checkout)

/** Case-insensitive: the session keeps the code as sent, the plugin uppercases it. */
const sameCountry = (a: unknown, b: unknown) =>
  String(a ?? "").toUpperCase() === String(b ?? "").toUpperCase()

/**
 * The payment step replaces this session before anyone may pay it: missing, failed in
 * the browser, made for another billing country (MONEI picks processors by it), or a
 * card session made with another save choice.
 */
export const moneiSessionStale = (
  session: HttpTypes.StorePaymentSession | undefined,
  checkout: Pick<MoneiCheckout, "failedSessionId" | "saveCard" | "savedCardId">,
  billingCountry: unknown
) =>
  !session ||
  session.id === checkout.failedSessionId ||
  !sameCountry(session.data?.billing_country, billingCountry) ||
  (session.provider_id === MONEI_CARD &&
    !sessionMatchesSaveChoice(session, checkout))

/** The cart's pending session of one MONEI provider. */
export const moneiSessionOf = (
  cart: HttpTypes.StoreCart,
  providerId: string
): HttpTypes.StorePaymentSession | undefined =>
  cart.payment_collection?.payment_sessions?.find(
    (s) => s.provider_id === providerId && s.status === "pending"
  )
