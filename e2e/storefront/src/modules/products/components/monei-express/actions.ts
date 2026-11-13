"use server"

import { sdk } from "@lib/config"
import { getAuthHeaders, getCacheTag } from "@lib/data/cookies"
import { getRegion } from "@lib/data/regions"
import { toMinor } from "@modules/checkout/monei/constants"
import { messageOf } from "@modules/checkout/monei/message"
import { HttpTypes } from "@medusajs/types"
import { revalidateTag } from "next/cache"

/** A shipping option in the shape monei.js wallets take: amounts in minor units. */
export type ExpressShippingOption = { id: string; label: string; amount: number }

export type ExpressCart = {
  cartId: string
  /** Cart total in minor units: what the wallet sheet shows. */
  amount: number
  currency: string
  shippingOptions: ExpressShippingOption[]
}

/** Wallet billing or shipping details (monei.js `BillingDetails`). */
export type ExpressContact = {
  name?: string
  email?: string
  phone?: string
  company?: string
  address?: {
    country?: string
    city?: string
    line1?: string
    line2?: string
    zip?: string
    state?: string
  }
}

type Failure = { error: string }

async function headers() {
  return { ...(await getAuthHeaders()) }
}

async function revalidateCarts() {
  revalidateTag(await getCacheTag("carts"))
  revalidateTag(await getCacheTag("fulfillment"))
}

/**
 * Every helper here takes the cart id explicitly. The starter's cart helpers act on the
 * cookie cart, which on the product page is the shopper's regular cart, not the express one.
 */
async function fetchCart(cartId: string) {
  const { cart } = await sdk.client.fetch<HttpTypes.StoreCartResponse>(
    `/store/carts/${cartId}`,
    {
      query: {
        fields:
          "id,total,currency_code,email,shipping_address.*,billing_address.country_code,shipping_methods.shipping_option_id,*payment_collection.payment_sessions",
      },
      headers: await headers(),
      cache: "no-store",
    }
  )
  return cart
}

/**
 * The options that serve the cart, each with its price. A calculated option is priced
 * by `/calculate` for the cart as it is now; one that gets no price is left out, never
 * quoted as free.
 */
async function shippingOptionsOf(cartId: string) {
  const { shipping_options } =
    await sdk.client.fetch<HttpTypes.StoreShippingOptionListResponse>(
      `/store/shipping-options`,
      { query: { cart_id: cartId }, headers: await headers(), cache: "no-store" }
    )
  const priced = await Promise.all(
    shipping_options.map(async (option) => {
      if (option.price_type !== "calculated") return option
      const amount = await sdk.client
        .fetch<{ shipping_option: HttpTypes.StoreCartShippingOption }>(
          `/store/shipping-options/${option.id}/calculate`,
          {
            method: "POST",
            body: { cart_id: cartId },
            headers: await headers(),
            cache: "no-store",
          }
        )
        .then(({ shipping_option }) => shipping_option.amount)
        .catch(() => undefined)
      return { ...option, amount }
    })
  )
  return priced.filter(
    (option): option is typeof option & { amount: number } =>
      typeof option.amount === "number"
  )
}

/**
 * Gives the cart its cheapest shipping option when it has none that serves it: an
 * address change makes Medusa drop a method the new address cannot use. False when no
 * option serves the cart.
 */
async function ensureShippingMethod(cartId: string): Promise<boolean> {
  const [cart, options] = await Promise.all([
    fetchCart(cartId),
    shippingOptionsOf(cartId),
  ])
  const selected = cart.shipping_methods?.[0]?.shipping_option_id
  if (selected && options.some((o) => o.id === selected)) return true
  const [cheapest] = options.sort((a, b) => a.amount - b.amount)
  if (!cheapest) return false
  await sdk.store.cart.addShippingMethod(
    cartId,
    { option_id: cheapest.id },
    {},
    await headers()
  )
  return true
}

