# Scoped API key from env: medusa-payment-monei

Trello: https://trello.com/c/xaRD0Pxs

## Overview

- Today the plugin takes `apiKey` from env (`MONEI_API_KEY`), usually the account's full-reach `pk_`
  key, and verifies callbacks by `v1` with it (`src/providers/monei/core/webhook.ts`).
- After this plan, `apiKey` may also be a scoped `mk_` key made in the MONEI dashboard (API keys,
  `createScopedApiKey`), with only the permissions the plugin needs. A new `signingSecret` option takes
  the key's `mksec_` secret(s), and callbacks verify by `v2`. The `pk_` setup keeps working unchanged.
- This replaces "Connect with MONEI" for Medusa (user decision 2026-11-26). Medusa is configured by
  developers in env; a runtime key store, admin page, mode switch and fetch fallback cost more than
  they give. The runtime Connect work is parked on the local branch `parked/connect-runtime`
  (plan `docs/plans/20261126-connect-with-monei.md` there).

## Context (from discovery)

- `src/providers/monei/core/client.ts` `validateOptions`: `apiKey` required and trimmed; `accountId`
  (partner) sends `MONEI-Account-ID`, which a scoped key may not send (Plan C).
- `src/providers/monei/core/webhook.ts` `verifyWebhook(client, payload)`: `v1` through
  `client.verifySignature(body, signature)`; `paymentIdOf` takes a Payment body or a `charge` event
  envelope. Callers: `monei-base.ts` `getWebhookActionAndData`, `src/subscribers/monei-payment-reconcile.ts`.
- Node SDK `verifySignature(body, signature, secret?)`: with a secret only `v2` is checked.
- MONEI signs a payment callback with `v1` (the account `pk_` key) and, for a payment made with a
  scoped key, `v2` with that key's `mksec_` secret. A revoked key is deleted: later callbacks of its
  payments carry no `v2` (common `ApiKeyModel.ts` `callbackV2Secrets`). Account-webhook events are signed
  `v2` with the webhook's own `whsec_` secret and `v1` with the `pk_` key.
- The plugin calls: payments get, create, confirm, capture, cancel, refund (`payments:read`,
  `payments:create`, `payments:manage`, `payments:refund`); customers get, create, delete, list and
  delete payment methods (`customers:read`, `customers:write`); `POST /apple-pay/domains`
  (`applePayDomains:write`). cognito-service `src/apiKeyAuthorizer/restPermissions.ts`.
- Tests: `pnpm test` (plugin build + Vitest), `pnpm exec vp check`; `tests/helpers.ts` `sign`.

## Development Approach

- **testing approach**: Regular (code first, then tests in the same task)
- complete each task fully before moving to the next; every task includes its tests; all tests pass
  before the next task
- each test names the bug it catches (Rule 8)
- before the PR: `/code-review high` and a Codex review; relay findings before any merge
- implementation subagents: Codex through `delegate_task` (`gpt-6.2-sol`, `serviceTier: ultrafast`)
- never merge, release or deploy without the user

## Testing Strategy

- **unit tests**: every task
- **e2e**: unchanged (the suite runs with a `pk_test_` key). A run with a real `mk_test_` key and its
  secret is a manual check (Post-Completion).

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix

## Solution Overview

- **Options:**
  - `apiKey`: a `pk_` key (as today) or a scoped key. Startup and callback verification recognize
    the `mk_` prefix case-insensitively, with an optional `Bearer ` prefix. The SDK uses the
    trimmed key as supplied.
  - `signingSecret`: a string or an array of strings. Trim each value. A blank string counts as
    unset. An empty array, blank array entry, or prefix without a value is invalid. Each secret
    must start with `mksec_`. Scoped keys require a secret and `pk_` keys refuse one. For rotation,
    list the new secret first.
  - `accountId`: trim the string and treat a blank value as unset. Scoped keys refuse a set
    `accountId` at startup because they cannot act for another account.
  - Errors never print a key or secret value.
