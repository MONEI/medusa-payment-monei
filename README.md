# medusa-payment-monei

MONEI payment provider for **Medusa v2**. Accept Cards, Bizum, PayPal, Google Pay, Apple Pay, BNPL, MB Way, SEPA Direct Debit and more through [MONEI](https://monei.com) — a licensed European Payment Institution (Banco de España #6911).

## Features

- **Full payment lifecycle**: initiate → authorize → capture → refund → cancel
- **Auth + Capture flow**: pre-authorize and capture when ready (default), or auto-capture on authorization
- **Webhook support**: real-time payment status updates with HMAC signature verification
- **Multi-payment methods**: all MONEI payment methods available automatically (Cards, Bizum, PayPal, Google Pay, Apple Pay, etc.)
- **Hosted Payment Page**: redirect customers to MONEI's secure PCI-compliant payment page
- **monei.js integration**: storefront can use MONEI JS SDK for embedded payment components
- **Partial capture & refund**: supported via MONEI API

## Prerequisites

- Medusa v2 application
- MONEI account ([sign up](https://dashboard.monei.com/signup))
- API Key from MONEI Dashboard → Settings → API Access

## Installation

```bash
npm install medusa-payment-monei
# or
yarn add medusa-payment-monei
```

## Configuration

### 1. Add to `medusa-config.ts`

```ts
import { defineConfig } from "@medusajs/framework/utils"

export default defineConfig({
  // ...
  modules: [
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "medusa-payment-monei",
            id: "monei",
            options: {
              apiKey: process.env.MONEI_API_KEY,
              // Optional: auto-capture payments (default: false)
              // When false, payments use AUTH + manual capture flow
              // When true, payments use SALE flow (captured immediately)
              capture: false,
            },
          },
        ],
      },
    },
  ],
})
```

### 2. Set environment variables

```bash
# .env
MONEI_API_KEY=pk_test_xxxxxxxxxxxxxxxxxxxxx
```

### 3. Enable in Medusa Admin

Go to **Settings → Regions** and enable the MONEI payment provider for your region(s).

The provider registers as `pp_monei_monei` (format: `pp_{identifier}_{id}`).

## Payment Flows

### Default: Auth + Capture (recommended)

1. **Customer selects MONEI** → `initiatePayment` creates a MONEI payment with `transactionType: AUTH`
2. **Customer completes payment** → redirected to MONEI hosted page or uses monei.js component, completes 3DS if needed
3. **MONEI webhook** → `getWebhookActionAndData` receives `AUTHORIZED` status, completes the cart
4. **Admin captures** → `capturePayment` calls MONEI capture API

> ⏰ **Capture window**: Card payments must be captured within **7 days**, Bizum within **30 days**.

### Auto-capture (set `capture: true`)

1. Customer selects MONEI → payment created with `transactionType: SALE`
2. Customer completes payment → funds are captured immediately
3. Webhook receives `SUCCEEDED` status → order is created

## Webhooks

MONEI sends asynchronous webhook notifications to your Medusa server. Medusa provides a built-in webhook endpoint:

```
{your_server_url}/hooks/payment/monei_monei
```

### Setting up webhooks

Configure the callback URL in MONEI Dashboard → Settings → Webhooks, or pass it dynamically via `callbackUrl` in the payment creation.

The plugin verifies the `MONEI-Signature` header using the MONEI Node SDK's built-in signature verification.

## Storefront Integration

### Option A: Hosted Payment Page (simplest)

After `initiatePayment`, the session data contains `redirect_url`. Redirect the customer:

```tsx
// In your checkout component
const paymentSession = cart.payment_collection?.payment_sessions?.[0]

if (paymentSession?.data?.redirect_url) {
  window.location.href = paymentSession.data.redirect_url
}
```

### Option B: monei.js Embedded Components

Use the MONEI JS SDK to embed payment components directly in your checkout:

```tsx
import monei from "@monei-js/components"

// The payment ID from the session data serves as the client reference
const paymentId = paymentSession.data.id

// Render card input
const cardInput = monei.CardInput({
  paymentId,
  onChange: (event) => {
    // Handle validation
  },
})
cardInput.render("#card-input")

// Confirm payment
const result = await monei.confirmPayment({
  paymentId,
  paymentToken: token, // from cardInput.getToken()
})
```

## Payment Methods

All payment methods enabled in your MONEI Dashboard are automatically available:

| Method | Description |
|--------|-------------|
| **Cards** | Visa, Mastercard, Amex via 3D Secure |
| **Bizum** | Spain's #1 mobile payment (direct acquiring) |
| **PayPal** | Global digital wallet |
| **Google Pay** | Android/Chrome payments |
| **Apple Pay** | iOS/Safari payments |
| **Click to Pay** | Visa/Mastercard secure remote commerce |
| **BNPL** | Buy now, pay later (Cofidis, Klarna) |
| **MB Way** | Portuguese mobile payments |
| **Multibanco** | Portuguese bank transfers |
| **SEPA DD** | Euro direct debit |

## API Reference

### Provider Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | *required* | MONEI API Key |
| `capture` | `boolean` | `false` | Auto-capture payments on authorization |
| `webhookSecret` | `string` | - | Optional webhook signing secret |

### Session Data

The `data` object stored in the payment session contains:

| Field | Description |
|-------|-------------|
| `id` | MONEI payment ID |
| `status` | Current MONEI payment status |
| `redirect_url` | URL for hosted payment page |
| `client_secret` | Reference for monei.js (same as payment ID) |
| `session_id` | Medusa session tracking ID |

## Testing

Use test mode credentials from MONEI Dashboard. Test card numbers and Bizum phone numbers are available in the [MONEI Testing documentation](https://docs.monei.com/testing/).

Common test cards:
- **Success**: `4111 1111 1111 1111`
- **3DS Required**: `4000 0000 0000 3220`
- **Declined**: `4000 0000 0000 0002`

## Development

```bash
# Clone and install
git clone https://github.com/MONEI/medusa-payment-monei.git
cd medusa-payment-monei
npm install

# Build
npm run build

# Watch mode
npm run watch
```

### Using as a local module in Medusa

During development, you can place the plugin source directly in your Medusa app:

```
your-medusa-app/
  src/
    modules/
      monei-payment/
        service.ts   ← copy from src/service.ts
        index.ts     ← copy from src/index.ts
```

Then in `medusa-config.ts`:

```ts
{
  resolve: "@medusajs/medusa/payment",
  options: {
    providers: [
      {
        resolve: "./src/modules/monei-payment",
        id: "monei",
        options: {
          apiKey: process.env.MONEI_API_KEY,
        },
      },
    ],
  },
}
```

## About MONEI

[MONEI](https://monei.com) is a licensed Payment Institution regulated by Banco de España (#6911) and a SWIFT member (BIC: MDIPES22). MONEI provides a unified payments platform for European merchants with direct acquiring for Bizum and multi-acquirer card processing.

## License

MIT
