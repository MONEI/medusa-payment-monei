"use client"

import { HttpTypes } from "@medusajs/types"
import { Button } from "@medusajs/ui"
import ErrorMessage from "@modules/checkout/components/error-message"
import { useState } from "react"

/** "Place order" for the hosted flow: the order is placed on the return page. */
export default function MoneiRedirectButton({
  session,
  notReady,
  "data-testid": dataTestId,
}: {
  session: HttpTypes.StorePaymentSession
  notReady: boolean
  "data-testid"?: string
}) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const redirect = () => {
    const url = session.data?.redirect_url
    if (typeof url !== "string" || !url) {
      setError("This payment cannot be opened. Go back to the payment step.")
      return
    }
    setSubmitting(true)
    window.location.assign(url)
  }

  return (
    <>
      <Button
        disabled={notReady}
        isLoading={submitting}
        onClick={redirect}
        size="large"
        data-testid={dataTestId}
      >
        Place order
      </Button>
      <ErrorMessage error={error} data-testid="monei-payment-error-message" />
    </>
  )
}