async function describe(cartId: string): Promise<ExpressCart> {
  const [cart, options] = await Promise.all([
    fetchCart(cartId),
    shippingOptionsOf(cartId),
  ])
  const selected = cart.shipping_methods?.[0]?.shipping_option_id
  return {
    cartId,
    amount: toMinor(cart.total),
    currency: cart.currency_code.toUpperCase(),
    // The wallet shows the option the cart already has as selected.
    shippingOptions: options
      .map((o) => ({ id: o.id, label: o.name, amount: toMinor(o.amount) }))
      .sort((a, b) => Number(b.id === selected) - Number(a.id === selected)),
  }
}

/**
 * The cart the wallet pays. Product page: a new cart holding only that product, never the
 * cookie cart. Cart page: the shopper's cart. Either way the cart gets the storefront's
 * country and its cheapest shipping option, so the amount the wallet shows includes
 * shipping before the shopper opens it.
 */
export async function prepareMoneiExpressCart(
  input: { variantId: string; countryCode: string } | { cartId: string; countryCode: string }
): Promise<ExpressCart | Failure> {
  try {
    let cartId: string
    if ("variantId" in input) {
      const region = await getRegion(input.countryCode)
      if (!region) return { error: `No region serves ${input.countryCode}` }
      const { cart } = await sdk.store.cart.create(
        {
          region_id: region.id,
          items: [{ variant_id: input.variantId, quantity: 1 }],
          shipping_address: { country_code: input.countryCode },
        },
        {},
        await headers()
      )
      cartId = cart.id
    } else {
      cartId = input.cartId
      const cart = await fetchCart(cartId)
      if (!cart.shipping_address?.country_code) {
        await sdk.store.cart.update(
          cartId,
          { shipping_address: keptAddress(cart.shipping_address, input.countryCode) },
          {},
          await headers()
        )
      }
    }

    if (!(await ensureShippingMethod(cartId))) {
      return { error: "No shipping option serves this cart." }
    }
    await revalidateCarts()
    return await describe(cartId)
  } catch (error) {
    return { error: messageOf(error) }
  }
}

/**
 * The shopper picked an address in the wallet sheet; wallets share only city, state, zip
 * and country before the payment. On the cart page this is the shopper's cart, and the
 * wallet reports no cancel, so the update keeps the name, phone and company. The street
 * stays only while the location is the same: a street of another city is no address.
 * Throwing tells the wallet the address cannot be served.
 */
export async function updateMoneiExpressAddress(
  cartId: string,
  address: NonNullable<ExpressContact["address"]>
): Promise<{ amount: number; shippingOptions: ExpressShippingOption[] } | Failure> {
  try {
    const current = (await fetchCart(cartId)).shipping_address ?? undefined
    const location = {
      country_code: address.country?.toLowerCase(),
      city: address.city,
      postal_code: address.zip,
      province: address.state,
    }
    const same = (a?: string | null, b?: string | null) =>
      (a ?? "").replace(/\s+/g, "").toLowerCase() ===
      (b ?? "").replace(/\s+/g, "").toLowerCase()
    const sameLocation =
      same(location.country_code, current?.country_code) &&
      same(location.city, current?.city) &&
      same(location.postal_code, current?.postal_code)
    const kept = keptAddress(current, location.country_code ?? "")
    await sdk.store.cart.update(
      cartId,
      {
        shipping_address: {
          ...kept,
          ...(sameLocation ? {} : { address_1: undefined, address_2: undefined }),
          ...location,
        },
      },
      {},
      await headers()
    )
    // The total the wallet shows must include the option it shows as selected.
    const served = await ensureShippingMethod(cartId)
    await revalidateCarts()
    if (!served) return { error: "No shipping option serves this address." }
    const { amount, shippingOptions } = await describe(cartId)
    return { amount, shippingOptions }
  } catch (error) {
    return { error: messageOf(error) }
  }
}

/** The shopper picked another shipping option in the wallet sheet: the new total. */
export async function selectMoneiExpressShipping(
  cartId: string,
  optionId: string
): Promise<{ amount: number } | Failure> {
  try {
    await sdk.store.cart.addShippingMethod(
      cartId,
      { option_id: optionId },
      {},
      await headers()
    )
    await revalidateCarts()
    return { amount: toMinor((await fetchCart(cartId)).total) }
  } catch (error) {
    return { error: messageOf(error) }
  }
}

