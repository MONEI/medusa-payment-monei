# Connect with MONEI: medusa-payment-monei

## Overview

- Today the plugin has one key: the `apiKey` provider option, usually `MONEI_API_KEY` from env
  (`src/providers/monei/core/client.ts`). Callbacks verify `v1` with that key. `src/admin` is empty.
- After this plan, a Medusa admin clicks "Connect with MONEI" (Admin Settings → MONEI, or the admin API
  for a backend that runs with Admin disabled). The merchant signs in to MONEI and consents. The
  backend then stores its own scoped `mk_` key and `mksec_` signing secret for each mode it receives,
  after one test call with the new key works.
- This ports the connect of the WooCommerce, PrestaShop and Magento plugins (MONEI/common
  `docs/plans/completed/20261112-integration-connect-plugins.md`, "the PHP plan" below) to Medusa
  idioms. Where Medusa forces a different rule, the Solution Overview says so.
- The env key keeps working. Nobody is forced to move. A connected key wins over the env key of the
  same mode (precedence below).
- **Depends on:** the shared broker task (Task 1, together with the Sylius plan), and a Node SDK
  release with the Connect helpers (Task 2).

## Decisions (with the user, 2026-11-26)

- **Storage:** a plugin module stores the credentials and the pending `state` rows in the Medusa
  database (plaintext, as the PHP plugins do). Admin API routes start, report and disconnect, and an
  Admin Settings page sits on top of them. Medusa's own standard is env provider options, and Medusa has
  no standard for a key that is written at runtime. Modules are isolated, so a provider cannot resolve
  a plugin module's service. The documented bridge is the knex connection (`__pg_connection__`), which
  Medusa registers in every module container. The provider uses it read-only, with a short cache.
- **Scope:** one credential set per Medusa backend, shared by every store and sales channel. Medusa
  configures payment providers per backend. A MONEI account per store is out of scope.
- **Callbacks:** `v2` with the current secret, or with the previous secret kept after a reconnect.
  Then `v1` with the env `pk_` key, when one is set. Anything else is dropped. No fetch fallback and no
  quota (PHP deviation: see Solution Overview).
- **Live account check with an env Live key:** the account id comes from the newest MONEI payment that
  Medusa stores, fetched with the env key.
- **Connect helpers:** in the Node SDK (`monei-node-sdk`), as a `Connect` export that mirrors PHP SDK
  `Monei\Connect`. The Node SDK already owns `verifySignature` with `v2`. One place per language mirrors
  the broker rules, and the test rows are the same.

## Context (from discovery)

- Plugin (`medusa-payment-monei` 1.2.0, Medusa 2.22.3 dev, peer `>=2.17.0 <3`, Node SDK `^3.3.0`):
  - `src/providers/monei/core/client.ts`: `validateOptions` throws without `apiKey`;
    `createMoneiClient` sends `MONEI-Account-ID` when the partner-only `accountId` option is set;
    `getMoneiOptions(container)` reads the provider entry from `configModule`.
  - `src/providers/monei/core/monei-base.ts`: `client_` is built once in the constructor (the provider
    is a singleton). `getWebhookActionAndData` calls `verifyWebhook(this.client_, payload)`, then always
    fetches the payment and uses the body only as a pointer. The provider's cradle is the payment
    module container: `logger`, `paymentSessionService`, `configModule`, `__pg_connection__`, `manager`
    (`@medusajs/modules-sdk` `load-internal.js`), and no other module's service.
  - `src/providers/monei/core/scope.ts`: `moneiClient(scope)` caches one client per config
    (`WeakMap`); used by the store routes (`confirm`, `payment-methods`, `payment-status`), the
    subscribers (`monei-payment-reconcile`, `monei-hold-release`) and the Apple Pay job.
  - `src/providers/monei/core/webhook.ts`: `verifyWebhook(client, payload)` checks `v1` with the
    client's key; `paymentIdOf` accepts a Payment body or a `charge` event envelope.
  - `src/jobs/monei-apple-pay-domains.ts`: registers the storefront domains (from `storeCors`) once
    per start.
  - Tests: Vitest through `vp test run` after `medusa plugin:build` (`pnpm test`); `tests/helpers.ts`
    (`TestProvider`, `sign`, `fakeGraph`); many tests reach `provider["client_"].client` with
    `axios-mock-adapter` or mock `createMoneiClient`.
  - e2e: Docker backend (Admin disabled, `e2e/backend/medusa-config.ts`), a cloudflared quick tunnel
    gives an `https://*.trycloudflare.com` `MEDUSA_BACKEND_URL` (`e2e/scripts/tunnel.sh`), the seed
    creates an admin user (`e2e/utils/medusa.ts` `ADMIN`, `adminRequest`, `adminFetch`).
