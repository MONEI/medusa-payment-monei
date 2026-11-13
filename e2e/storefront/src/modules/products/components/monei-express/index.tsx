"use client"

import type { ShippingOption, SubmitResult } from "@monei-js/components"
import { PayPal, PaymentRequest } from "@monei-js/react-components"
import ErrorMessage from "@modules/checkout/components/error-message"
import { MONEI_CARD, MONEI_PAYPAL } from "@modules/checkout/monei/constants"
import { MoneiCheckoutProvider } from "@modules/checkout/monei/context"
import { messageOf } from "@modules/checkout/monei/message"
import {
  useMoneiPay,
  usePayPalTransactionType,
} from "@modules/checkout/monei/use-monei-pay"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  ExpressCart,
  applyMoneiExpressResult,
  createMoneiExpressSession,
  prepareMoneiExpressCart,
  selectMoneiExpressShipping,
  updateMoneiExpressAddress,
} from "./actions"

/** Express buttons are opt-in per browser, so one storefront build serves every spec. */
const MONEI_EXPRESS_COOKIE = "monei_express=on"

type Source = { variantId: string } | { cartId: string }

/**
 * Apple Pay, Google Pay and PayPal express buttons. On the product page they pay a new
 * cart that holds only that product; on the cart page they pay the shopper's cart.
 * Both buttons mount with the account id and a monei.js session id (the express cart
 * id), the token pays a session created with that `monei_session_id`.
 */
export default function MoneiExpress({
  countryCode,
  ...source
}: Source & { countryCode: string }) {
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    setEnabled(document.cookie.split("; ").includes(MONEI_EXPRESS_COOKIE))
  }, [])
  const accountId = process.env.NEXT_PUBLIC_MONEI_ACCOUNT_ID
  if (!enabled || !accountId) return null

  return (
    <MoneiCheckoutProvider ui={EXPRESS_UI}>
      <Express source={source} countryCode={countryCode} accountId={accountId} />
    </MoneiCheckoutProvider>
  )
}

const EXPRESS_UI = { flow: "embedded", cardLayout: "single" } as const

function Express({
  source,
  countryCode,
  accountId,
}: {
  source: Source
  countryCode: string
  accountId: string
}) {
  const [cart, setCart] = useState<ExpressCart | null>(null)
  const [amount, setAmount] = useState(0)
  const [walletSupported, setWalletSupported] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)

  useEffect(() => {
    // One express cart per mount: the product page must not create two.
    if (started.current) return
    started.current = true
    prepareMoneiExpressCart({ ...source, countryCode })
      .then((prepared) => {
        if ("error" in prepared) return setError(prepared.error)
        setCart(prepared)
        setAmount(prepared.amount)
      })
      .catch((e) => setError(messageOf(e)))
  }, [source, countryCode])

  if (!cart) {
    return <ErrorMessage error={error} data-testid="monei-express-error" />
  }

  return (
    <ExpressButtons
      cart={cart}
      amount={amount}
      setAmount={setAmount}
      accountId={accountId}
      walletSupported={walletSupported}
      setWalletSupported={setWalletSupported}
      error={error}
      setError={setError}
    />
  )
}

