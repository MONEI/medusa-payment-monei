# MONEI example storefront

The storefront of the e2e suite. It is the [Medusa Next.js starter](https://github.com/medusajs/nextjs-starter-medusa) at commit `9818886`, with MONEI modules added. It shows every flow the plugin supports: hosted payment page, embedded monei.js components, saved cards and express checkout.

It is example code. It shows how to call the plugin. It is not a production storefront: read it, copy what you need, and test your own storefront.

The MONEI code is in:

- [`src/modules/checkout/monei`](src/modules/checkout/monei): checkout flows and the return page.
- [`src/modules/checkout/components/payment`](src/modules/checkout/components/payment): payment session creation.
- [`src/modules/products/components/monei-express`](src/modules/products/components/monei-express): express checkout.
- [`src/modules/account/components/saved-cards`](src/modules/account/components/saved-cards): saved cards.

The express buttons show only when the browser has the cookie `monei_express=on`. On the product page they pay a new cart that holds only that product, not the shopper's cart.

## Known limits

Checkout and confirm:

- monei.js has no timeout on `confirmPayment`. When the confirm request hangs, the monei.js modal waits and the storefront shows no error. When `confirmPayment` rejects, the storefront reads the live payment status: a paid or authorized payment goes to the order or the return page; any other status shows the error and keeps the session. Which confirm failures make it reject (a 5xx, a lost response) and which the monei.js modal shows itself is not verified.
- Going back to the review step while a hosted-page "Continue" is still running shows the old session. The new session then replaces it and its payment is canceled.
- If Medusa drops a payment session after the storefront made it, and before the refreshed cart renders, the payment step "Continue" button stays disabled with a spinner. Change the cart or pick the method again.
- The return page stays on "processing" while an AUTH hold waits for the plugin to release it (`releaseUnorderedHoldsAfterMinutes`). The page after the release is not verified.
- monei.js has no PayPal cancel callback. The storefront detects a closed PayPal popup from the PayPal overlay element: it leaves the page without an approval.

Express checkout:

- A second wallet approval while one is in progress is ignored without a message.
- Each express attempt makes a new payment session, which replaces the previous one. A retry after a confirm error replaces a payment that may still complete. If it completes late, the buyer can pay twice and the first payment has no order (not verified).
- Wallets share only the city, postal code, region and country before the payment, and report no cancel. When the shopper picks an address in another city and then closes the wallet sheet, the cart keeps the name and phone but loses the street. A wallet that shortens the postal code (some countries do) counts as another city.
- PayPal returns no shipping address, only the payer name, email and country. A product-page PayPal payment, or a cart-page PayPal payment after the loss above, places an order with no street.
- The wallet amount includes shipping. A calculated shipping option is priced through `/calculate`. An option that gets no price is not shown and is never chosen as the cheapest.
- The express buttons remount when the shopper changes items, quantities or promotion codes. If Medusa removes a code that stops applying after a wallet shipping change, the buttons remount during the wallet callback (not verified).
- What a wallet address in another Medusa region does to the cart is not verified.

Tests:

- The e2e seed has flat shipping options only, so the calculated shipping path is not exercised.
- No spec covers the retry and recovery paths (confirm error, express in-flight guard, return page retries), the billing country session re-creation, the wallet amount rounding or the wallet address handling.
- The starter has type errors that its build ignores. The MONEI modules add none.

## Run it

Do not run it on its own. `pnpm e2e:start` at the repository root builds and starts it in Docker with the backend, on port 18000. See [e2e/README.md](../README.md).