const splitName = (name?: string) => {
  const [first = "", ...rest] = (name ?? "").trim().split(/\s+/)
  return { first_name: first, last_name: rest.join(" ") }
}

const toAddress = (
  contact: ExpressContact,
  fallbackCountry: string
): HttpTypes.StoreAddAddress => ({
  ...splitName(contact.name),
  phone: contact.phone,
  company: contact.company,
  address_1: contact.address?.line1,
  address_2: contact.address?.line2,
  city: contact.address?.city,
  postal_code: contact.address?.zip,
  province: contact.address?.state,
  // Medusa keeps country codes in lowercase.
  country_code: (contact.address?.country || fallbackCountry).toLowerCase(),
})

/** The cart's address as an update payload: Medusa saves the address it gets, unmerged. */
const keptAddress = (
  address: HttpTypes.StoreCartAddress | undefined,
  country: string
): HttpTypes.StoreAddAddress => ({
  first_name: address?.first_name,
  last_name: address?.last_name,
  phone: address?.phone,
  company: address?.company,
  address_1: address?.address_1,
  address_2: address?.address_2,
  city: address?.city,
  postal_code: address?.postal_code,
  province: address?.province,
  country_code: country,
})

/**
 * Puts the wallet result on the cart: email, addresses and the shipping option the
 * shopper chose. PayPal returns no shipping address, only the payer (name, email,
 * country), so the cart keeps the delivery address it has, named after the payer when
 * it has no name. A billing contact without a street takes the delivery address, as
 * in MONEI-WooCommerce express checkout.
 */
export async function applyMoneiExpressResult(
  cartId: string,
  {
    email,
    billing,
    shipping,
    shippingOptionId,
  }: {
    email: string
    billing?: ExpressContact
    shipping?: ExpressContact
    shippingOptionId?: string
  }
): Promise<{ ok: true } | Failure> {
  try {
    const cart = await fetchCart(cartId)
    const country = cart.shipping_address?.country_code ?? ""
    const payer = splitName(billing?.name)
    const kept = keptAddress(cart.shipping_address, country)
    // As in MONEI-WooCommerce: shipping details without a country count as none.
    const shippingAddress = shipping?.address?.country
      ? toAddress(shipping, country)
      : kept.first_name
        ? kept
        : { ...kept, ...payer }
    const own = billing ? toAddress(billing, country) : undefined
    const billingAddress = !own
      ? shippingAddress
      : own.address_1
        ? own
        : {
            ...shippingAddress,
            ...(own.first_name ? payer : {}),
            phone: own.phone ?? shippingAddress.phone,
          }
    await sdk.store.cart.update(
      cartId,
      { email, shipping_address: shippingAddress, billing_address: billingAddress },
      {},
      await headers()
    )
    if (
      shippingOptionId &&
      shippingOptionId !== cart.shipping_methods?.[0]?.shipping_option_id
    ) {
      await sdk.store.cart.addShippingMethod(
        cartId,
        { option_id: shippingOptionId },
        {},
        await headers()
      )
    }
    await revalidateCarts()
    return { ok: true }
  } catch (error) {
    return { error: messageOf(error) }
  }
}

/**
 * The MONEI session for the wallet token. `expected_amount` is the amount the wallet
 * showed, in major units: the plugin refuses the session when the cart total differs.
 * `monei_session_id` is the monei.js session the token was made with. `billing_country`
 * comes from the wallet billing address already put on the cart.
 */
export async function createMoneiExpressSession(
  cartId: string,
  providerId: string,
  expectedAmount: string
): Promise<HttpTypes.StorePaymentSession | Failure> {
  try {
    const cart = await fetchCart(cartId)
    const { payment_collection } = await sdk.store.payment.initiatePaymentSession(
      cart,
      {
        provider_id: providerId,
        data: {
          expected_amount: expectedAmount,
          monei_session_id: cartId,
          billing_country: cart.billing_address?.country_code,
        },
      },
      {},
      await headers()
    )
    revalidateTag(await getCacheTag("carts"))
    const session = payment_collection.payment_sessions?.find(
      (s) => s.provider_id === providerId
    )
    if (!session) return { error: "The payment could not be prepared." }
    return session
  } catch (error) {
    return { error: messageOf(error) }
  }
}
