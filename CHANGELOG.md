# Changelog

# [1.3.0](https://github.com/MONEI/medusa-payment-monei/compare/v1.2.0...v1.3.0) (2026-11-27)

### Features

* run on a scoped MONEI API key instead of the full account key ([#9](https://github.com/MONEI/medusa-payment-monei/issues/9)) ([02f3cf5](https://github.com/MONEI/medusa-payment-monei/commit/02f3cf5b919e3632d4c97ed35b32954d8be247c3))

# [1.2.0](https://github.com/MONEI/medusa-payment-monei/compare/v1.1.0...v1.2.0) (2026-11-16)

### Features

* register the storefront domains with Apple Pay at startup ([8ecd086](https://github.com/MONEI/medusa-payment-monei/commit/8ecd0865d213ba8905272008b2e4c763f4890183))

# [1.1.0](https://github.com/MONEI/medusa-payment-monei/compare/v1.0.0...v1.1.0) (2026-11-16)

### Features

* default backendUrl to MEDUSA_BACKEND_URL ([3266542](https://github.com/MONEI/medusa-payment-monei/commit/3266542b0f63f12b387726a42d3f6607e724afe0))

# [1.0.0](https://github.com/MONEI/medusa-payment-monei/compare/v0.1.1...v1.0.0) (2026-11-15)

### Features

* rewrite as a Medusa v2 plugin ([720eca3](https://github.com/MONEI/medusa-payment-monei/commit/720eca31bdf279437ca4b81c03c29e26c013ce89))

### BREAKING CHANGES

* amounts are Medusa major units; the package is a plugin; see README upgrade notes.

## 0.1.1 (2026-08-07)

### Chores

- Add Medusa integrations-page keywords (`medusa-plugin-integration`, `medusa-v2`, `medusa-plugin-payment`) so the plugin is listed on medusajs.com integrations

## 0.1.0 (2026-04-12)

### Features

- Initial release
- Full Medusa v2 Payment Module Provider (AbstractPaymentProvider)
- Auth + Capture and auto-capture (SALE) payment flows
- Webhook support with MONEI-Signature verification
- All MONEI payment methods: Cards, Bizum, PayPal, Google Pay, Apple Pay, BNPL, MB Way, SEPA DD
- Hosted Payment Page redirect flow
- monei.js embedded component support
- Partial capture and partial refund