- Medusa core facts (2.22.3):
  - `POST /hooks/payment/:provider` emits the event and answers 200 before the provider runs
    (`@medusajs/medusa` `api/hooks/payment/[provider]/route.js`). A provider throw gets the event bus
    retries (`webhook_retries`, default 3, 5 s delay). MONEI never sees a 4xx or 5xx from the provider.
  - `/admin/*` routes need an authenticated user: session cookie, bearer JWT or a secret API key.
    The session cookie is `SameSite=Lax` in production and `false` in development
    (`framework/http/express-loader.js`).
  - Plugin modules in `src/modules/*` merge into the app config (`mergePluginModules`).
- Broker (`authorization-service` `src/broker/integrations.ts`): `CLIENTS` keyed by `ApiKeyIntegration`
  (MONEI/common `src/models/ApiKeyModel.ts` `API_KEY_INTEGRATIONS`); the token route mints keys with
  common `integrationKeyScopes` (`payments:read|create|refund|manage`, `customers:write`,
  `allowedPaymentMethods:read`, `applePayDomains:write`).
- The plugin also calls `GET /v1/customers/{id}` and `GET /v1/customers/{id}/payment-methods`
  (saved cards, reconcile), which need `customers:read` (cognito-service
  `src/apiKeyAuthorizer/restPermissions.ts`). An integration key does not have it today.
- Node SDK (`monei-node-sdk` 3.6.0): handwritten `index.ts` (`Monei`, `verifySignature(body,
  signature, secret?)` with `v2`), generated `src/`. `paymentMethods.getAllowed()` calls
  `GET /allowed-payment-methods`, which has the authorizer. No Connect helpers.
- PHP SDK `lib/Connect.php` (2.16.0+): `start`, `exchange`, `canonicalRedirectUri`, `callbackProblem`,
  `CLIENTS` mirror, `moneiHost` rule, base URL `https://oauth.monei.com`, exchange timeout 35 s.

## Development Approach

- **testing approach**: Regular (code first, then tests in the same task), as the PHP plan
- complete each task fully before moving to the next; make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
- **CRITICAL: all tests must pass before starting next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- each test names the bug it catches (Rule 8). The bugs this plan must catch:
  - a callback `code` accepted without a stored `state`, or a `state` accepted twice or after 20 min;
  - a `state` stored by a request that is not an authenticated admin;
  - a forged disconnect (no admin auth, or a cross-site form post) clearing the credentials;
  - working credentials replaced by a failed, refused or unproven connect;
  - a live backend switched to test;
  - a Live connect of another MONEI account accepted;
  - a full `mk_` key or `mksec_` secret in an API answer or a log line;
  - a signed callback of the other mode settling a session;
  - a connected key sending `MONEI-Account-ID`.
- a task that names a **Gate** stops and asks the user until the gate holds; exec cannot release it
- the e2e suite needs a real `MONEI_TEST_API_KEY` in `e2e/.env`: a task that runs it asks the user first
- one branch per repo, cut from freshly pulled `main`/`master` (worktrees); open PRs, never merge,
  deploy or release without the user
- before each PR: `/code-review high` and a Codex review; verify the findings against the code and
  relay them to the user before any merge (the PHP review rounds found money bugs each time)
- implementation subagents: Codex through `delegate_task` (`gpt-6.2-sol`, `serviceTier: ultrafast`)

## Testing Strategy

- **unit tests**: every task (Vitest in the plugin and the Node SDK, Jest/Vitest as each repo uses)
- **e2e** (plugin Playwright suite, real backend through the tunnel, so `https`):
  - a start, status or disconnect request without admin auth ⇒ 401, and no `state` row / credentials
    unchanged;
  - a start or disconnect with a non-JSON body from an authenticated admin ⇒ refused, nothing changed;
  - a seeded `state` row, then a callback with a `code` and a forged `state` ⇒ error page with
    `Referrer-Policy: no-referrer`, and the seeded row stays;
  - a start from an authenticated admin ⇒ `{url}` whose host is the broker, with
    `code_challenge_method=S256` and `redirect_uri=<MEDUSA_BACKEND_URL>/monei/connect`. The suite does
    not load the broker page;
  - the existing env-key payment specs pass unchanged.
