"use client"

import { RadioGroup } from "@headlessui/react"
import { isStripeLike, paymentInfoMap } from "@lib/constants"
import { initiatePaymentSession } from "@lib/data/cart"
import {
  MONEI_CARD,
  hasMoneiComponent,
  isMonei,
  moneiReturnUrl,
} from "@modules/checkout/monei/constants"
import {
  moneiSessionOf,
  moneiSessionStale,
  useMoneiCheckout,
  wantsSavedCard,
} from "@modules/checkout/monei/context"
import { CheckCircleSolid, CreditCard } from "@medusajs/icons"
import { Button, Container, Heading, Text, clx } from "@medusajs/ui"
import ErrorMessage from "@modules/checkout/components/error-message"
import PaymentContainer, {
  StripeCardContainer,
} from "@modules/checkout/components/payment-container"
import Divider from "@modules/common/components/divider"
import {
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
} from "next/navigation"
import dynamic from "next/dynamic"
import { useCallback, useEffect, useRef, useState } from "react"

// monei.js touches the DOM, so its components never render on the server.
const MoneiCardFields = dynamic(
  () => import("@modules/checkout/monei/card-fields"),
  { ssr: false }
)

const Payment = ({
  cart,
  availablePaymentMethods,
}: {
  cart: any
  availablePaymentMethods: any[]
}) => {
  const activeSession = cart.payment_collection?.payment_sessions?.find(
    (paymentSession: any) => paymentSession.status === "pending"
  )

  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cardBrand, setCardBrand] = useState<string | null>(null)
  const [cardComplete, setCardComplete] = useState(false)
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState(
    activeSession?.provider_id ?? ""
  )

  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const { countryCode } = useParams<{ countryCode: string }>()

  const isOpen = searchParams.get("step") === "payment"

  // Embedded flow: the selected MONEI method keeps one pending session. It is made when
  // the method is picked (so it carries the guest/customer context of that moment), and
  // made again when Medusa drops it on a cart total change or the browser confirm fails,
  // when the shopper changes whether the new card is saved, and when the billing country
  // changes (MONEI picks processors by it; Medusa keeps the session when the total stays).
  const moneiCheckout = useMoneiCheckout()
  const { ui: moneiUi, setSelectedProviderId } = moneiCheckout
  const moneiEmbedded =
    moneiUi.flow === "embedded" && hasMoneiComponent(selectedPaymentMethod)
  const moneiSession = moneiSessionOf(cart, selectedPaymentMethod)
  const saveMoneiCard =
    selectedPaymentMethod === MONEI_CARD && wantsSavedCard(moneiCheckout)
  const billingCountry = cart.billing_address?.country_code
  const needsMoneiSession =
    moneiEmbedded &&
    (cart.shipping_methods?.length ?? 0) > 0 &&
    moneiSessionStale(moneiSession, moneiCheckout, billingCountry)
  const [moneiAttempt, setMoneiAttempt] = useState(0)
  const creatingMoneiSession = useRef(false)
  // Continue waits for the session; after a failed creation it tries again.
  const [moneiSessionFailed, setMoneiSessionFailed] = useState(false)
  const waitingForMoneiSession = needsMoneiSession && !moneiSessionFailed

  useEffect(() => {
    setSelectedProviderId(selectedPaymentMethod)
  }, [selectedPaymentMethod, setSelectedProviderId])

  // A new session arrived: check it against the current choice (the shopper may have
  // changed the save choice or the billing country while it was being made). Declared
  // before the effect below, so that effect runs again with the guard cleared.
  useEffect(() => {
    creatingMoneiSession.current = false
  }, [moneiSession?.id])

  useEffect(() => {
    if (!needsMoneiSession) {
      creatingMoneiSession.current = false
      return
    }
    // Until the refreshed cart shows the new session; a failure waits for a re-pick or
    // Continue.
    if (creatingMoneiSession.current) return
    creatingMoneiSession.current = true
    // `initiatePaymentSession` is a server action: Next runs them one at a time, so a
    // method switch waits for the request in flight. Two at once could leave two sessions
    // in the collection (Medusa's create-session workflow takes no lock).
    initiatePaymentSession(cart, {
      provider_id: selectedPaymentMethod,
      data: {
        return_url: moneiReturnUrl(countryCode, cart.id),
        monei_session_id: cart.id,
        billing_country: billingCountry,
        ...(saveMoneiCard ? { save_card: true } : {}),
      },
    })
      .then(() => router.refresh())
      .catch((err) => {
        setMoneiSessionFailed(true)
        setError(err.message)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    needsMoneiSession,
    selectedPaymentMethod,
    moneiAttempt,
    saveMoneiCard,
    billingCountry,
    moneiSession?.id,
  ])

  const retryMoneiSession = () => {
    setError(null)
    setMoneiSessionFailed(false)
    creatingMoneiSession.current = false
    setMoneiAttempt((n) => n + 1)
  }

  const setPaymentMethod = async (method: string) => {
    setSelectedPaymentMethod(method)
    retryMoneiSession()
    if (isStripeLike(method)) {
      await initiatePaymentSession(cart, {
        provider_id: method,
      })
    }
  }

  const paidByGiftcard =
    cart?.gift_cards && cart?.gift_cards?.length > 0 && cart?.total === 0

  const paymentReady =
    (activeSession && cart?.shipping_methods.length !== 0) || paidByGiftcard

  const createQueryString = useCallback(
    (name: string, value: string) => {
      const params = new URLSearchParams(searchParams)
      params.set(name, value)

      return params.toString()
    },
    [searchParams]
  )

  const handleEdit = () => {
    router.push(pathname + "?" + createQueryString("step", "payment"), {
      scroll: false,
    })
  }

  const handleSubmit = async () => {
    // Review must not open on the session of the method the shopper left: it is being
    // deleted, and a payment on it would have no order.
    if (needsMoneiSession) return retryMoneiSession()
    setIsLoading(true)
    try {
      const shouldInputCard =
        isStripeLike(selectedPaymentMethod) && !activeSession

      const checkActiveSession =
        activeSession?.provider_id === selectedPaymentMethod

      // Hosted flow: a MONEI session is always recreated. The current one may point at a
      // payment the buyer canceled or failed on the hosted page, and replacing it cancels
      // that payment. The embedded flow keeps its session (see above).
      if (isMonei(selectedPaymentMethod)) {
        if (!moneiEmbedded) {
          await initiatePaymentSession(cart, {
            provider_id: selectedPaymentMethod,
            data: {
              return_url: moneiReturnUrl(countryCode, cart.id),
              billing_country: billingCountry,
            },
          })
        }
      } else if (!checkActiveSession) {
        await initiatePaymentSession(cart, {
          provider_id: selectedPaymentMethod,
        })
      }

      if (!shouldInputCard) {
        return router.push(
          pathname + "?" + createQueryString("step", "review"),
          {
            scroll: false,
          }
        )
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    setError(null)
  }, [isOpen])

  return (
    <div className="bg-white">
      <div className="flex flex-row items-center justify-between mb-6">
        <Heading
          level="h2"
          className={clx(
            "flex flex-row text-3xl-regular gap-x-2 items-baseline",
            {
              "opacity-50 pointer-events-none select-none":
                !isOpen && !paymentReady,
            }
          )}
        >
          Payment
          {!isOpen && paymentReady && <CheckCircleSolid />}
        </Heading>
        {!isOpen && paymentReady && (
          <Text>
            <button
              onClick={handleEdit}
              className="text-ui-fg-interactive hover:text-ui-fg-interactive-hover"
              data-testid="edit-payment-button"
            >
              Edit
            </button>
          </Text>
        )}
      </div>
      <div>
        <div className={isOpen ? "block" : "hidden"}>
          {!paidByGiftcard && availablePaymentMethods?.length && (
            <>
              <RadioGroup
                value={selectedPaymentMethod}
                onChange={(value: string) => setPaymentMethod(value)}
              >
                {availablePaymentMethods.map((paymentMethod) => (
                  <div key={paymentMethod.id}>
                    {isStripeLike(paymentMethod.id) ? (
                      <StripeCardContainer
                        paymentProviderId={paymentMethod.id}
                        selectedPaymentOptionId={selectedPaymentMethod}
                        paymentInfoMap={paymentInfoMap}
                        setCardBrand={setCardBrand}
                        setError={setError}
                        setCardComplete={setCardComplete}
                      />
                    ) : (
                      <PaymentContainer
                        paymentInfoMap={paymentInfoMap}
                        paymentProviderId={paymentMethod.id}
                        selectedPaymentOptionId={selectedPaymentMethod}
                      />
                    )}
                  </div>
                ))}
              </RadioGroup>
              {moneiUi.flow === "embedded" &&
                selectedPaymentMethod === MONEI_CARD && (
                  <MoneiCardFields cart={cart} session={moneiSession} />
                )}
            </>
          )}

          {paidByGiftcard && (
            <div className="flex flex-col w-1/3">
              <Text className="txt-medium-plus text-ui-fg-base mb-1">
                Payment method
              </Text>
              <Text
                className="txt-medium text-ui-fg-subtle"
                data-testid="payment-method-summary"
              >
                Gift card
              </Text>
            </div>
          )}

          <ErrorMessage
            error={error}
            data-testid="payment-method-error-message"
          />

          <Button
            size="large"
            className="mt-6"
            onClick={handleSubmit}
            isLoading={isLoading || waitingForMoneiSession}
            disabled={
              (isStripeLike(selectedPaymentMethod) && !cardComplete) ||
              (!selectedPaymentMethod && !paidByGiftcard) ||
              waitingForMoneiSession
            }
            data-testid="submit-payment-button"
          >
            {!activeSession && isStripeLike(selectedPaymentMethod)
              ? " Enter card details"
              : "Continue to review"}
          </Button>
        </div>

        <div className={isOpen ? "hidden" : "block"}>
          {cart && paymentReady && activeSession ? (
            <div className="flex items-start gap-x-1 w-full">
              <div className="flex flex-col w-1/3">
                <Text className="txt-medium-plus text-ui-fg-base mb-1">
                  Payment method
                </Text>
                <Text
                  className="txt-medium text-ui-fg-subtle"
                  data-testid="payment-method-summary"
                >
                  {paymentInfoMap[activeSession?.provider_id]?.title ||
                    activeSession?.provider_id}
                </Text>
              </div>
              <div className="flex flex-col w-1/3">
                <Text className="txt-medium-plus text-ui-fg-base mb-1">
                  Payment details
                </Text>
                <div
                  className="flex gap-2 txt-medium text-ui-fg-subtle items-center"
                  data-testid="payment-details-summary"
                >
                  <Container className="flex items-center h-7 w-fit p-2 bg-ui-button-neutral-hover">
                    {paymentInfoMap[selectedPaymentMethod]?.icon || (
                      <CreditCard />
                    )}
                  </Container>
                  <Text>
                    {isStripeLike(selectedPaymentMethod) && cardBrand
                      ? cardBrand
                      : "Another step will appear"}
                  </Text>
                </div>
              </div>
            </div>
          ) : paidByGiftcard ? (
            <div className="flex flex-col w-1/3">
              <Text className="txt-medium-plus text-ui-fg-base mb-1">
                Payment method
              </Text>
              <Text
                className="txt-medium text-ui-fg-subtle"
                data-testid="payment-method-summary"
              >
                Gift card
              </Text>
            </div>
          ) : null}
        </div>
      </div>
      <Divider className="mt-8" />
    </div>
  )
}

export default Payment
