import MoneiReturn from "@modules/checkout/monei/return"
import { Metadata } from "next"
import { Suspense } from "react"

export const metadata: Metadata = {
  title: "Payment",
}

export default async function MoneiReturnPage(props: {
  params: Promise<{ countryCode: string }>
}) {
  const { countryCode } = await props.params
  return (
    <Suspense>
      <MoneiReturn countryCode={countryCode} />
    </Suspense>
  )
}
