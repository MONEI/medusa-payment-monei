"use client"

import { Button, Heading } from "@medusajs/ui"

import CartTotals from "@modules/common/components/cart-totals"
import Divider from "@modules/common/components/divider"
import DiscountCode from "@modules/checkout/components/discount-code"
import LocalizedClientLink from "@modules/common/components/localized-client-link"
import { HttpTypes } from "@medusajs/types"
import dynamic from "next/dynamic"
import { useParams } from "next/navigation"

// monei.js touches the DOM, so its components never render on the server.
const MoneiExpress = dynamic(
  () => import("@modules/products/components/monei-express"),
  { ssr: false }
)

type SummaryProps = {
  cart: HttpTypes.StoreCart & {
    promotions: HttpTypes.StorePromotion[]
  }
}

function getCheckoutStep(cart: HttpTypes.StoreCart) {
  if (!cart?.shipping_address?.address_1 || !cart.email) {
    return "address"
  } else if (cart?.shipping_methods?.length === 0) {
    return "delivery"
  } else {
    return "payment"
  }
}

/**
 * What the shopper changes on this page: items, quantities, promotion codes. Not the total:
 * a shipping option picked in the wallet sheet changes it, and a remount then would destroy
 * the wallet while its shipping callback runs. Sorted: item order is not guaranteed.
 */
function expressKey(cart: SummaryProps["cart"], countryCode: string) {
  const items = (cart.items ?? []).map((i) => `${i.variant_id}:${i.quantity}`).sort()
  const codes = (cart.promotions ?? [])
    .filter((p) => !p.is_automatic)
    .map((p) => p.code)
    .sort()
  return [cart.id, countryCode, items.join(","), codes.join(",")].join("|")
}

const Summary = ({ cart }: SummaryProps) => {
  const step = getCheckoutStep(cart)
  const { countryCode } = useParams<{ countryCode: string }>()

  return (
    <div className="flex flex-col gap-y-4">
      <Heading level="h2" className="text-[2rem] leading-[2.75rem]">
        Summary
      </Heading>
      <DiscountCode cart={cart} />
      <Divider />
      <CartTotals totals={cart} />
      <LocalizedClientLink
        href={"/checkout?step=" + step}
        data-testid="checkout-button"
      >
        <Button className="w-full h-10">Go to checkout</Button>
      </LocalizedClientLink>
      {/* A cart change made on this page remounts the buttons with the new amount. */}
      <MoneiExpress
        key={expressKey(cart, countryCode)}
        cartId={cart.id}
        countryCode={countryCode}
      />
    </div>
  )
}

export default Summary