- **manual e2e**: a real connect against the dev broker, then prod in test mode (Post-Completion).

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix

## Solution Overview

- **Broker client `medusa`** (Task 1, shared with Sylius): name `Medusa`, callback
  `{path: '/monei/connect', search: /^$/}`, `maxPrefix: 2` (a backend served under a path prefix),
  `indexPhp: 0`. The plugin builds `redirect_uri` as `<backendUrl>/monei/connect`, from the same
  `backendUrl` as `callbackUrl`. `/monei/connect` is a plugin route outside `/admin`, `/store`,
  `/auth` and `/hooks`, so it needs no publishable key and no session. The `medusa` key gets
  `customers:read` in addition to the shared scopes (saved cards and reconcile need it).
- **Credentials and precedence:**
  - Table `monei_credential` (plugin module `monei_connect`): one row per mode (`live`, `test`):
    `account_id`, `api_key`, `signing_secret`, `previous_signing_secret`.
  - The env key's mode is its prefix: `pk_test_` is test, any other key is treated as live (a shop
    with an unknown prefix is never shadowed by a connected Test key).
  - The key in effect: connected Live, else env Live, else connected Test, else env Test. So a connect
    that returns only Test never moves a live backend to test, and Disconnect falls back to the env key.
  - `apiKey` becomes optional in `validateOptions`. With no key at all, every MONEI call throws
    "MONEI is not connected: connect it in Settings → MONEI or set MONEI_API_KEY", and the boot does not
    fail (the merchant needs a running backend to connect).
  - A connected key never sends `MONEI-Account-ID`. With the partner `accountId` option set, Connect is
    refused (`partner`), because a scoped key cannot act for another account.
  - One reader, `loadCredentials(knex)`, used by the provider (cradle `__pg_connection__`) and by
    routes, subscribers and the job (`req.scope` / container `__pg_connection__`). It caches the result
    per process for 30 s. The instance that writes clears its cache at once. Another instance or the
    worker may use the old key for up to 30 s. That is safe: nothing revokes the old key, and its
    callbacks verify with the previous secret.
  - Writes go through the module service (`MoneiConnectModuleService`), never through knex.
  - The client is resolved per call, `await moneiClient(scope)` / `await this.client()`, cached per key.
- **Start** `POST /admin/monei/connect` (authenticated admin, JSON body required):
  - Refuses before `Connect.start` and before any write when the request is not JSON
    (`content-type: application/json`). A cross-site form or `text/plain` post therefore never reaches
    it. That covers the development cookie (`SameSite=false`). A cross-origin JSON fetch needs a CORS
    preflight, and `adminCors` refuses the preflight.
  - Refuses with the `callbackProblem` code (or `partner`) when Connect cannot work for this backend.
  - Deletes `state` rows older than 20 min, runs `Connect.start('medusa', redirectUri)`, stores
    `state → {verifier, redirect_uri, created_at}`, and answers `{url}`. The page opens it in a new tab.
    The answer holds no secret: the verifier stays in the row.
- **Status** `GET /admin/monei/connect`: per mode `{source: "connected" | "env" | null, accountId,
  last4}`, the mode in effect, `callbackProblem` (or `partner`), the notice flag (an env `pk_` key in
  effect and Connect can work), and the result of the last connect (`ok` or an error code, from the
  `monei_connect_result` row the callback writes). Never a full key or secret.
