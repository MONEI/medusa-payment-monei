import { Metadata } from "next"
import { notFound } from "next/navigation"

import SavedCards from "@modules/account/components/saved-cards"
import { listMoneiSavedCards } from "@modules/checkout/monei/actions"

export const metadata: Metadata = {
  title: "Saved cards",
  description: "Manage your saved cards",
}

export default async function Cards() {
  const { signedIn, cards } = await listMoneiSavedCards()

  if (!signedIn) {
    notFound()
  }

  return (
    <div className="w-full" data-testid="saved-cards-page-wrapper">
      <div className="mb-8 flex flex-col gap-y-4">
        <h1 className="text-2xl-semi">Saved cards</h1>
      </div>
      <SavedCards cards={cards} />
    </div>
  )
}
