"use client"

import { api } from "@monei-js/components"
import { useEffect, useState } from "react"

/** Logos in public/images/card-brands, from the MONEI WooCommerce plugin. */
const LOGOS = new Set([
  "visa",
  "mastercard",
  "amex",
  "discover",
  "diners",
  "jcb",
  "maestro",
  "unionpay",
])

/**
 * The card brands the MONEI account accepts, as the WooCommerce plugin shows them. The
 * client payment methods API needs only the public account id. Shows nothing until it
 * answers, and nothing when it fails: a generic card icon would name no brand.
 */
export default function MoneiCardBrands() {
  const [brands, setBrands] = useState<string[]>([])

  useEffect(() => {
    const accountId = process.env.NEXT_PUBLIC_MONEI_ACCOUNT_ID
    if (!accountId) return
    api
      .getPaymentMethods({ accountId })
      .then((methods) =>
        setBrands(
          (methods.metadata?.card?.brands ?? [])
            .map((brand) => String(brand).toLowerCase())
            .filter((brand) => LOGOS.has(brand))
        )
      )
      .catch(() => setBrands([]))
  }, [])

  return (
    <span className="flex items-center gap-x-1" data-testid="monei-card-brands">
      {brands.map((brand) => (
        // A plain <img>: next/image serves no SVG without dangerouslyAllowSVG.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={brand}
          src={`/images/card-brands/${brand}.svg`}
          alt={brand}
          className="h-5 w-auto"
        />
      ))}
    </span>
  )
}
