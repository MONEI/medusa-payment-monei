"use client"

import { loadStripe } from "@stripe/stripe-js"
import React from "react"
import StripeWrapper from "./stripe-wrapper"
import { HttpTypes } from "@medusajs/types"
import { isStripeLike } from "@lib/constants"
import { MoneiUi } from "@modules/checkout/monei/constants"
import { MoneiCheckoutProvider } from "@modules/checkout/monei/context"

type PaymentWrapperProps = {
  cart: HttpTypes.StoreCart
  moneiUi: MoneiUi
  children: React.ReactNode
}

const stripeKey =
  process.env.NEXT_PUBLIC_STRIPE_KEY ||
  process.env.NEXT_PUBLIC_MEDUSA_PAYMENTS_PUBLISHABLE_KEY

const medusaAccountId = process.env.NEXT_PUBLIC_MEDUSA_PAYMENTS_ACCOUNT_ID
const stripePromise = stripeKey
  ? loadStripe(
      stripeKey,
      medusaAccountId ? { stripeAccount: medusaAccountId } : undefined
    )
  : null

const PaymentWrapper: React.FC<PaymentWrapperProps> = ({
  cart,
  moneiUi,
  children,
}) => {
  const paymentSession = cart.payment_collection?.payment_sessions?.find(
    (s) => s.status === "pending"
  )

  return (
    <MoneiCheckoutProvider ui={moneiUi}>
      {isStripeLike(paymentSession?.provider_id) &&
      paymentSession &&
      stripePromise ? (
        <StripeWrapper
          paymentSession={paymentSession}
          stripeKey={stripeKey}
          stripePromise={stripePromise}
        >
          {children}
        </StripeWrapper>
      ) : (
        <div>{children}</div>
      )}
    </MoneiCheckoutProvider>
  )
}

export default PaymentWrapper
