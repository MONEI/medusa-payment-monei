import { retrieveCart } from "@lib/data/cart"
import { retrieveCustomer } from "@lib/data/customer"
import PaymentWrapper from "@modules/checkout/components/payment-wrapper"
import CheckoutForm from "@modules/checkout/templates/checkout-form"
import CheckoutSummary from "@modules/checkout/templates/checkout-summary"
import {
  MONEI_CARD_LAYOUT_COOKIE,
  MONEI_FLOW_COOKIE,
  MoneiUi,
} from "@modules/checkout/monei/constants"
import { cookies } from "next/headers"
import { Metadata } from "next"
import { notFound } from "next/navigation"

export const metadata: Metadata = {
  title: "Checkout",
}

export default async function Checkout() {
  const cart = await retrieveCart()

  if (!cart) {
    return notFound()
  }

  const customer = await retrieveCustomer()

  const jar = await cookies()
  // The cookie (set by the e2e specs) wins; MONEI_FLOW_DEFAULT sets the flow of a deployment.
  const checkoutFlow = (cookie?: string): MoneiUi["flow"] =>
    cookie === "embedded" || cookie === "hosted"
      ? cookie
      : process.env.MONEI_FLOW_DEFAULT === "embedded"
        ? "embedded"
        : "hosted"
  const moneiUi: MoneiUi = {
    flow: checkoutFlow(jar.get(MONEI_FLOW_COOKIE)?.value),
    cardLayout:
      jar.get(MONEI_CARD_LAYOUT_COOKIE)?.value === "split" ? "split" : "single",
  }

  return (
    <div className="grid grid-cols-1 small:grid-cols-[1fr_416px] content-container gap-x-40 py-12">
      <PaymentWrapper cart={cart} moneiUi={moneiUi}>
        <CheckoutForm cart={cart} customer={customer} />
      </PaymentWrapper>
      <CheckoutSummary cart={cart} />
    </div>
  )
}