- **Callback** `GET /monei/connect?code&state` (public):
  - Atomically consumes the `state` row (`DELETE … RETURNING` in the module service): unknown,
    missing, used or older than 20 min ⇒ error page, no exchange.
  - Without `code` ⇒ error page (with an `error` from the broker, its code). Nothing changes.
  - Every page: `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, a short text ("MONEI
    connected. You can close this tab." or the error). The admin page shows the result on its next
    load.
  - Then `Connect.exchange` and the switch.
- **Switch**, per mode returned (PHP rules, Medusa storage):
  - Live: the new `accountId` must equal the current Live account when Live has a key. The current Live
    account is the stored `account_id` when Live is connected. When Live is the env key, it is the
    `accountId` of the newest MONEI payment id in Medusa's `payment_session.data` (MONEI providers),
    fetched with the env key. With no such payment there is nothing to compare, and the switch goes on.
    A different account refuses the whole connect, Test too (`otherAccount`: "This backend uses another
    MONEI account. Disconnect first, or remove the env key.").
  - A returned Test `accountId` alone is not checked (PHP rule: the shared test-account repair).
  - One test call with the new key on a fresh client (never the cached one):
    `paymentMethods.getAllowed()`. A 2xx or 400 proves the key. A 401 or 403 ⇒ `keyRejected`. Any other
    answer or none ⇒ `temporarily_unavailable`. A mode that is not proven is dropped, and its old values
    stay.
  - Proven ⇒ that mode's row is upserted: the new key, account and secret, with
    `previous_signing_secret` = the old secret of a connected row (null when the mode was env or empty).
  - A mode not returned keeps its row. A failed exchange, or a 200 with only `errors`, changes nothing.
    Each `errors` code is shown (`cap`: revoke unused keys in the dashboard; `not_approved`: Live comes
    after approval, the backend stays on test).
  - After a switch: clear the local credentials cache, then register the storefront Apple Pay domains
    with the new key (the job's loop, extracted). An Apple Pay error keeps the switch.
- **Disconnect** `POST /admin/monei/connect/disconnect` (authenticated admin, JSON body required):
  deletes both `monei_credential` rows and every `state` row, clears the cache, and answers the dashboard
  API keys URL. The keys stay active until the merchant revokes them there. An env key is never touched.
- **Callback verify** (`verifyWebhook(credentials, payload)`, used by the provider and the reconcile
  subscriber):
  - The key in effect is connected and has a secret ⇒ `v2` with `signing_secret`, then with
    `previous_signing_secret`.
  - Else, or when `v2` fails, and an env key is set ⇒ `v1` with the env key.
  - Else ⇒ refused (`NOT_SUPPORTED`, a warning with the reason, no fetch).
  - After a signature passes: the body's `livemode` (Payment body, or the event's `object`) must equal
    the mode in effect, else refused. Without this, a signed Test callback would be fetched with the
    Live key, or the other way.
  - Then, as today: fetch the payment with the key in effect and use the body only as a pointer.
  - PHP deviation: no fetch of unverified callbacks and no quota. Medusa answers 200 before the provider
    runs, so a 503 retry is not possible. The cart of a dropped callback still completes through the
    storefront's `confirm` and `payment-status` routes. The previous secret covers in-flight payments
    across a reconnect. The env `pk_` key covers payments made before the first connect, while it is
    still set.
- **Admin page** `src/admin/routes/settings/monei/page.tsx` (`defineRouteConfig`, Settings sidebar):
  status per mode (source, account, "•••• last4"), Connect (POST start, open `url` in a new tab),
  Disconnect (confirm, POST), "Use manual keys (MONEI_API_KEY)" instead of the button when
  `callbackProblem` is set, the result of the last connect, and the notice for env `pk_` installs. The
  page has no key fields. Manual keys stay in env, so the PHP stale-tab fingerprint is not needed.

## What Goes Where

- **Implementation Steps**: `authorization-service`, `common`, `appsync-service`, `dashboards`,
  `monei-php-sdk` (Task 1, shared with Sylius); `monei-node-sdk`; `medusa-payment-monei`; `docs`.
- **Post-Completion**: releases, deploys, manual connects, demo.

## Implementation Steps

### Task 1: Shared broker task: add the `medusa` and `sylius` integration clients

One change set for both new clients, owned jointly with the Sylius plan (SyliusMoneiPlugin,
`plan/connect-with-monei`). Whichever plan runs first does it with both clients; the other plan marks it
done with the PR links.

**Gate:** stop and ask the user until the Sylius plan has fixed its callback form (path, query,
`maxPrefix`), so both clients land in one PR per repo.

**Files:**

- Modify (common): `src/models/ApiKeyModel.ts` (`API_KEY_INTEGRATIONS`),
  `src/authorization/catalogue.ts` (scopes), `src/graphql/appSync/schema.graphql` and generated
  `api.ts` (`ApiKeyIntegration`)
- Modify (appsync-service): `src/schema/apiKeys.graphql` (`ApiKeyIntegration`)
- Modify (authorization-service): `src/broker/integrations.ts` `CLIENTS` (+ `integrations.test.ts`),
  the token route's scopes
- Modify (dashboards): `apps/dashboard/src/routes/-api-settings/scoped-api-keys-table.tsx` (labels)
- Modify (monei-php-sdk): `lib/Connect.php` `CLIENTS` mirror (+ test rows)

- [ ] common: add `medusa` and `sylius` to `API_KEY_INTEGRATIONS` and the `ApiKeyIntegration` enums;
      add per-client scopes (`integrationKeyScopesOf(client)`: the shared list, plus `customers:read`
      for `medusa`)
- [ ] authorization-service: `CLIENTS.medusa` = `{name: 'Medusa', callbacks: [{path: '/monei/connect',
      search: /^$/}], maxPrefix: 2, indexPhp: 0}` and the Sylius entry; the token route mints with
      `integrationKeyScopesOf(client)`
- [ ] dashboards: the `Medusa` and `Sylius` labels of the scoped keys table
- [ ] monei-php-sdk: mirror both entries in `Connect::CLIENTS`
- [ ] write broker tests: accepted `https://api.shop.example/monei/connect` and
      `https://shop.example/a/b/monei/connect`; refused `https://shop.example/a/b/c/monei/connect`
      ⇒ `callbackDepth`, `https://shop.example/monei/connect?x=1` ⇒ `callbackPath`,
      `https://shop.example/monei/connect/` ⇒ `callbackPath`; a `medusa` token carries
      `customers:read` and a `woocommerce` token does not
