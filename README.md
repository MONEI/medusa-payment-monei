# medusa-payment-monei

[MONEI](https://monei.com) payment plugin for Medusa v2.

The plugin contains:

- Five payment providers: card, Bizum, PayPal, MB WAY and Multibanco. The card provider also takes Apple Pay and Google Pay through the monei.js `PaymentRequest` component (embedded and express checkout).
- Store API routes for saved cards and for the live payment status.
- Subscribers that report orphan payments, release AUTH holds whose cart never became an order, and remove stale MONEI customers.

## Upgrade from 0.1.x (breaking changes)

Version 1.0.0 is a full rewrite. Read this section before you upgrade.

- **Set `capture: false` to keep AUTH.** 0.1.x authorized by default (AUTH). 1.0.0 charges at once (SALE) by default. If you used the 0.1.x default, set `capture: false` before you deploy 1.0.0. See [Capture mode](#capture-mode).
- **Amounts are Medusa major units.** 0.1.x as published sent the Medusa amount as cents. A 19.99 EUR cart was charged 0.20 EUR. 1.0.0 converts 19.99 to 1999 cents.
- **Check the amounts of your 0.1.x orders.** Some installations fixed the conversion in their own copy of 0.1.x. Compare the MONEI amount of one 0.1.x payment with its Medusa order total.
  - When they are the same, the amounts are correct. You can refund these orders from Medusa.
  - When the MONEI amount is 1/100 of the total, refund these orders in the MONEI dashboard, not from Medusa. A refund from Medusa asks for 100 times what MONEI took.
- **The package is a Medusa plugin.** Add it to `plugins`. The provider `resolve` path is now `medusa-payment-monei/providers/monei`.
- **`backendUrl` is required.** The plugin registers the callback URL on every payment. You do not need a webhook in the MONEI dashboard.
- **Delete the 0.1.x webhook.** If you added a webhook for Medusa in the MONEI dashboard (Settings, Webhooks), delete it. The plugin accepts its events, but each payment then reaches Medusa twice. See [Callbacks](#callbacks).
- **Payments created before the upgrade have no callback URL.** 0.1.x did not register one, so MONEI sends no callback for these payments. Only a webhook in the MONEI dashboard sends their events. Capture, cancel and refund from the Medusa admin still work: the plugin fetches each payment from MONEI and does not use the amount or status that 0.1.x stored. Without a dashboard webhook, a checkout that was open at the upgrade completes only when the buyer comes back to the storefront.
- **A checkout whose MONEI amount is not the cart amount cannot complete.** 1.0.0 compares the MONEI payment with the Medusa session amount and currency, in cents, before it authorizes. A checkout open at the upgrade with a 0.1.x payment of 1/100 of the cart is refused, and the error log names the payment. Cancel it (`AUTHORIZED`) or refund it (`SUCCEEDED`) in the MONEI dashboard.
- **A checkout with a `medusa_` order id cannot complete.** 0.1.x made an order id `medusa_<time>_<random>` when Medusa sent no session id. 1.0.0 completes a cart only for a MONEI payment whose order id is the Medusa payment session id (`payses_...`). Capture, cancel and refund of existing orders do not check the order id. When a buyer paid such a payment and the cart stayed open, cancel it (`AUTHORIZED`) or refund it (`SUCCEEDED`) in the MONEI dashboard.
- **`webhookSecret` is removed.** The plugin verifies the `MONEI-Signature` header with your API key.
- **There is one provider per payment method.** Enable each provider you want on your regions. See [Provider ids](#provider-ids).
- **Send `return_url` for the hosted payment page.** 1.0.0 sends a complete, fail and cancel URL to MONEI only when the create-session request has `return_url` in `data`. Some copies of 0.1.x set `completeUrl` in the plugin. If your storefront relied on such a copy, it must send `return_url` now. Without it, the buyer stays on the MONEI page after the payment. The MONEI callback still completes the cart. `return_url` must be an absolute URL. The plugin adds `session_id` to it, and `monei_canceled=1` on a cancel. See [Hosted payment page](#hosted-payment-page).

  ```ts
  await sdk.store.payment.initiatePaymentSession(cart, {
    provider_id: "pp_monei_monei",
    data: { return_url: "https://shop.example.com/checkout/monei-return" },
  });
  ```

- **Session data changed.** `client_secret` is removed. A create-session request whose `data` holds a key the provider sets (`id`, `session_id`, `amount`, ...) is refused. See [Session data](#session-data).
- **Partial capture is refused.** MONEI payments capture in full only. See [Limits](#limits).
- **Only five methods.** 0.1.x let MONEI offer every method enabled on the account. 1.0.0 offers card, Bizum, PayPal, MB WAY and Multibanco, one per provider. Apple Pay and Google Pay come through the card provider and monei.js `PaymentRequest` only.

## Requirements

- Medusa `>=2.17.0 <3`. CI runs the full end-to-end suite on 2.22.3, and the `capture: false` specs (hosted card included) on 2.17.0. Medusa 2.17.0 itself did not start in our tests with the Redis event bus (`@medusajs/medusa/event-bus-redis`) in the default worker mode: use 2.17.1 or later with Redis.
- Node.js `>=22.22.0`.
- A MONEI account and its API key. Get the key in the MONEI Dashboard, under Settings, API Access.
- A backend URL that MONEI can reach from the internet. MONEI sends payment callbacks to it.

## Installation

```bash
npm install medusa-payment-monei
```

## Configuration

Add the plugin and the payment provider to `medusa-config.ts`:

```ts
import { defineConfig } from "@medusajs/framework/utils";

module.exports = defineConfig({
  // ...
  plugins: ["medusa-payment-monei"],
  modules: [
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "medusa-payment-monei/providers/monei",
            id: "monei",
            options: {
              apiKey: process.env.MONEI_API_KEY,
              backendUrl: process.env.MONEI_BACKEND_URL,
            },
          },
        ],
      },
    },
  ],
});
```

The provider `id` must be `"monei"`. The callback URL, the store routes and the subscriber use this id. Another id breaks them.

### Options

| Option       | Type      | Required | Description                                                                                                                                  |
| ------------ | --------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`     | `string`  | Yes      | MONEI API key. A test mode key creates test payments.                                                                                        |
| `backendUrl` | `string`  | Yes      | Public base URL of the Medusa backend, for example `https://api.example.com`. It must be an absolute `http` or `https` URL. A trailing slash is removed. |
| `accountId`  | `string`  | No       | Partner accounts only: the merchant account to act for.                                                                                      |
| `capture`    | `boolean` | No       | `true` (default) charges at once (SALE). `false` only authorizes (AUTH), for card and PayPal. Bizum, MB WAY and Multibanco always use SALE. A string such as `"false"` is refused. |
| `releaseUnorderedHoldsAfterMinutes` | `number` | No | Minutes after an `AUTHORIZED` callback after which the plugin cancels the hold when its cart has no order. Default `30`. `0` turns the release off. Must be a whole number from `0` to `10080` (7 days). See [Capture mode](#capture-mode). |

### Capture mode

Use `capture: false` for card and PayPal when stock can run out while the buyer pays. Bizum, MB WAY and Multibanco always use SALE.

In Medusa 2.17 and 2.22.3 (the tested versions), cart completion reserves the stock before it authorizes the payment session. When the stock ran out during payment, Medusa creates no order. Then:

- **With `capture: false` (AUTH),** no money is taken. Medusa does not cancel the `AUTHORIZED` payment. The plugin does: `releaseUnorderedHoldsAfterMinutes` (default 30) after the `AUTHORIZED` callback, it checks the cart again. When the cart still has no order, the session still holds the payment and MONEI still shows it `AUTHORIZED`, the plugin deletes the session through the Medusa payment module, under the same cart lock that cart completion uses. The provider then cancels the payment, as on any cart change. An order that exists keeps its hold, captured or not.
- **With SALE,** the buyer is charged. When the MONEI callback runs cart completion and completion fails, Medusa refunds the payment and gives the cart a new payment session.

When a release does not cancel the payment, the plugin logs an error and emits `monei.hold_release_failed`:

```ts
{
  payment_id: string; // MONEI payment id
  session_id: string; // Medusa payment session id
  cart_id: string | null;
  amount: number | null; // major units, null when MONEI could not be reached
  currency: string | null;
  reason: string;
}
```

Subscribe to it to alert your team, and cancel the payment in the MONEI dashboard if the cart has no order. The release is not retried.

Costs and limits of the release:

- **A store that completes carts later than the delay loses the hold.** For example, a store that places orders from a back office hours after payment. Set a longer delay, or `0` to turn the release off.
- **A lost callback is not covered.** The re-check is scheduled only when the `AUTHORIZED` callback reaches the plugin.
- **The re-check is a delayed event.** With the Redis event bus it is a delayed job kept in Redis. With the local event bus it is an in-process timer, and a restart loses it.

### Provider ids

Medusa names each provider `pp_<identifier>_<id>`. Enable the providers on your regions in the Medusa Admin.

| Method                            | Provider id                 | Callback URL                                      |
| --------------------------------- | --------------------------- | ------------------------------------------------- |
| Card (Apple Pay, Google Pay via monei.js) | `pp_monei_monei`    | `<backendUrl>/hooks/payment/monei_monei`            |
| Bizum                             | `pp_monei-bizum_monei`      | `<backendUrl>/hooks/payment/monei-bizum_monei`      |
| PayPal                            | `pp_monei-paypal_monei`     | `<backendUrl>/hooks/payment/monei-paypal_monei`     |
| MB WAY                            | `pp_monei-mbway_monei`      | `<backendUrl>/hooks/payment/monei-mbway_monei`      |
| Multibanco                        | `pp_monei-multibanco_monei` | `<backendUrl>/hooks/payment/monei-multibanco_monei` |

Each provider offers only its own method.

### Event bus

Use the [Redis event bus](https://docs.medusajs.com/resources/infrastructure-modules/event/redis) in production. Medusa delivers MONEI callbacks through the event bus. When the plugin cannot fetch a payment from MONEI, it throws, and the Redis event bus retries the event. The local event bus logs the error and drops the event, so the cart of a paid callback can stay open.

### Callbacks

The plugin accepts two signed formats on the callback URL. Both are signed with your API key in the `MONEI-Signature` header.

- **The payment.** MONEI posts it to the callback URL that the plugin registers on every payment. This is the normal path.
- **An account-webhook event** (`{id, type, objectType, objectId, object}`), from a webhook in the MONEI dashboard. The plugin uses only `charge` events and fetches the payment `objectId`. `object.id` must be the same id. It ignores events for other objects, such as subscriptions.

In both formats the body is only a pointer. The plugin fetches the payment from MONEI and uses its status. You do not need a dashboard webhook.

## How it works

- `initiatePayment` creates a MONEI payment. It does not charge. The `orderId` of the MONEI payment is the Medusa payment session id.
- Every status decision fetches the payment from MONEI. Session data and callback bodies are only pointers.
- The callback completes the cart when the buyer does not come back to the storefront.
- When Medusa deletes a session (for example, after a cart total change), the plugin cancels its `PENDING` or `AUTHORIZED` MONEI payment. This is best effort: a refused cancel is logged at warn level.
- The plugin sends the customer of a signed-in shopper to MONEI, and a billing address. MONEI uses its country to pick the payment processors and methods.
  - The country is `billing_country` from the session data, when the storefront sends it. Send the cart's billing address country. Without it, the plugin sends the country of the signed-in customer's default billing address. When there is no such address either, MONEI uses the country of the buyer's IP address.
  - The signed-in customer's default billing address is sent in full only when it is in that country (or no `billing_country` was sent). Otherwise only the country is sent.
  - The country is sent in uppercase.
  - The plugin reads the country when it creates the session. Medusa keeps the session when the cart total does not change, so when the buyer changes the billing country after that, create a new session. The example storefront does this in the embedded flow.
- Every MONEI request times out after 30 seconds.

### Session data

The storefront can send these keys in `data` when it creates a payment session:

| Key                | Type                 | Description                                                                                                                                                       |
| ------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `return_url`       | `string`             | Optional. The absolute URL where MONEI sends the buyer back from the hosted page. Without it, the plugin sends no complete, fail or cancel URL. Embedded flows do not need it. |
| `monei_session_id` | `string`             | Optional. The monei.js `sessionId` that the card, wallet and express components mount with. MONEI accepts their token only for a payment made with the same value. |
| `save_card`        | `boolean`            | Optional. Card provider and signed-in customers only: `true` saves the card to the customer. For a guest, or when the MONEI customer was deleted, the card is not saved and the plugin logs a warning. |
| `billing_country`  | `string`             | Optional. The ISO 3166-1 alpha-2 code of the cart's billing address, in any case (for example `es`). Any other value is refused. See [How it works](#how-it-works). |
| `expected_amount`  | `number` or `string` | Optional. Express checkout: the amount the wallet showed, in major units. Both amounts are rounded to cents, then compared. The plugin refuses the session when they differ. |

The plugin refuses (400) a create-session request for a MONEI provider whose `data` contains a key of the second table, or `__proto__`. Do not send `session.data` back when you create a session.

Medusa keeps the keys the storefront sent in `session.data` until authorization replaces it. The payment methods (`initiatePayment`, `authorizePayment`, `getPaymentStatus`, `retrievePayment`, `capturePayment`, `cancelPayment`, `refundPayment`) return only these keys, because the store cart API returns `session.data`. `updatePayment` returns the data it got unchanged.

| Key                      | Description                                            |
| ------------------------ | ------------------------------------------------------ |
| `id`                     | MONEI payment id.                                      |
| `session_id`             | Medusa payment session id.                             |
| `amount`                 | Amount in major units.                                 |
| `currency`               | Currency code in uppercase.                            |
| `status`                 | MONEI payment status.                                  |
| `redirect_url`           | MONEI hosted payment page URL.                         |
| `monei_customer_missing` | `true` when the saved MONEI customer no longer exists. |

The return URL gets a `session_id` query parameter. The cancel URL also gets `monei_canceled=1`. MONEI adds nothing to the URL when the buyer cancels on the hosted page, and the payment stays `PENDING`. Without this marker, the return page cannot tell a cancel from a payment in progress.

## Storefront flows

The example storefront in [`e2e/storefront`](e2e/storefront) implements every flow. It is the Medusa Next.js starter with MONEI modules added. The e2e suite pays with it against the MONEI test API. The links below point to its code.

### Hosted payment page

1. Create the session with `return_url`.
2. On "Place order", send the buyer to `session.data.redirect_url`.
3. On the return page, call `cart.complete`. When the cart is not complete yet, poll the cart and `GET /store/monei/payment-status`. Medusa records no failure, so this route is the only way to show a failed payment. A cancelled payment stays `PENDING`: use the `monei_canceled=1` query parameter to detect a cancel.

Code: [`redirect-button.tsx`](e2e/storefront/src/modules/checkout/monei/redirect-button.tsx), [`return.tsx`](e2e/storefront/src/modules/checkout/monei/return.tsx).

The example storefront creates a new session each time the buyer submits the payment step. The old session can point to a payment that the buyer cancelled or failed on the hosted page. Medusa deletes the old session, and the plugin cancels its payment.

### Embedded components (monei.js)

1. Create the session with `monei_session_id`.
2. Mount the monei.js components:
   - Card fields and the Apple Pay and Google Pay button (`PaymentRequest`) mount with your public MONEI account id and the `monei_session_id`. A new session after a cart total change does not remount the card fields, and typed card digits stay. `PaymentRequest` remounts when the cart amount or currency changes: monei.js reads the amount once, at load.
   - Bizum and PayPal mount with `session.data.id` as `paymentId`.
3. On "Place order", get the one-time token and call `confirmPayment({ paymentId: session.data.id, paymentToken })`. For a card token, also send `paymentMethod: { card: { cardholderName } }`: MONEI refuses a card confirm without the cardholder name. 3DS and the Bizum approval run in the monei.js modal.
4. When the payment is `SUCCEEDED` or `AUTHORIZED`, call `cart.complete`. Otherwise go to the return page and let the callback complete the cart. When `confirmPayment` throws, read `GET /store/monei/payment-status` before you show an error: a lost response can hide a payment that went through.

Code: [`card-fields.tsx`](e2e/storefront/src/modules/checkout/monei/card-fields.tsx), [`embedded-button.tsx`](e2e/storefront/src/modules/checkout/monei/embedded-button.tsx), [`use-monei-pay.ts`](e2e/storefront/src/modules/checkout/monei/use-monei-pay.ts). See the [monei.js documentation](https://docs.monei.com/monei-js/overview/).

PayPal notes:

- With `capture: false`, mount every PayPal component (embedded and express) with `transactionType: "AUTH"`. Without it, monei.js loads PayPal with the capture intent, and PayPal cannot pay the AUTH payment. Read the mode from `GET /store/monei/config`.
- monei.js has no PayPal cancel callback. The example storefront detects that the buyer closed the PayPal popup: it watches for the PayPal overlay element to leave the page without an approval.
- Do not give a container element the id `monei-paypal`. Element ids become `window` properties, and the PayPal SDK reads `window["monei-paypal"]` as its namespace.

### Saved cards

The card provider creates a MONEI customer for each signed-in Medusa customer (a Medusa account holder).

1. Create the card session with `save_card: true`. After the payment, MONEI saves the card to the customer.
2. List the saved cards with `GET /store/monei/payment-methods`.
3. Pay with a saved card through `POST /store/monei/confirm`. The permanent card token never reaches the browser. The storefront sends only the opaque id from the list.

MONEI charges a saved card as a merchant-initiated payment, without a 3DS challenge. This is MONEI behaviour.

Code: [`actions.ts`](e2e/storefront/src/modules/checkout/monei/actions.ts), [`saved-cards`](e2e/storefront/src/modules/account/components/saved-cards/index.tsx).

### Express checkout

Apple Pay, Google Pay and PayPal express buttons pay a cart without the checkout form.

1. Mount the buttons with your public MONEI account id and a `monei_session_id`.
2. When the buyer approves, the wallet returns a one-time token and the buyer details. Put the details (email, addresses, shipping option) on the cart.
3. Create the session with `expected_amount` (the amount the wallet showed) and the same `monei_session_id`. The plugin refuses a different amount.
4. Confirm the payment with the wallet token, as in the embedded flow. When the wallet returns a card token (`paymentMethod` is `card`), send `paymentMethod: { card: { cardholderName } }` with the name from the wallet billing details.

The example storefront refuses a wallet result without an email address, because express has no form to collect it.

Code: [`monei-express`](e2e/storefront/src/modules/products/components/monei-express).

### Apple Pay domain

Apple Pay in embedded and express checkout runs on your storefront domain. Register that domain with Apple Pay in the MONEI Dashboard: Settings, Payment methods, Apple Pay, then **Register domain**. See [Register your domain with Apple Pay](https://docs.monei.com/payment-methods/apple-pay/#register-your-domain-with-apple-pay).

## Store API routes

All routes are under `/store`, so they need the publishable API key header like every Medusa store route.

| Route                                    | Auth             | Body or query                               | Response                                                  |
| ---------------------------------------- | ---------------- | ------------------------------------------- | --------------------------------------------------------- |
| `GET /store/monei/payment-methods`       | Customer         |                                             | `{ payment_methods: [{ id, brand, last4, expires_at }] }` |
| `DELETE /store/monei/payment-methods/:id` | Customer         |                                             | `{ id, deleted: true }`                                   |
| `POST /store/monei/confirm`              | Customer         | `{ payment_session_id, payment_method_id }` | `{ status, redirect_url }`                                |
| `GET /store/monei/payment-status`        | None (cart id)   | `?cart_id=...&session_id=...`               | `{ status }`                                              |
| `GET /store/monei/config`                | None             |                                             | `{ capture }`                                             |

- `id` of a saved card is an opaque hash of the MONEI token.
- `expires_at` is in seconds since the Unix epoch.
- `status` is a Medusa session status: `pending`, `authorized`, `captured` or `error`.
- `POST /store/monei/confirm` pays only a card session of the signed-in customer's cart.
- `capture` is the `capture` option. PayPal components need it: see the PayPal notes.

## Orphan payments

An orphan payment is a MONEI payment that is `AUTHORIZED` or `SUCCEEDED`, but whose Medusa session no longer exists or points to another payment. For example, a buyer pays a Multibanco reference after a cart change.

The subscriber logs an error and emits the `monei.orphan_payment` event with this data:

```ts
{
  payment_id: string; // MONEI payment id
  session_id: string; // Medusa payment session id
  amount: number; // major units
  currency: string;
  status: string; // AUTHORIZED or SUCCEEDED
}
```

Subscribe to it to alert your team. If no order was created, cancel an `AUTHORIZED` payment or refund a `SUCCEEDED` payment in the MONEI dashboard. An `AUTHORIZED` payment cannot be refunded.

The event can fire more than once for one payment: for example, once for `AUTHORIZED` and again for `SUCCEEDED`, or again when the event bus retries.

The plugin does not pass a callback for a deleted session to Medusa's core webhook workflow. It logs a warning, `MONEI webhook ignored`, next to the orphan error. This keeps the callback of a deleted session away from Medusa's core workflow.

The same subscriber removes a card account holder whose MONEI customer was deleted. The next session creates a new MONEI customer.

## Limits

- **Full capture only.** Medusa gives the provider no capture amount. An admin middleware refuses a partial capture amount on `POST /admin/payments/:id/capture`. Your own code that runs `capturePaymentWorkflow` with an amount is not checked: MONEI captures in full while Medusa records the amount.
- **Currencies with 2 decimals only.** Other currencies are refused.
- **Dashboard refunds are not synced.** A refund made in the MONEI dashboard does not update the Medusa order.
- **An authorization expires after about 7 days.** Capture an AUTH payment before then.
- **A Multibanco order is created only when the buyer pays.** The cart stays open until then. The callback completes it.
- **A sent Multibanco reference or Bizum request stays payable after a cart change.** It cannot be canceled. When the buyer pays, it becomes an orphan payment, reported by `monei.orphan_payment`.
- **Two equal partial refunds sent at almost the same moment can be merged into one at MONEI.** The plugin reports this as an error when it can detect it. Check the MONEI dashboard before you retry a refund.
- **A refund retried after an unclear answer can refund twice.** A refund can be applied even when its answer is lost or is an error. Then the plugin throws "it may have been applied, check the MONEI dashboard before retrying". Check the dashboard before you retry. For a capture, the plugin checks the payment and accepts it when it is `SUCCEEDED`.
- **Two MONEI customers can appear for one shopper** who opens two first checkouts at the same time. `GET /store/monei/payment-methods` lists the cards of both. A saved card pays only a session made with the MONEI customer that holds it; Medusa uses the first one for new sessions.
- **Rarely, a cart change at the moment a payment is authorized can make Medusa complete another cart that needs no payment.** No money moves. This applies in AUTH mode (`capture: false`) and is Medusa core behaviour.
- **The card provider's `listPaymentMethods` returns opaque ids, not MONEI card tokens.** These are the ids of `GET /store/monei/payment-methods`. `data` holds only `brand`, `last4` and `expires_at`. `deletePaymentMethod` takes an opaque id and refuses an id that is not in the customer's list.

## Testing

Use a test mode API key. Test cards and test phone numbers are in the [MONEI testing documentation](https://docs.monei.com/testing/).

This repository has two test suites:

- Unit tests: `pnpm test`. The MONEI API is mocked at the HTTP layer.
- End-to-end tests: a real Medusa backend and the example storefront in Docker, paying against the MONEI test API. See [e2e/README.md](e2e/README.md).

MB WAY and Multibanco have unit tests only. MONEI test mode has no processor for them.

## Development

```bash
git clone https://github.com/MONEI/medusa-payment-monei.git
cd medusa-payment-monei
pnpm install
pnpm build          # medusa plugin:build
pnpm test           # build, then unit tests
pnpm exec vp check  # format, lint and type checks
```

### Release

Releases use [release-it](https://github.com/release-it/release-it) with the conventional changelog plugin. It runs the unit tests, bumps the version, updates `CHANGELOG.md`, tags `v<version>` and creates the GitHub release. When the GitHub release is published, the publish workflow publishes the package to npm.

```bash
pnpm release  # the bump the commit types recommend
```

The rewrite commit has a `BREAKING CHANGE:` footer, so the next `pnpm release` proposes 1.0.0.

To use a local build in a Medusa app, see the [Medusa plugin documentation](https://docs.medusajs.com/learn/fundamentals/plugins).

## License

MIT