- **Callback verify** (`verifyWebhook(client, options, payload)`):
  - `pk_` key: `v1` with the key, as today.
  - `mk_` key: `v2` with each configured secret, in order.
  - Anything else is refused as today (`NOT_SUPPORTED`, a warning, no fetch); the body stays only a
    pointer and the payment is fetched with the key.
- **Limits of an `mk_` setup (README):**
  - account-webhook events (dashboard webhooks) cannot be verified, so a capture or cancel made in the
    MONEI dashboard does not reach Medusa; capture and cancel from the Medusa admin;
  - Before switching from `pk_` to `mk_`, wait for all open card, Bizum, PayPal, Multibanco and
    MB WAY payments to settle. Callbacks for these payments carry no `v2` and are refused after
    the switch.
  - For rotation, deploy both secrets to every instance and worker before the new key creates
    any payments. Revoke the old key and remove its secret after its payments settle and their
    callbacks have been processed.
  - If MONEI cannot read the signing secret, the callback carries no `v2` and is refused. The
    storefront return can still complete checkout. Check the MONEI dashboard for open payments.

## What Goes Where

- **Implementation Steps**: this repo.
- **Post-Completion**: manual check with a real scoped key, release, docs site, demo.

## Implementation Steps

### Task 1: Accept a scoped key and its signing secret

**Files:**

- Modify: `src/providers/monei/types.ts`, `src/providers/monei/core/client.ts`,
  `src/providers/monei/core/webhook.ts`, `src/providers/monei/core/monei-base.ts`,
  `src/subscribers/monei-payment-reconcile.ts`, `tests/client.test.ts`, `tests/webhook.test.ts`,
  `tests/subscribers.test.ts`, `tests/helpers.ts` (a `signV2` helper computed independently of the SDK)

- [x] `signingSecret` option and the startup rules of the Solution Overview in `validateOptions`
- [x] `verifyWebhook` per the Solution Overview; the provider and the reconcile subscriber pass the
      options
- [x] write `validateOptions` tests: a scoped key without `signingSecret` is refused, including
      uppercase and `Bearer ` forms. Blank options count as unset. An invalid secret or empty
      rotation list is refused, with no credentials in errors. A scoped key refuses a set
      `accountId`. A `pk_` key requires `signingSecret` to be unset.
- [x] write verify tests: an `mk_` backend and a `v2` signed with the configured secret ⇒ fetched; a
      `v2` signed with the second listed secret ⇒ fetched (rotation); a `v2` with an unknown secret ⇒
      refused, no fetch; matching `v1` with invalid `v2` on an `mk_` backend ⇒ refused, no fetch;
      a `pk_` backend keeps verifying `v1`; the reconcile subscriber accepts a valid scoped callback
- [x] run `pnpm test` and `pnpm exec vp check` — must pass before next task

### Task 2: Verify acceptance criteria

- [x] test startup validation and callback verification; the `pk_` regression rows pass unchanged
- [x] run `pnpm test` and `pnpm exec vp check`

### Task 3: Update documentation

- [x] README: a "Scoped API key" section in Configuration (create the key in the MONEI dashboard with
      the scopes of Context, set `MONEI_API_KEY=mk_…` and `signingSecret`, rotation), the `signingSecret`
      row in Options, the `mk_` limits of the Solution Overview, and the Callbacks section (`v2` for an
      `mk_` key)

## Post-Completion

- Manual check: a backend with a real `mk_test_` key and its secret pays on the hosted page, the
  callback verifies by `v2`, saved cards list, refund works.
- Release (minor) through release-it after the user's OK; docs site Medusa guide (EN and ES): the
  scoped-key setup; the demo may switch to a scoped key.
- The `medusa` broker client is removed by the Sylius session's follow-ups (user decision); the Node SDK
  `Connect` helpers PR stays open without a consumer.