function ExpressButtons({
  cart,
  amount,
  setAmount,
  accountId,
  walletSupported,
  setWalletSupported,
  error,
  setError,
}: {
  cart: ExpressCart
  amount: number
  setAmount: (amount: number) => void
  accountId: string
  walletSupported: boolean | null
  setWalletSupported: (supported: boolean) => void
  error: string | null
  setError: (error: string | null) => void
}) {
  const pay = useMoneiPay({ id: cart.cartId })
  const paypal = usePayPalTransactionType()
  // Bridge components re-send every changed prop to their iframe; keep handlers stable.
  const latest = useRef({ amount, pay })
  latest.current = { amount, pay }
  // One wallet approval at a time: a second one would confirm another session for the
  // same cart. Held after success too, because the browser is leaving.
  const submitting = useRef(false)

  const onSubmit = useCallback(
    async (result: SubmitResult) => {
      if (submitting.current) return
      submitting.current = true
      const fail = (message: string) => {
        submitting.current = false
        setError(message)
      }
      setError(null)
      if (!result.token) {
        return fail(result.error ?? "The wallet returned no payment.")
      }
      // Express has no form: the wallet is the only source of the order email.
      const email = result.billingDetails?.email || result.shippingDetails?.email
      if (!email) {
        return fail(
          "The wallet did not share an email address. Use the regular checkout."
        )
      }
      // A rejected server action must still show an error, not leave the buttons silent.
      try {
        const applied = await applyMoneiExpressResult(cart.cartId, {
          email,
          billing: result.billingDetails,
          shipping: result.shippingDetails,
          shippingOptionId: result.shippingOption?.id,
        })
        if ("error" in applied) return fail(applied.error)

        // The amount the shopper approved in the wallet; the plugin compares it with the cart.
        const shown = result.finalAmount ?? latest.current.amount
        const session = await createMoneiExpressSession(
          cart.cartId,
          result.paymentMethod === "paypal" ? MONEI_PAYPAL : MONEI_CARD,
          (shown / 100).toFixed(2)
        )
        if ("error" in session) return fail(session.error)

        // MONEI skips the cardholder name check for wallet tokens only; a card token needs it.
        const name = result.billingDetails?.name
        const card =
          result.paymentMethod === "card" && name
            ? { paymentMethod: { card: { cardholderName: name } } }
            : {}
        const message = await latest.current.pay(session, {
          paymentToken: result.token,
          ...card,
        })
        if (message !== null) fail(message)
      } catch (e) {
        fail(messageOf(e))
      }
    },
    [cart.cartId, setError]
  )

  // E2E entry point: no automation can authorise an Apple Pay or Google Pay sheet, so the
  // specs hand a real token to the same handler the wallet calls.
  useEffect(() => {
    const w = window as unknown as { __moneiExpress?: unknown }
    w.__moneiExpress = { submit: onSubmit }
    return () => {
      delete w.__moneiExpress
    }
  }, [onSubmit])

  const onShippingAddressChange = useCallback(
    async (address: NonNullable<SubmitResult["billingDetails"]>["address"]) => {
      const result = await updateMoneiExpressAddress(cart.cartId, address ?? {})
      if ("error" in result) throw new Error(result.error)
      setAmount(result.amount)
      return result
    },
    [cart.cartId, setAmount]
  )
  const onShippingOptionChange = useCallback(
    async (option: ShippingOption) => {
      const result = await selectMoneiExpressShipping(cart.cartId, option.id)
      if ("error" in result) throw new Error(result.error)
      setAmount(result.amount)
      return result
    },
    [cart.cartId, setAmount]
  )
  const onError = useCallback(
    (e: { message?: string }) => setError(e?.message ?? String(e)),
    [setError]
  )

  return (
    <div
      className="flex flex-col gap-y-2"
      data-testid="monei-express"
      data-session-id={cart.cartId}
      data-account-id={accountId}
      data-amount={amount}
      data-currency={cart.currency}
      data-wallet-supported={walletSupported ?? ""}
    >
      <div id="monei-express-wallet">
        <PaymentRequest
          accountId={accountId}
          sessionId={cart.cartId}
          amount={amount}
          currency={cart.currency}
          requestBilling
          requestShipping
          shippingOptions={cart.shippingOptions}
          onShippingAddressChange={onShippingAddressChange}
          onShippingOptionChange={onShippingOptionChange}
          onSubmit={onSubmit}
          onError={onError}
          onLoad={setWalletSupported}
        />
      </div>
      {/* Not id="monei-paypal": the PayPal SDK reads window["monei-paypal"]. PayPal returns
          only the payer (name, email, country); monei.js 2.5.0 collects no address. */}
      <div id="monei-express-paypal">
        {paypal.transactionType && (
          <PayPal
            accountId={accountId}
            sessionId={cart.cartId}
            amount={amount}
            currency={cart.currency}
            transactionType={paypal.transactionType}
            onSubmit={onSubmit}
            onError={onError}
          />
        )}
      </div>
      <ErrorMessage error={error ?? paypal.error} data-testid="monei-express-error" />
    </div>
  )
}
