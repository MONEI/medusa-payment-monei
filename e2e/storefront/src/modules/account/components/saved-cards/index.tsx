"use client"

import { Button } from "@medusajs/ui"
import ErrorMessage from "@modules/checkout/components/error-message"
import {
  MoneiSavedCard,
  deleteMoneiSavedCard,
} from "@modules/checkout/monei/actions"
import { messageOf } from "@modules/checkout/monei/message"
import { useRouter } from "next/navigation"
import { useState } from "react"

/** The shopper's MONEI saved cards, each with a delete button. */
export default function SavedCards({ cards }: { cards: MoneiSavedCard[] }) {
  const router = useRouter()
  const [deleting, setDeleting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const remove = async (id: string) => {
    setError(null)
    setDeleting(id)
    try {
      await deleteMoneiSavedCard(id)
      router.refresh()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setDeleting(null)
    }
  }

  if (!cards.length) {
    return <p data-testid="no-saved-cards">You have no saved cards.</p>
  }

  return (
    <div className="flex flex-col gap-y-4">
      {cards.map((card) => (
        <div
          key={card.id}
          className="flex items-center justify-between border rounded-md p-4"
          data-testid="saved-card"
        >
          <span>
            <span className="capitalize">{card.brand ?? "Card"}</span> ••••{" "}
            {card.last4}
          </span>
          <Button
            variant="secondary"
            isLoading={deleting === card.id}
            onClick={() => remove(card.id)}
            data-testid="delete-saved-card-button"
          >
            Delete
          </Button>
        </div>
      ))}
      <ErrorMessage error={error} data-testid="saved-cards-error" />
    </div>
  )
}