- [ ] write PHP SDK tests with the same `medusa` rows
- [ ] run each repo's tests — must pass before next task

### Task 2: Connect helpers in the Node SDK (`monei-node-sdk`)

**Gate:** stop and ask the user until Task 1 has merged (the `CLIENTS` values are final).

**Files:**

- Create: `connect.ts` (+ `test/connect.test.ts`, in the repo's test layout)
- Modify: `index.ts` (export `Connect`), `README.md`

- [ ] `Connect.start(client, redirectUri, baseUrl?)` ⇒ `{url, state, verifier}`; `Connect.exchange(code,
      verifier, client, redirectUri, baseUrl?)` (form body, no `Authorization`, 35 s timeout, the PHP
      error mapping); `Connect.canonicalRedirectUri(uri)` (WHATWG `URL`, which already gives
      non-transitional punycode); `Connect.callbackProblem(client, redirectUri)` with the broker's
      order and codes and the `CLIENTS` mirror of every client
- [ ] write tests: the PHP SDK Task 1 rows (moneiHost rows, pin rows of every client, host rows,
      length 512/513, label 63/64, host 253/254, `nameLength` 300/301); the RFC 7636 appendix B
      vector; 403 ⇒ `access_denied`; a non-2xx without `error` ⇒ `temporarily_unavailable`; the exact
      form fields and no `Authorization`; a 200 with only `errors`; a truncated 200 ⇒ an error whose
      message holds no `mk_` or `mksec_` value; fresh `state` and verifier per call
- [ ] run tests — must pass before next task

### Task 3: Credentials module and key resolution (`medusa-payment-monei`)

**Gate:** stop and ask the user until the Node SDK release with Task 2 exists (bump
`@monei-js/node-sdk`).

**Files:**

- Create: `src/modules/monei-connect/index.ts`, `service.ts`, `models/credential.ts`,
  `models/connect-state.ts`, `models/connect-result.ts`, `migrations/*` (`medusa plugin:db:generate`),
  `src/providers/monei/core/credentials.ts` (+ `tests/credentials.test.ts`)
- Modify: `src/providers/monei/core/client.ts`, `scope.ts`, `monei-base.ts`, `types.ts`,
  `src/jobs/monei-apple-pay-domains.ts`, `src/subscribers/*`, `src/api/store/monei/*` (await the
  client), `package.json`, the tests that reach `client_` or mock `createMoneiClient`

- [ ] module `monei_connect` with the three models and a service; a custom `consumeState(state, now)`
      that deletes and returns the row in one statement and returns nothing for a row older than 20 min
- [ ] `loadCredentials(knex, options)` ⇒ `{mode, apiKey, accountId?, signingSecret?,
      previousSigningSecret?, source, envKey?}` with the precedence of the Solution Overview; 30 s
      per-process cache with `clearCredentialsCache()`
- [ ] `apiKey` optional in `validateOptions`; a call without any key throws the "not connected" error;
      a connected key never sends `MONEI-Account-ID`
- [ ] the provider resolves its client per call (`this.client()`); `moneiClient(scope)` becomes async
      and reads the same credentials; update every caller
- [ ] write tests: connected Live + env `pk_test_` ⇒ the connected Live key; env `pk_live_` + connected
      Test only ⇒ the env Live key (a connect never moves a live backend to test); connected Test + env
      `pk_test_` ⇒ the connected key; no rows ⇒ the env key; nothing ⇒ the "not connected" error on a
      call, and the provider constructs; a cleared cache sees a new row and an uncleared one within
      30 s does not (injected clock); a connected key with the `accountId` option sends no
      `MONEI-Account-ID` header
- [ ] write tests for `consumeState`: a second consume of one `state` returns nothing; a row of 20 min
      and 1 s returns nothing (against the real module service and a test database, if the repo's
      Vitest setup allows it, else a source test that pins the single `DELETE … RETURNING`)
- [ ] adapt the existing tests to the async client; no behaviour change in them
- [ ] run tests — must pass before next task

### Task 4: Callback verification with `v2` and the previous secret

**Files:**

- Modify: `src/providers/monei/core/webhook.ts`, `monei-base.ts` (`getWebhookActionAndData`),
  `src/subscribers/monei-payment-reconcile.ts`, `tests/webhook.test.ts`, `tests/subscribers.test.ts`,
  `tests/helpers.ts` (a `signV2` helper computed independently of the SDK)

- [ ] `verifyWebhook(credentials, payload)` per the Solution Overview: `v2` current, `v2` previous,
      `v1` env key, else refused; then the `livemode` check against the mode in effect
- [ ] the provider and the reconcile subscriber call it with the resolved credentials
- [ ] write tests: a `v2` with the current secret ⇒ the payment is fetched; a `v2` with the previous
      secret ⇒ fetched; a `v2` with an unknown secret and no env key ⇒ `NOT_SUPPORTED`, no fetch; a
      `v1` with the env key on a connected backend ⇒ fetched; a `v1` without an env key ⇒ refused; a
      signed body with `livemode: false` on a backend whose key in effect is Live ⇒ refused, no fetch;
      the same for an event envelope; the reconcile subscriber refuses what the provider refuses
- [ ] run tests — must pass before next task

### Task 5: Connect service (start, exchange, switch)

**Files:**

- Create: `src/connect/service.ts` (pure: injected store, clock, SDK and fetch), `tests/connect.test.ts`
- Modify: `src/jobs/monei-apple-pay-domains.ts` (extract `registerApplePayDomains(client, domains,
  logger)`)

- [ ] `startConnect`: refuses with `partner` or the `callbackProblem` code before `Connect.start`;
      deletes rows older than 20 min; stores the row; returns `{url}`
- [ ] `completeConnect(code, state)`: `consumeState`, `exchange`, the Live account check (stored
      account, or the newest stored MONEI payment fetched with the env key), the test call on a fresh
      client, the per-mode upsert with `previous_signing_secret`, the result row, cache clear, Apple Pay
- [ ] write tests (each names its bug): an unknown, reused or expired `state` ⇒ no exchange; a start
      deletes rows older than 20 min and keeps a younger one; a failed exchange or a 200 with only
      `errors` ⇒ credentials unchanged and the code stored as the result; a test call of 400 ⇒
      switched; 401 or 403 ⇒ `keyRejected`, no answer or 5xx or 429 ⇒ `temporarily_unavailable`, old
      values kept in both cases; Test proven and Live 401 ⇒ Test switched, Live kept; a new Live
      account that differs from the stored connected one ⇒ nothing switched, Test included; a new Live
      account that differs from the env key's newest payment ⇒ nothing switched; an env Live key with
      no stored payment ⇒ switched; only Test returned with a new Test account ⇒ switched; a reconnect
      moves the old secret to `previous_signing_secret`; an Apple Pay error keeps the switch; the
      stored result and every log line hold no full key or secret
- [ ] run tests — must pass before next task

### Task 6: Admin routes and the public callback route

**Files:**

- Create: `src/api/admin/monei/connect/route.ts` (GET status, POST start),
  `src/api/admin/monei/connect/disconnect/route.ts`, `src/api/monei/connect/route.ts` (GET callback),
  `tests/connect-routes.test.ts`
- Modify: `src/api/middlewares.ts` (JSON-only on the two POST routes)

- [ ] status, start and disconnect per the Solution Overview; the start and disconnect routes refuse a
      body that is not `application/json` before any read or write
- [ ] the callback route: `completeConnect`, the result page with `Referrer-Policy: no-referrer` and
      `Cache-Control: no-store`, no redirect
- [ ] write tests: start and disconnect with `text/plain` or a form body ⇒ refused and no `state` row
      written / no credentials deleted; status answers `last4` and never the full key or secret;
      disconnect deletes both connected rows and every `state` row and leaves the env key in effect; the
      callback without `code` or with a forged `state` ⇒ the error page with both headers and no
      exchange; the redirect URI the start sends equals `<backendUrl>/monei/connect`
- [ ] run tests — must pass before next task

### Task 7: Admin Settings page

**Files:**

- Create: `src/admin/routes/settings/monei/page.tsx`, `src/admin/tsconfig.json` (as the Medusa plugin
  template)
- Modify: `package.json` (`@medusajs/admin-sdk`, `@medusajs/ui`, `@medusajs/icons` dev and peer deps,
  as the plugin template), `tsconfig.json` if the build needs it

- [ ] the page per the Solution Overview: status, Connect (POST start with JSON, `window.open(url)`),
      Disconnect (confirm, POST with JSON), "Use manual keys" on a `callbackProblem`, the last result,
      the env `pk_` notice
- [ ] `pnpm build` builds the admin extension; the e2e backend (Admin disabled) still starts
- [ ] write a test only if the repo gains a React test setup for it; otherwise the e2e and the manual
      check in Post-Completion cover the page (no new test framework for one page)
- [ ] run tests — must pass before next task

### Task 8: e2e connect specs

**Files:**

- Create: `e2e/specs/connect.spec.ts`
- Modify: `e2e/utils/medusa.ts` (a raw request with a chosen content type), `e2e/README.md`

- [ ] write the specs of the Testing Strategy (ask the user for `MONEI_TEST_API_KEY` first): 401 without
      auth for status, start and disconnect; a non-JSON start or disconnect refused with nothing changed;
      a seeded `state` row and a forged `state` callback ⇒ error page, `Referrer-Policy: no-referrer`,
      the row stays; the start `url` carries the broker host, `code_challenge_method=S256` and the
      tunnel `redirect_uri`
- [ ] a seeded connected Test row with the real test key and its mode ⇒ a hosted-page payment completes
      (the connected path in the real backend), then the row is removed
- [ ] run the full e2e suite — must pass before next task

### Task 9: Verify acceptance criteria

- [ ] every Overview and Solution Overview rule has a test in Tasks 3-8, the env-key regression
      included
- [ ] run `pnpm test` and `pnpm e2e` (after `pnpm e2e:start`)
- [ ] build against the peer floor (`e2e/README.md` "Another Medusa version", 2.17.0): the plugin
      module merges and migrates there, or raise the peer floor and say so in the changelog

### Task 10: Update documentation

- [ ] README: "Connect with MONEI" first in Configuration (Admin page, and the admin API with a secret
      API key for a backend with Admin disabled), the key precedence, `medusa db:migrate` on upgrade,
      the callback rules, the dev broker override (`MONEI_CONNECT_BASE_URL`), and the "Use manual keys"
      cases (http backend, path deeper than 2 segments, `monei` in the host)
- [ ] `~/Work/MONEI/docs`: the Medusa guide (EN and ES) starts with "Connect with MONEI"; manual keys
      move to an "Advanced" section; a `changelog.mdx` bullet in EN and ES; PR to `master` only

## Post-Completion

- **Release order:** Task 1 PRs merged and deployed (broker with the `medusa` client in prod, switch
  on) → Node SDK release → plugin release (npm, minor: it adds a migration) → docs `master` → `prod`.
  Each merge, deploy and release waits for the user.
- **Demo (MONEI/medusa-demo, Medusa 2.23.1, Admin disabled):** connect through the admin API with a
  secret API key. A demo host under `*.monei.com` cannot connect until the separate `moneiHost`
  exemption for MONEI demo hosts ships. Until then, test a real connect on a tunnel host without
  `monei` in it.
- **Manual e2e:** against the dev broker, then prod in test mode:
  - connect, pay, and check that the callback verifies by `v2`;
  - reconnect during an open payment: its callback verifies with the previous secret;
  - an order made before the connect, with the env key still set, settles by `v1`;
  - the Admin page renders, connects in a new tab and shows "•••• last4" on reload;
  - the backend with only the env key works as before.
- **Sylius:** Task 1 is shared; link its PRs in the Sylius plan.
