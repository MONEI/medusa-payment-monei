# Connect with MONEI: medusa-payment-monei

Trello: https://trello.com/c/xaRD0Pxs

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
- The env key keeps working, also after an upgrade without `medusa db:migrate`. Nobody is forced to
  move.
- **Depends on:** the shared broker task (Task 1, together with the Sylius plan), and a Node SDK
  release with the Connect helpers (Task 2).

## Decisions (2026-11-26)

Each item says who decided it. The user confirmed every planner pick on 2026-11-26.

- **Scope (user):** one credential set per Medusa backend, shared by every store and sales channel.
  Medusa configures payment providers per backend. A MONEI account per store is out of scope.
- **Storage (planner, confirmed):** Medusa's standard is env provider options, and it has no standard
  for a key written at runtime. A connect must write the key, so a plugin module stores the
  credentials, the stored mode and the pending `state` rows in the Medusa database (plaintext, as the
  PHP plugins do). Admin API routes start, report, switch the mode and disconnect; an Admin Settings
  page sits on top of them. Modules are isolated, so a provider cannot resolve a plugin module's
  service; the documented bridge is the knex connection (`__pg_connection__`) that Medusa registers in
  every module container. The provider reads through it with a short cache; all writes go through the
  module service.
- **Mode rule (planner, confirmed; user picked "store the mode"):** with an env key, the env key sets
  the mode, and the connected key of that mode wins over it. With an env `pk_test_` key, a connected
  Live key stays unused until the merchant removes the env key and restarts. Without an env key, a
  stored mode decides; a connect never changes it, and the admin switches it (PHP parity: the PHP
  plugins never turn test mode off by themselves).
- **Callbacks (user: fetch fallback):** a callback verifies by `v2` (current secret) or `v1` (env key).
  One that does not verify is not dropped: after a format check, a session check and a quota, the
  plugin fetches the payment with its own key, as the PHP plugins do. The body was already only a
  pointer. The planner's first recommendation ("drop; the storefront completes the cart") was wrong
  for Multibanco, MB WAY and a closed tab.
- **Live account check with an env Live key (planner, confirmed):** the user first picked "read from a
  payment"; that option rested on the planner's wrong claim that no REST route returns a key's account.
  `GET /allowed-payment-methods` answers `accountId` and `livemode`, so the plan reads it there.
- **Connect helpers (planner, confirmed):** in the Node SDK (`monei-node-sdk`), as a `Connect` export
  that mirrors PHP SDK `Monei\Connect`. The Node SDK already owns `verifySignature` with `v2`.
- **`customers:read` for `medusa` (user):** saved cards and reconcile call `GET /v1/customers/{id}` and
  its payment methods. The `medusa` key gets `customers:read` through per-client scopes; the PHP
  clients keep the rule "a leaked integration key cannot read customers".

## Context (from discovery)

- Plugin (`medusa-payment-monei` 1.2.0, Medusa 2.22.3 dev, peer `>=2.17.0 <3`, Node SDK `^3.3.0`):
  - `package.json` `exports`: `./package.json`, `./providers/*`, `./*`. Medusa resolves a plugin
    module as `<plugin>/.medusa/server/src/modules/<name>` and finds plugin admin extensions only
    through a literal `exports["./admin"]` (`@medusajs/utils` `common/get-resolved-plugins.js:75,91`).
    Neither resolves with today's map.
  - `src/providers/monei/core/client.ts`: `validateOptions` throws without `apiKey`;
    `createMoneiClient` sends `MONEI-Account-ID` when the partner-only `accountId` option is set;
    `getMoneiOptions(container)` reads the provider entry from `configModule`.
  - `src/providers/monei/core/monei-base.ts`: `client_` is built once in the constructor (the provider
    is a singleton). `getWebhookActionAndData` calls `verifyWebhook(this.client_, payload)`, then always
    fetches the payment and uses the body only as a pointer. The provider's cradle is the payment
    module container: `logger`, `paymentSessionService`, `configModule`, `__pg_connection__`, `manager`
    (`@medusajs/modules-sdk` `loaders/utils/load-internal.js`), and no other module's service.
  - `src/providers/monei/core/scope.ts`: `moneiClient(scope)` caches one client per config
    (`WeakMap`); used by the store routes (`confirm`, `payment-methods`, `payment-methods/[id]`,
    `payment-status`), the subscribers (`monei-payment-reconcile`, `monei-hold-release`) and the Apple
    Pay job.
  - `src/providers/monei/core/webhook.ts`: `verifyWebhook(client, payload)` checks `v1` with the
    client's key; `paymentIdOf` accepts a Payment body or a `charge` event envelope.
  - `src/jobs/monei-apple-pay-domains.ts`: registers the storefront domains (from `storeCors`) once
    per start.
  - Tests: Vitest through `vp test run` after `medusa plugin:build` (`pnpm test`), no database in unit
    tests; `tests/helpers.ts` (`TestProvider`, `sign`, `fakeGraph`); many tests reach
    `provider["client_"].client` with `axios-mock-adapter` or mock `createMoneiClient`; fake timers in
    `tests/operations.test.ts`; `tests/module.test.ts` resolves the package exports.
  - e2e: Docker backend (Admin disabled, `e2e/backend/medusa-config.ts`, `required("MONEI_API_KEY")`),
    a cloudflared quick tunnel gives an `https://*.trycloudflare.com` `MEDUSA_BACKEND_URL`
    (`e2e/scripts/tunnel.sh`), the seed creates an admin user (`e2e/utils/medusa.ts` `ADMIN`,
    `adminRequest`), `e2e/utils/customers.ts` runs `psql` in the postgres container, the AUTH fixture
    restarts the backend with other env (`e2e/utils/auth.ts`). The nightly 2.17.0 run uses
    `E2E_EVENT_BUS=local` and only the `auth` project.
- Medusa core facts (2.22.3):
  - `POST /hooks/payment/:provider` emits the event and answers 200 before the provider runs
    (`@medusajs/medusa` `api/hooks/payment/[provider]/route.js`). A provider throw gets the Redis event
    bus retries (`webhook_retries`, default 3; the 5 s `webhook_delay` applies to the first run only, and BullMQ retries with no backoff); the local event bus does not retry. MONEI
    never sees a 4xx or 5xx from the provider.
  - `/admin/*` routes need an authenticated user: session cookie, bearer JWT or a secret API key.
    The session cookie is `SameSite=Lax` in production and `false` in development
    (`framework/http/express-loader.js`).
  - `MedusaService` generates `create`, `update`, `delete`, `softDelete`, `restore`, `list`,
    `retrieve`; an atomic consume needs a custom service method (`@InjectTransactionManager`).
  - DML ids are generated in JS (`text not null`, no DB default), so a raw `INSERT` or a psql seed must
    give an `id`. DML unique indexes are partial (`WHERE deleted_at IS NULL`) unless declared with
    `where: null` (`dml/helpers/entity-builder/build-indexes.js`), and Postgres cannot match a partial
    index from `ON CONFLICT (col)`. The plan therefore writes credentials with the generated
    `delete`/`create` inside one transaction, never with `ON CONFLICT`.
  - `medusa plugin:db:generate` connects to a real Postgres (`DATABASE_URL`).
- Broker and key creation:
  - authorization-service `src/broker/integrations.ts` `CLIENTS` keyed by `ApiKeyIntegration`;
    the consent page (`integrationOffer.ts`) shows `integrationKeyScopes`; the token route mints with
    them and invokes account-service `createIntegrationApiKey`.
  - common `src/internals/apiKey.ts` `createIntegrationApiKeyInputSchema`: `integration:
    z.enum(API_KEY_INTEGRATIONS)`, `scopes: apiKeyScopesOf(integrationKeyScopes)`. account-service
    validates every create with it, so a new client or scope needs a common release and an
    account-service deploy first.
  - cognito-service `src/apiKeyAuthorizer/restPermissions.test.ts` and `fixtures/plugin-routes.json`
    guard that each plugin's routes fit its scopes.
  - The plugin calls `GET /v1/customers/{id}` and `GET /v1/customers/{id}/payment-methods` (saved
    cards, reconcile), which need `customers:read` (cognito-service `restPermissions.ts`). An
    integration key does not have it today.
- Node SDK (`monei-node-sdk` 3.6.0): handwritten `index.ts` (`Monei`, `verifySignature(body,
  signature, secret?)`: with a secret only `v2` is checked, without one only `v1` with the instance's
  key), generated `src/`; tests in `tests/**/*.test.ts`; tsconfig `include: ["src", "index.ts",
  "tests"]`. `paymentMethods.getAllowed()` calls `GET /allowed-payment-methods` (has the authorizer)
  and returns `livemode` and an optional `accountId`.
- PHP SDK `lib/Connect.php` (2.16.0+): `start`, `exchange`, `canonicalRedirectUri`, `callbackProblem`,
  `CLIENTS` mirror, `moneiHost` rule, base URL `https://oauth.monei.com`, exchange timeout 35 s.
- Sylius plan (`SyliusMoneiPlugin`, `docs/plans/20261126-sylius-connect-with-monei.md`, Task 6) uses
  the same callback form `/monei/connect`, `maxPrefix: 2`.

## Development Approach

- **testing approach**: Regular (code first, then tests in the same task), as the PHP plan
- complete each task fully before moving to the next; make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
- **CRITICAL: all tests must pass before starting next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- each test names the bug it catches (Rule 8). The bugs this plan must catch:
  - a callback `code` accepted without a stored `state`, or a `state` accepted twice or after 20 min;
  - a `state` stored by a request that is not an authenticated admin, or by a cross-site request;
  - a forged disconnect clearing the credentials;
  - working credentials replaced by a failed, refused or unproven connect;
  - a connect or a disconnect that changes the mode of a backend (test to live, or live to test);
  - a Live connect of another MONEI account accepted;
  - a full `mk_` key or `mksec_` secret in an API answer, a page or a log line;
  - a signed callback of the other mode settling a session;
  - a real callback dropped (after a reconnect, a revoked key, or MONEI omitting `v2`);
  - an unsigned request re-running a finished session, or fetching past the quota;
  - a connected key sending `MONEI-Account-ID`;
  - a Connect button on a backend whose callback URL the broker refuses for a reason the plugin can
    check;
  - checkout broken after an upgrade without `medusa db:migrate`.
- unit tests use the repo's tools: `vi.useFakeTimers` for time, and for MONEI a mocked
  `createMoneiClient` that attaches one `MockAdapter` per created client, keyed by its `apiKey` (so a
  test can answer the old key and the new key differently, and see a fresh client). Only the store gets
  a seam (no database in unit tests). Each test file calls `clearCredentialsCache()` in `beforeEach`.
  A logger assertion about secrets serializes every argument of every call.
- database behaviour (`consumeState`, the switch, `disconnect`) and the real request parsing (the JSON
  guard) are tested in e2e against the real stack, never with a source pin or a stubbed `req.is`
- a task that names a **Gate** stops and asks the user until the gate holds; exec cannot release it
- the e2e suite needs a real `MONEI_TEST_API_KEY` in `e2e/.env`: a task that runs it asks the user first
- one branch per repo, cut from freshly pulled `main`/`master` (worktrees); open PRs, never merge,
  deploy or release without the user
- before each PR: `/code-review high` and a Codex review; verify the findings against the code and
  relay them to the user before any merge (the PHP review rounds found money bugs each time)
- implementation subagents: Codex through `delegate_task` (`gpt-6.2-sol`, `serviceTier: ultrafast`)

## Testing Strategy

- **unit tests**: every task (Vitest in the plugin and the Node SDK; each other repo's own runner)
- **e2e** (plugin Playwright suite, real backend through the tunnel, so `https`), `e2e/specs/connect.spec.ts`:
  - status, start and disconnect without admin auth ⇒ 401; no `state` row is added, and a seeded
    credential row stays (then removed);
  - start from an authenticated admin with `text/plain`, `text/plain; x=application/json`,
    `application/x-www-form-urlencoded`, `multipart/form-data` or no content type ⇒ refused, no row;
  - start from an authenticated admin with JSON `{}` (bearer, and once with a secret API key) ⇒ `{url}`
    on the configured broker base with `client_id=medusa`, `code_challenge_method=S256` and
    `redirect_uri=<MEDUSA_BACKEND_URL>/monei/connect`; psql finds the row of the URL's `state`;
  - status: `startProblem` null on the tunnel backend, and the body holds no env key value;
  - a forged `state` callback with a `code` ⇒ error page, `Referrer-Policy: no-referrer`, a seeded row
    stays; a seeded row 20 min 1 s old ⇒ `expired`, and the row is gone; one fresh row called back twice
    ⇒ the second call gets `unknownState`; 10 parallel callbacks of one row ⇒ exactly one
    `temporarily_unavailable` page (the dead broker), nine `unknownState`;
  - an authenticated disconnect on psql-seeded credential, mode and `state` rows ⇒ the credential and
    `state` rows are gone, the stored mode stays;
  - `PUT …/mode` with an env key set ⇒ refused;
  - the switch on real Postgres, through a test-only `medusa exec` script in the backend container
    (`e2e/backend/src/scripts/monei-switch.ts`) that calls the module's `switchCredentials`; every row
    deletes the `monei_*` rows in `finally`:
    - Test twice with different keys ⇒ one Test row with the second key; the stored mode is `test`;
    - then Live ⇒ a Live row, and the stored mode stays `test`;
    - then Disconnect, then Live plus Test ⇒ the stored mode is still `test`;
    - with an env `pk_live_` key, a first connect proving only Test ⇒ the stored mode is `live`;
    - `setMode("live")` while a Disconnect holds the advisory lock ⇒ it waits, re-reads, and refuses
      (no Live row);
    - Live with `liveBasis` = a connected row id while no Live row exists (a Disconnect in between) ⇒
      `temporarily_unavailable`, no row written;
    - a stored Live row of account A, then Live of B plus Test ⇒ `otherAccount`, the Live row
      unchanged, no Test row;
    - the advisory lock, deterministic: psql opens `BEGIN; SELECT pg_advisory_xact_lock(K)`, inserts a
      Live row of A and keeps the transaction open; the script starts with Live of B; the spec polls
      `pg_locks` until the script's backend waits on the advisory lock; psql commits ⇒
      the script answers `otherAccount` and one Live row of A stays (without the lock the script does
      not see A and fails on the unique index);
  - in its own file `e2e/specs/connect-key.spec.ts`: a backend restarted without `MONEI_API_KEY` and
    with a seeded connected Test row (the real `pk_test_` key) and stored mode `test` ⇒ a hosted-page
    payment whose return page is not followed still creates the order, and the backend log has the
    fallback line for its payment (no real `v2` can match a seeded secret, and there is no env key for
    `v1`). Also in that file: `PUT …/mode` `{mode: "live"}` with only a Test row ⇒ refused. A second row: a payment created through the MONEI API with no `callbackUrl` (so no real callback
    races it) for a fresh session, paid, then its body posted to `/hooks/payment/monei_monei` with a
    `v2` the spec signs with the seeded secret ⇒ the session is authorized and the backend log has the
    `v2` line for that payment id, and no fallback line (the real webhook pipeline accepts the stored
    secret);
  - the existing env-key payment specs pass unchanged.
  - Not in e2e: an upgrade without `db:migrate` (the e2e backend runs `medusa db:migrate` on every
    start); the `42P01` unit row covers it.
- The e2e backend sets `MONEI_CONNECT_BASE_URL` to a host that refuses connections, so no e2e call
  reaches a real broker. The exchange then ends in `temporarily_unavailable`, which is enough to see
  that the `state` was consumed.
- **manual e2e**: the Admin page, and a real connect against the dev broker, then prod in test mode
  (Post-Completion).

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix

## Solution Overview

- **Broker client `medusa`** (Task 1, shared with Sylius): name `Medusa`, callback
  `{path: '/monei/connect', search: /^$/}`, `maxPrefix: 2` (a backend served under a path prefix),
  `indexPhp: 0`. The `medusa` key gets `customers:read` in addition to the shared scopes, and the
  consent page lists the scopes of the client being connected.
- **Redirect URI:** `Connect.canonicalRedirectUri(<backendUrl>/monei/connect)`, from the same
  `backendUrl` as `callbackUrl`. A throw, or a `callbackProblem` code, shows "Use manual keys
  (MONEI_API_KEY)" and refuses the start. `/monei/connect` is a plugin route outside `/admin`,
  `/store`, `/auth` and `/hooks`, so it needs no publishable key and no session.
- **Broker base:** `https://oauth.monei.com`, overridden by `MONEI_CONNECT_BASE_URL` (dev broker, e2e).
- **Storage** (plugin module `monei_connect`):
  - `monei_credential`: one row per mode, unique on `mode` (`live`, `test`): `account_id`, `api_key`,
    `signing_secret`. Hard delete only.
  - `monei_setting`: one row (`id` constant): `mode` (`live` | `test`), the stored mode used when no env
    key is set.
  - `monei_connect_state`: `state` (unique), `verifier`, `redirect_uri`, `created_at`.
  - Every time rule uses the database clock (`now()`), never the app clock. DML sets `created_at` from
    the app clock (`onCreate`), so `state` rows are written by a custom method.
  - Custom service methods:
    - `createState(state, verifier, redirectUri)`: a raw `INSERT` with a generated `id`, `created_at`
      left to its `now()` default.
    - `consumeState(state)`: one `DELETE FROM monei_connect_state WHERE state = ? RETURNING verifier,
      redirect_uri, now() - created_at > interval '20 minutes' AS expired`. A `state` is single-use also
      under concurrency, an expired row is deleted too, and the caller can tell `expired` from
      `unknownState`.
    - `deleteOldStates()`: `DELETE … WHERE created_at < now() - interval '20 minutes'`.
    - `switchCredentials(results, liveBasis)`: one transaction that takes `pg_advisory_xact_lock` (a
      constant key), re-reads the stored Live row past every cache, refuses with
      `temporarily_unavailable` when that row is not the one `completeConnect` based its Live decision
      on (`liveBasis`: the connected row's id, or "none, env checked"; a Disconnect or another connect in
      between), runs the stored-Live account check, then per
      proven mode deletes the old row and creates the new one with the generated methods, and sets the
      stored mode when none is set: the env key's mode when an env key is set, else Live if Live was
      proven, else Test. It never changes a stored mode.
      Two concurrent connects therefore run one after the other.
    - `setMode(mode)`: under the same advisory lock, re-reads the rows and sets the stored mode; refuses
      a mode without a credential row.
    - `disconnect()`: under the same advisory lock, deletes both credential rows and every `state` row.
      It keeps the stored mode, so a backend set to Test stays on Test after a Disconnect and a
      reconnect that returns both modes.
- **Mode and key in effect** (the PHP rule "a connect never changes the mode"):
  - The env key's mode: `_test_` right after the key type (`pk_test_`, `mk_test_`) is test; any other
    key is live (an unknown prefix is never shadowed by a connected Test key).
  - With an env key, the mode in effect is the env key's mode. The connected row of that mode wins over
    the env key. A connected row of the other mode is stored and shown, but not used. To go live, the
    merchant removes the env `pk_test_` key and restarts.
  - Without an env key: the stored mode's connected row, else none. The first proven connect sets the
    stored mode; later connects never change it, so a backend on Test stays on Test after the account's
    approval until an admin switches it.
  - So a connect never moves a backend between modes, and Disconnect falls back to the env key of the
    same mode (or to none).
  - `apiKey` becomes optional in `validateOptions`. With no key in effect, every MONEI call throws
    "MONEI is not connected: connect it in Settings → MONEI or set MONEI_API_KEY". The boot does not
    fail (the merchant needs a running backend to connect), and the Apple Pay job logs a warning and
    returns.
  - With the partner `accountId` option set, Connect is refused (`partner`) and connected rows are
    ignored: a scoped key cannot act for another account. A connected key never sends
    `MONEI-Account-ID`.
  - One reader, `loadCredentials(knex, options)`, used by the provider (cradle `__pg_connection__`) and
    by routes, subscribers and the job (container `__pg_connection__`). It returns the key in effect,
    both stored rows and the stored mode (for status). It caches the result per process for 30 s.
  - The cache has a generation counter. `clearCredentialsCache()` bumps it, and a read publishes its
    result only when the generation did not change while it ran, so a read that started before a
    switch or Disconnect cannot put the old credentials back.
  - Every MONEI client, also the env-key client for `v1` and the fresh clients of the switch, is built
    with `createMoneiClient` (one place for the user agent, timeout and test mocks).
  - A missing `monei_*` table (pg error code `42P01`, an upgrade without `medusa db:migrate`) counts as
    no rows, with one warning per process. The env key keeps working. Any other database error throws
    and is never cached.
  - The instance that writes clears its cache at once. Another instance or the worker may use the old
    key for up to 30 s. After a connect that is safe for calls (nothing revokes the old key) and for
    callbacks (one that does not verify with the cached secret takes the fetch fallback). After a mode
    switch it is not: for up to 30 s another instance creates payments in the old mode (the switch's
    confirmation says so).
  - The client is resolved per call (`await moneiClient(scope)`, `await this.client()`), cached per key.
- **Start** `POST /admin/monei/connect` (authenticated admin):
  - Refuses before any read or write when the request is not `application/json` (`req.is()`, the
    media-type essence: `text/plain; x=application/json` is refused). `req.is()` gives `null` for an
    empty body, so callers send `{}` (the page, the README's curl, the e2e). A cross-site form or no-cors
    fetch can only send CORS-safelisted types, so it never reaches the start. That covers the
    development cookie (`SameSite=false`). A cross-origin JSON fetch needs a CORS preflight, and
    `adminCors` refuses it.
  - Refuses with `partner` or the redirect-URI problem before `Connect.start`.
  - `deleteOldStates()`, runs `Connect.start('medusa', redirectUri, base)`, `createState`, and
    answers `{url}`. The verifier stays in the row.
- **Status** `GET /admin/monei/connect`: per mode `{source: "connected" | "env" | null, accountId,
  last4}` (`accountId` only for a connected row), the mode in effect, the stored mode, and
  `startProblem` (`partner`,
  `redirectUri` when `canonicalRedirectUri` throws, a `callbackProblem` code, or null). Never a full key
  or secret.
- **Mode** `PUT /admin/monei/connect/mode` `{mode}` (authenticated admin): an HTML form cannot send PUT
  and a cross-origin PUT needs a preflight. Refused while an env key is set (the env key sets the
  mode) and for a mode without a connected row. Runs `setMode`, clears the cache.
  - A switch moves every MONEI call to the other account, as the PHP test-mode switch does: open
    payments of the old mode cannot be captured, canceled or refunded from Medusa, and their callbacks
    fail the `livemode` check, until the mode is switched back. The page's confirmation says so. Routing
    each payment by its own mode is out of scope.
  - Other instances and the worker follow within 30 s (their cache). The confirmation says so too.
- **Disconnect** `DELETE /admin/monei/connect` (authenticated admin): an HTML form cannot send DELETE,
  and a cross-origin fetch with DELETE needs a preflight, so no JSON guard is needed. It runs
  `disconnect()`, clears the cache, and answers the dashboard API keys URL. Without an env key of the
  same mode, Disconnect leaves no key: checkout, capture, cancel, refund and callbacks of existing
  orders stop until a new connect or `MONEI_API_KEY`. The page's confirmation and the README say so in
  those words. The keys stay active until
  the merchant revokes them there. An env key is never touched.
- **Revoking and removing old keys:** MONEI deletes a revoked key, and the callbacks of the payments it
  made then carry only `v1`. Those callbacks take the fetch fallback, so they still settle, but the
  fetch needs a key of the same account. The README says: after a connect of another account, keep the
  old key until its open payments settle.
- **Callback** `GET /monei/connect?code&state` (public):
  - `consumeState`: unknown, missing, used or expired ⇒ error page, no exchange.
  - With an `error` from the broker, or without `code` ⇒ error page. Nothing changes.
  - The page is `text/plain`, with `Referrer-Policy: no-referrer` and `Cache-Control: no-store`, and no
    redirect. Its text comes from a fixed table of codes; an unknown broker `error` value shows as
    "unknown error" and is never echoed. Codes: `connected` ("MONEI connected (Live, Test). You can close
    this tab."), `unknownState`, `expired`, `access_denied`, `otherAccount`, `envKeyUnchecked`,
    `envKeyNoProvider`, `keyRejected`,
    `temporarily_unavailable`, and the token `errors` codes (`cap`: revoke unused keys in the
    dashboard; `not_approved`: Live comes after approval; `blocked`, `ineligible`).
  - Then `Connect.exchange` and the switch. The callback route catches every error of the exchange and
    the switch, answers `temporarily_unavailable`, and logs only the error class and its code (pg
    `code`, HTTP status), never its message: MikroORM and knex put the SQL, with the key values, into
    the message, and Medusa's error handler would log it.
- **Switch**, per mode returned (PHP rules, Medusa storage):
  - Live: when Live has a key, the new `accountId` must equal the current Live account, else the whole
    connect is refused, Test too (`otherAccount`: "This backend uses another MONEI account. Disconnect
    first, or remove the env key.").
    - A connected Live row exists (read through the module service, past every cache): its
      `account_id`, checked again inside `switchCredentials`. The env key is not checked then (the
      connected row is the one in effect).
    - No connected Live row, env Live key: `paymentMethods.getAllowed()` with the env key on a fresh
      client, before the transaction, only when Live is returned. A 2xx with `accountId` ⇒ compare. A
      401 or 403 ⇒ refused with `envKeyUnchecked` ("MONEI refused the env key, so its account cannot be
      checked: remove MONEI_API_KEY, or fix it, and connect again"). A 401 is not proof of revocation:
      the authorizer also answers 401 while the key's account cannot access the API. A 403 comes from a
      scoped `mk_` env key outside `allowedPaymentMethods:read` (it still works for payments) or a WAF
      block. A 400 ⇒ refused with `envKeyNoProvider` ("The env key's account has no enabled payment
      method, so its account cannot be checked: remove the env key or enable a method"). A 2xx without `accountId`, a 5xx, a 429 or no answer ⇒
      `temporarily_unavailable`.
  - A returned Test `accountId` alone is not checked (PHP rule: the shared test-account repair).
  - One test call with the new key on a fresh client (never the cached one):
    `paymentMethods.getAllowed()`, after a prefix check (`mk_live_` for Live, `mk_test_` for Test, else
    `keyRejected`). A 2xx or 400 proves the key. A 2xx whose `livemode` is not the mode's slot, or
    whose `accountId` is not the returned `accountId` ⇒ `keyRejected`. A 401 or 403 ⇒
    `keyRejected`. Any other answer or none ⇒ `temporarily_unavailable`. A mode that is not proven is
    dropped, and its old values stay.
  - Proven modes go to `switchCredentials`. A mode not returned keeps its row. A failed exchange, or a
    200 with only `errors`, changes nothing.
  - After a switch: clear the local cache and send the page. Then register the storefront Apple Pay
    domains with the new key in effect (the job's loop, extracted), after the response, so a slow
    Apple Pay call never times the page out. An Apple Pay error keeps the switch.
- **Callback verify** (`verifyWebhook(credentials, payload)`, used by the provider and the reconcile
  subscriber). It returns the payment id to fetch and whether the body was verified:
  1. `v2` with the current `signing_secret` of the mode in effect (the SDK's
     `verifySignature(body, signature, secret)`), when the key in effect is connected.
  2. `v1` with the env key, when one is set: `verifySignature(body, signature)` on a `Monei` built with
     the env key, never on the connected client (its key is `mk_`).
  3. A verified body's `livemode` must be a boolean equal to the mode in effect; absent or not a
     boolean ⇒ refused. Exception: with the partner `accountId` option, the key's prefix does not give
     the merchant's mode (a `pk_test_` master key can act for a live merchant), so there is no `livemode`
     check, as today.
  4. Fetch fallback (PHP behaviour) for a payment body that did not verify. An account-webhook envelope
     that did not verify is refused with a warning (it is signed with the webhook's own `whsec_`
     secret, which the plugin does not store). Before any fetch, in this order:
     - the payment id has the MONEI id format, and the body's `orderId` is a Medusa session id
       (`payses_…`); else refused, no fetch;
     - that session exists, and its Medusa payment (if any) is not captured or canceled: the fallback
       completes an open session, or captures an authorized one that MONEI captured (AUTH captured in
       the MONEI dashboard), and an unsigned replay cannot re-run a finished payment; else refused;
     - quota, per process: at most 5 fallback fetches a minute per session and 60 a minute in all;
       spent ⇒ refused with an error log (Medusa has no retry to wait for).
     - one decision per delivery: the core webhook subscriber and the reconcile subscriber run for the
       same event in one process, at the same time. The first caller takes the quota slot and fetches;
       the second reuses that promise (an in-process memo keyed by payment id plus a hash of the raw
       body and signature header, 60 s). A failed fetch is removed from the memo at once, so a retry
       fetches again. A later delivery of the same payment (`AUTHORIZED`, then `SUCCEEDED`) has another
       body and gets its own fetch.
  5. Fetch the payment with the key in effect, once. For the fallback path: the fetched `id` and
     `orderId` must equal the body's, and the fetched `livemode` must equal the mode in effect (not
     checked with the partner `accountId` option, as in step 3); else refused. Then, as today, the fetched payment decides the action.
  - Log lines (fixed formats, the e2e matches them): `MONEI callback verified (v2|v1) payment=<id>`,
    `MONEI callback fallback fetch payment=<id>`, and one line per refusal with its reason.
  - Refusals return `NOT_SUPPORTED` with one log line. The payment id is logged only when it has the
    MONEI id format (no log injection).
  - The reconcile subscriber applies the same rules (it must not report or act on what the provider
    refuses). Known gap: an unverified callback for a paid payment whose session was deleted fails the
    "session exists" pre-check, so it is not fetched and not reported as an orphan; its log line names
    the payment id. A replaced session passes the pre-checks, so its orphan is still reported.
  - Deviations from PHP: Medusa answers 200 before the provider runs, so a refusal is never retried by
    MONEI; no forward-move table (the "captured or canceled" rule covers the replay case, and core owns
    the order state after that).
  - Known gap: a reconnect that replaces a connected Test row of account A with Test account B (Test
    accounts are not checked) strands A's open test payments: the fetch with B's key gets a 404.
  - Known gap, kept as in PHP: env `pk_test_` of account A plus a connected Test key of account B (Test
    accounts are not checked). A payment made with A before the connect fetches with B's key: 404.
- **Card account holders by mode:** Medusa reuses a customer's card account holder across modes, but a
  MONEI customer exists in one account only. `createAccountHolder` stores the mode in the holder's
  `data`. A holder of the other mode is treated as no customer (no saved cards, the card is not saved),
  and the reconcile subscriber never deletes a holder of the other mode on a 404. A holder without a
  mode (made before this release) belongs to the env key's mode.
- **Admin page** `src/admin/routes/settings/monei/page.tsx` (`defineRouteConfig`, Settings sidebar):
  status per mode (source, account, "•••• last4", which mode is in effect), Connect, Disconnect
  (confirm), a "Use Live" / "Use Test" switch when no env key is set and the other mode is connected
  (also when the stored mode has no row, so the admin can fix "no key in effect"), and
  "Use manual keys (MONEI_API_KEY)" instead of the button when the start problem is set.
  Connect opens a blank tab in the click handler (no popup blocker), POSTs the start with JSON, then sets
  the tab's location to `url`. The page has no key fields: manual keys stay in env, so the PHP stale-tab
  fingerprint is not needed.
- **Authorization:** any authenticated Medusa admin user (or secret API key) can connect and
  disconnect, as any admin user can edit payment providers in a default Medusa. Medusa RBAC policies
  (`authorize`) are not applied to these routes; a backend that uses RBAC sees this in the README.

## What Goes Where

- **Implementation Steps**: `common`, `account-service`, `authorization-service`, `appsync-service`,
  `cognito-service`, `dashboards`, `monei-php-sdk` (Task 1, shared with Sylius); `monei-node-sdk`;
  `medusa-payment-monei`; `docs`.
- **Post-Completion**: deploys, releases, manual connects, demo.

## Implementation Steps


### Task 1: Shared broker task: add the `medusa` and `sylius` integration clients

One change set for both new clients, owned jointly with the Sylius plan (SyliusMoneiPlugin
`docs/plans/20261126-sylius-connect-with-monei.md`, Task 6). This task is the full list for both. The
Sylius plan's Task 6 list is a subset today: it has no per-client scopes, no common
`internals/apiKey.ts`, and no account-service, appsync-service or cognito-service. Whichever plan runs
first does this whole task; the other marks it done with the PR links.

**Gate:** held on 2026-11-26. The Sylius session confirmed `CLIENTS.sylius = {name: 'Sylius',
callbacks: [{path: '/monei/connect', search: /^$/}], maxPrefix: 2, indexPhp: 0}`, with the shared
scopes and no `customers:read`. Sylius routes for the cognito fixture: `payments` create, get,
capture, cancel, refund; `POST /apple-pay/domains`; `GET /allowed-payment-methods`. Its Task 6 points
at this task.

➕ **Owner:** the Sylius session runs this task end to end (agreed 2026-11-26). This plan marks it done
with its PR links and the common release version.
- PRs so far: https://github.com/MONEI/monei-php-sdk/pull/38 (PHP SDK mirror + test rows; merges after
  the authorization-service PR).

**Files:**

- Modify (common): `src/models/ApiKeyModel.ts` (`API_KEY_INTEGRATIONS`),
  `src/authorization/catalogue.ts` (`integrationKeyScopesOf`), `src/internals/apiKey.ts`
  (`createIntegrationApiKeyInputSchema`: scopes per `integration`) (+ `apiKey.test.ts`),
  `src/graphql/appSync/schema.graphql` and generated `api.ts` (`ApiKeyIntegration`)
- Modify (account-service): the common bump; `src/createIntegrationApiKey/createIntegrationApiKey.test.ts`
  (it pins the zod message of the scope refusal, which a per-integration schema changes)
- Modify (appsync-service): `src/schema/apiKeys.graphql` (`ApiKeyIntegration`), the common bump
- Modify (authorization-service): `src/broker/integrations.ts` `CLIENTS` (+ `integrations.test.ts`),
  `integrationToken.ts` and `integrationOffer.ts` (scopes of the client), the common bump
- Modify (cognito-service): the common bump, `src/apiKeyAuthorizer/restPermissions.test.ts`,
  `fixtures/plugin-routes.json` (the Medusa and Sylius routes, checked against their scopes)
- Modify (dashboards): `apps/dashboard/src/routes/-api-settings/scoped-api-keys-table.tsx` (labels),
  the schema snapshot and generated `src/api/generated.ts` (`ApiKeyIntegration`; its codegen introspects
  the deployed dev AppSync, so regenerate after the appsync-service dev deploy, or from the updated
  snapshot)
- Modify (monei-php-sdk): `lib/Connect.php` `CLIENTS` mirror (+ test rows)

- [ ] common: `medusa` and `sylius` in `API_KEY_INTEGRATIONS` and the `ApiKeyIntegration` enums;
      `integrationKeyScopesOf(client)` = the shared list, plus `customers:read` for `medusa`;
      `createIntegrationApiKeyInputSchema` refuses a scope outside `integrationKeyScopesOf(integration)`
- [ ] common release (ask the user); then bump it in account-service, appsync-service and
      authorization-service
- [ ] authorization-service: `CLIENTS.medusa` = `{name: 'Medusa', callbacks: [{path: '/monei/connect',
      search: /^$/}], maxPrefix: 2, indexPhp: 0}` and the Sylius entry; the token route mints, and the
      consent page lists, `integrationKeyScopesOf(client)`
- [ ] appsync-service enum, dashboards labels, cognito-service route fixture, PHP SDK mirror
- [ ] write common tests: a `medusa` create with `customers:read` passes; a `woocommerce` create with
      `customers:read` is refused (the existing "a leaked key cannot read customers" rule stays for the
      PHP clients); an unknown `integration` is refused; account-service's pinned message updated
- [ ] write broker tests: accepted `https://api.shop.example/monei/connect` and
      `https://shop.example/a/b/monei/connect`; refused `https://shop.example/a/b/c/monei/connect`
      ⇒ `callbackDepth`, `https://shop.example/monei/connect?x=1` and
      `https://shop.example/monei/connect/` ⇒ `callbackPath`; a `medusa` token and offer carry
      `customers:read`, a `woocommerce` one does not
- [ ] write cognito-service fixture rows: every MONEI route the Medusa plugin calls (`payments` get,
      create, confirm, capture, cancel, refund; `customers` create, get, delete, payment-methods list
      and delete; `POST /apple-pay/domains`; `GET /allowed-payment-methods`) fits the `medusa` scopes
- [ ] write PHP SDK tests with the same `medusa` rows
- [ ] run each repo's tests — must pass before next task

### Task 2: Connect helpers in the Node SDK (`monei-node-sdk`)

**Gate:** stop and ask the user until the Task 1 PRs have merged (the `CLIENTS` values are final).

**Files:**

- Create: `connect.ts`, `tests/connect.test.ts`
- Modify: `index.ts` (export `Connect`), `tsconfig.json` and the coverage `include` (add
  `connect.ts`), `README.md`

- [ ] `Connect.start(client, redirectUri, baseUrl?)` ⇒ `{url, state, verifier}`; `Connect.exchange(code,
      verifier, client, redirectUri, baseUrl?)` (form body, no `Authorization`, 35 s timeout, no
      redirects followed (`maxRedirects: 0`, as the PHP SDK), the PHP error mapping); `Connect.canonicalRedirectUri(uri)` (WHATWG `URL`, which gives non-transitional
      punycode); `Connect.callbackProblem(client, redirectUri)` with the broker's order and codes and the
      `CLIENTS` mirror of every client
- [ ] write tests: the PHP SDK Task 1 rows (moneiHost rows, pin rows of every client including
      `medusa` and `sylius`, host rows, length 512/513, label 63/64, host 253/254, `nameLength`
      300/301); the RFC 7636 appendix B vector; 403 ⇒ `access_denied`; a non-2xx without `error` ⇒
      `temporarily_unavailable`; the exact form fields and no `Authorization`; a 200 with only `errors`;
      a truncated 200 ⇒ an error whose message holds no `mk_` or `mksec_` value; a 307 to another host ⇒
      `temporarily_unavailable` and the other host gets no request; fresh `state` and
      verifier per call; `https://Shop.example:443/monei/connect` ⇒ `https://shop.example/monei/connect`
- [ ] run tests — must pass before next task
- [ ] Node SDK release (ask the user; release-it)

### Task 3: Credentials module and key resolution (`medusa-payment-monei`)

Tasks 3 and 4 need only SDK 3.6.0 (`verifySignature` with a secret), not Task 1 or Task 2. When a gate
of Task 1 or 2 holds, the user may tell exec to run Tasks 3 and 4 first; the plan order stays the
default.

**Files:**

- Create: `src/modules/monei-connect/index.ts`, `service.ts`, `models/credential.ts`,
  `models/setting.ts`, `models/connect-state.ts`, `migrations/*`,
  `src/providers/monei/core/credentials.ts`, `tests/credentials.test.ts`
- Modify: `package.json` (`exports["./.medusa/server/src/modules/*"]`, `@monei-js/node-sdk` `^3.6.0`),
  `e2e/backend/package.json` and its lock (the SDK pin), `src/providers/monei/core/client.ts`,
  `scope.ts`, `monei-base.ts`, `types.ts`, `src/jobs/monei-apple-pay-domains.ts`, `src/subscribers/*`,
  `src/api/store/monei/*` (await the client), `tests/module.test.ts`, the tests that reach `client_` or
  mock `createMoneiClient`

- [x] module `monei_connect` with the three models, the unique indexes, and the custom service methods
      `createState`, `consumeState`, `deleteOldStates`, `switchCredentials`, `setMode`, `disconnect`
      (Solution Overview, Storage)
- [x] migrations with `medusa plugin:db:generate` against a local Postgres (`DATABASE_URL`; the e2e
      compose Postgres maps no host port, so start a throwaway `postgres` container for it)
- [x] the `exports` entry so a host app resolves the module; check on the peer floor 2.17.0
      (`e2e/README.md` "Another Medusa version"): the module merges and migrates and the provider
      container has `__pg_connection__`, or raise the peer floor (changelog note)
- [x] `loadCredentials(knex, options)` ⇒ `{mode, apiKey, accountId?, signingSecret?, source, envKey?,
      rows, storedMode}` with the mode rules of the Solution Overview; 30 s per-process cache;
      `clearCredentialsCache()`; `42P01` counts as no rows with one warning; other errors throw uncached
- [x] `apiKey` optional in `validateOptions`; a call without any key throws the "not connected" error;
      the `accountId` option ignores connected rows; a connected key never sends `MONEI-Account-ID`
- [x] the provider resolves its client per call (`this.client()`); `moneiClient(scope)` becomes async
      and reads the same credentials; update every caller; the Apple Pay job warns and returns with no
      key
- [x] write tests for the mode rules (each row names its bug): env `pk_test_` + connected Live and Test
      ⇒ the connected Test key (a connect moves no backend with an env key to live); env `pk_test_` +
      connected Live only ⇒ the env key; env `pk_live_` + connected Live ⇒ the connected key (the main
      migration case); env `pk_live_` + connected Test only ⇒ the env key; env `pk_abc…` + connected Test
      ⇒ the env key (unknown prefix is live); env `mk_test_…` ⇒ test; no env key + both rows + stored
      mode `test` ⇒ the connected Test key (approval plus a reconnect does not go live); no env key +
      both rows + stored mode `live` ⇒ the connected Live key; nothing ⇒ the "not connected" error on a call while the provider
      constructs
- [x] write tests for the reader: a cleared cache sees a new row; an uncleared one does not at 29 s and
      does at 30 s + 1 ms (fake timers); a read still running when `clearCredentialsCache()` runs
      does not publish its result (a deferred fake query); an error
      with `code: "42P01"` (the pg error shape) ⇒ the env key, one warning for two calls; another error
      ⇒ thrown, and the next call queries again; a connected key with the `accountId` option set ⇒ the
      env key; no `MONEI-Account-ID` header on a connected key; the Apple Pay job with an https
      `storeCors` and no key ⇒ a warning, no call
- [x] write a no-restart test (the bug: today's singleton and `WeakMap` clients keep the first key): a
      provider call and a `moneiClient(scope)` call reach key A's mock; a new row B and
      `clearCredentialsCache()`; the next provider call and the next `moneiClient(scope)` call reach B's
      mock
- [x] write a `tests/module.test.ts` row: `require.resolve` of the module path Medusa builds
      (`medusa-payment-monei/.medusa/server/src/modules/monei-connect`) succeeds after the build
- [x] adapt the existing tests to the async client; no behaviour change in them
- [x] run tests — must pass before next task

### Task 4: Callback verification and the fetch fallback

**Files:**

- Modify: `src/providers/monei/core/webhook.ts`, `monei-base.ts` (`getWebhookActionAndData`),
  `src/subscribers/monei-payment-reconcile.ts`, `src/providers/monei/services/monei-card.ts`,
  `src/providers/monei/core/ids.ts` (holder mode), `tests/webhook.test.ts`, `tests/subscribers.test.ts`,
  `tests/helpers.ts` (a `signV2` helper computed independently of the SDK; `livemode` in the callback
  fixtures)

- [ ] `verifyWebhook(credentials, payload)` per the Solution Overview: `v2`, `v1` with an env-key
      `Monei`, the `livemode` check, then the fetch fallback with its pre-checks, quota and post-fetch
      checks
- [ ] the provider and the reconcile subscriber call it with the resolved credentials
- [ ] write verify tests: `v2` with the current secret ⇒ fetched, no quota used; a header with `v1`
      (env key) and an unknown `v2` ⇒ fetched as verified; with the partner `accountId` option, a `v1`
      body with `livemode: true` on a `pk_test_` key ⇒ fetched; an unverified event envelope ⇒ a
      warning, no fetch
- [ ] write `livemode` tests for verified bodies, each for a payment body and for an event envelope:
      `false` on Live ⇒ refused; `true` on Test ⇒ refused; absent ⇒ refused; `"false"` (a string) ⇒
      refused
- [ ] rewrite the existing refusal rows that the fallback changes (`tests/webhook.test.ts` "refuses %s
      without fetching the payment", `tests/subscribers.test.ts` "does nothing for a callback with a bad
      signature"): use a MONEI-format payment id; an unknown or captured session ⇒ refused, no fetch; an
      open session ⇒ the fallback fetch
- [ ] write fallback tests (each names its bug): an unverified body of an open session ⇒ fetched and
      the action returned (the revoked-key and missing-`v2` callbacks settle); a malformed payment id, or
      an `orderId` that is not `payses_…` ⇒ refused, no fetch; an unknown session ⇒ refused, no fetch; a 6th fallback for one
      session within a minute, or a 61st in all ⇒ refused, no fetch, an error line, and one more after
      61 s ⇒ fetched (fake timers); the provider and the reconcile subscriber handling one unverified
      delivery with one slot left ⇒ one fetch, both get the payment; a first fetch that fails, then a
      retry of the same delivery ⇒ a second fetch; `AUTHORIZED` then `SUCCEEDED` bodies of one payment
      within 60 s ⇒ two fetches, and the second returns the capture action; an authorized session whose Medusa
      payment is not captured and a fetched `SUCCEEDED` ⇒ the capture action; a session whose Medusa
      payment is captured or canceled ⇒ refused, no fetch; a fetched payment whose `id` or `orderId` differs from the body's ⇒
      refused; a fetched `livemode` other than the mode ⇒ refused; a body id holding a newline ⇒ the id
      is not logged; a backend with no key at all ⇒ `NOT_SUPPORTED`, not a throw
- [ ] the reconcile subscriber refuses what the provider refuses (one wiring row)
- [ ] card holders by mode per the Solution Overview; write tests: a holder of the other mode ⇒ no
      customer on the payment and no saved cards listed; a 404 for a holder of the other mode ⇒ the
      holder stays; a holder without a mode on an env-key backend ⇒ used as today
- [ ] run tests — must pass before next task

### Task 5: Connect service (start, exchange, switch)

**Gate:** stop and ask the user until the Node SDK release of Task 2 exists (`@monei-js/node-sdk` to
that version, also in `e2e/backend/package.json` and its lock).

**Files:**

- Create: `src/connect/service.ts` (the store as a seam), `tests/connect.test.ts`
- Modify: `src/jobs/monei-apple-pay-domains.ts` (extract `registerApplePayDomains(client, domains,
  logger)`)

- [ ] `startConnect`: the canonical redirect URI; refuses with `partner` or the problem code before
      `Connect.start`; `deleteOldStates`; stores the row; returns `{url}`; reads `MONEI_CONNECT_BASE_URL`
- [ ] `completeConnect(code, state)`: `consumeState`, `exchange`, the env Live account check, the test
      calls on fresh clients, `switchCredentials`, cache clear; returns the page code and an `afterSend`
      step that registers Apple Pay
- [ ] write start tests: the URL's `state` equals the stored row's `state`, and
      `base64url(sha256(stored verifier))` equals the URL's `code_challenge`; the answer holds no
      verifier; `partner` and a `callbackProblem` refuse with no `Connect.start` call and no row; the
      redirect URI is canonical (`https://API.Shop.example:443` ⇒ `https://api.shop.example/monei/connect`);
      `MONEI_CONNECT_BASE_URL` sets the URL's base and the exchange's base
- [ ] write switch tests (each names its bug): `consumeState` returning nothing ⇒ `unknownState`, no
      exchange; `expired` ⇒ `expired`, no exchange; a failed exchange or a 200 with only `errors` ⇒ no
      `switchCredentials` call, the code returned; a test call of 400 ⇒ switched; 401 or 403 ⇒
      `keyRejected`; a 5xx, 429 or no answer ⇒ `temporarily_unavailable`, old values kept; the test call
      goes out with the new key on a fresh client (the per-key mocks answer 2xx to the old key and 401
      to the new one ⇒ `keyRejected`, nothing stored); a Test result whose `getAllowed` answers
      `livemode: true` ⇒ `keyRejected`; a result whose `getAllowed` answers another `accountId` than the
      token's ⇒ `keyRejected`; an `mk_live_` key in the Test slot ⇒ `keyRejected` with no call; Test proven and Live 401 ⇒ only Test passed to
      `switchCredentials`; only Test returned ⇒ the Live row unchanged; `switchCredentials` gets no mode change from
      `completeConnect` (the stored mode is set only inside it, when none is set)
- [ ] write account tests: env Live key whose `getAllowed` answers another `accountId` ⇒ `otherAccount`,
      nothing switched, Test included; env Live key answering 401 or 403 ⇒ `envKeyUnchecked`, 400 ⇒
      `envKeyNoProvider`, nothing switched; Test-only result with an env Live key
      ⇒ no env call, switched; the store answering `otherAccount` ⇒ that page code and no `afterSend`
      step; 5xx, or 2xx without `accountId` ⇒
      `temporarily_unavailable`, nothing switched; a connected Live row exists ⇒ no env `getAllowed`
      call; only Test returned with a new Test account ⇒ switched. (The stored-Live check inside
      `switchCredentials` is an e2e row, not a unit row: a store fake would only echo it.)
- [ ] write effect tests: after `completeConnect`, `loadCredentials` returns the new key at once; the
      `afterSend` step registers Apple Pay with the new key; an Apple Pay error keeps the switch; no
      returned code, page text or logger argument holds a full key or secret
- [ ] run tests — must pass before next task

### Task 6: Admin routes and the public callback route

**Files:**

- Create: `src/api/admin/monei/connect/route.ts` (GET status, POST start, DELETE disconnect),
  `src/api/admin/monei/connect/mode/route.ts` (PUT),
  `src/api/monei/connect/route.ts` (GET callback), `tests/connect-routes.test.ts`
- Modify: `src/api/middlewares.ts` (JSON-only on the start)

- [ ] status, start and disconnect per the Solution Overview; the callback route with the `text/plain`
      page from the code table and both headers, and the `afterSend` step after the response
- [ ] write tests (wiring only; the JSON guard's bypass forms are e2e rows): status with a connected row
      answers `last4` and holds neither `api_key` nor any secret; status with only an env key holds no key
      value; status answers `startProblem` `partner` with the option set and the `callbackProblem` code
      for an `http` `backendUrl`; disconnect calls `disconnect()` and clears the cache; `PUT …/mode` with an env key set ⇒ refused and
      no `setMode` call, without one ⇒ `setMode` and a cache clear; the callback
      without `code`, with a broker `error`, or with an unknown `state` ⇒ the error page with both
      headers and no exchange; `?error=<script>` ⇒ the page shows "unknown error" and no markup; a
      switch that throws an error whose message holds the new key ⇒ `temporarily_unavailable`, and no
      logger argument and no response body holds the key
- [ ] run tests — must pass before next task

### Task 7: Admin Settings page

**Files:**

- Create: `src/admin/routes/settings/monei/page.tsx`, `src/admin/tsconfig.json` (as the Medusa plugin
  template)
- Modify: `package.json` (`exports["./admin"]` as the plugin template; `@medusajs/admin-sdk`
  `>=2.17.0 <3` and `@medusajs/ui` with the range that matches it, as dev deps and optional peers
  (`peerDependenciesMeta`), so a host with Admin disabled installs nothing new), `tests/module.test.ts`

- [ ] the page per the Solution Overview (blank tab in the click, POST `{}` with JSON, then the tab's
      location; the mode switch; the Disconnect confirmation text when no env key backs the mode)
- [ ] `pnpm build` builds the admin extension; the e2e backend (Admin disabled) still installs and
      starts, also on the 2.17.0 floor
- [ ] write a `tests/module.test.ts` row: `medusa-payment-monei/admin` resolves to the built admin entry
      (without it Medusa silently skips the page). No React test setup for one page: the page itself is
      checked by hand (Post-Completion)
- [ ] run tests — must pass before next task

### Task 8: e2e connect specs

**Files:**

- Create: `e2e/specs/connect.spec.ts`, `e2e/specs/connect-key.spec.ts`,
  `e2e/backend/src/scripts/monei-switch.ts` (test-only `medusa exec` script)
- Modify: `e2e/utils/medusa.ts` (a raw request with a chosen content type, and a secret API key;
  `restartBackend` takes the env key), `e2e/utils/global-setup.ts` (restore after a crashed connected
  spec), `e2e/backend/medusa-config.ts` (`MONEI_API_KEY` optional; `MONEI_CONNECT_BASE_URL`),
  `e2e/docker-compose.yml` (`MONEI_API_KEY: ${E2E_MONEI_API_KEY-${MONEI_TEST_API_KEY}}` or equivalent,
  `MONEI_CONNECT_BASE_URL` to a refused port), `e2e/README.md`

- [ ] write the specs of the Testing Strategy (ask the user for `MONEI_TEST_API_KEY` first). psql seeds
      give an `id` (DML ids have no DB default)
- [ ] `connect-key.spec.ts` (its own file, so no other spec runs on its backend): seeds the connected
      Test row, restarts the backend without `MONEI_API_KEY`, pays on the hosted page, then in `finally`
      deletes the `monei_*` rows and restarts with the env key; a marker file lets global setup restore
      the backend and delete the rows after a crash; its timeout covers two restarts
- [ ] every `connect.spec.ts` row that seeds `monei_*` rows deletes them in `finally` (a leftover
      connected Test row would put a fake key in effect for every later spec)
- [ ] run the full e2e suite — must pass before next task

### Task 9: Verify acceptance criteria

- [ ] every Overview and Solution Overview rule, and every bug in Development Approach, has a test in
      Tasks 3-8, the env-key regression included
- [ ] run `pnpm test` and `pnpm e2e` (after `pnpm e2e:start`)
- [ ] run `connect.spec.ts` once on the peer floor (`MEDUSA_VERSION=2.17.0`, `E2E_EVENT_BUS=local`);
      the nightly floor run covers only the `auth` project

### Task 10: Update documentation

- [ ] README: "Connect with MONEI" first in Configuration (Admin page, and the admin API with a secret
      API key and a `{}` JSON body for a backend with Admin disabled); the mode rules; `medusa
      db:migrate` on upgrade; the callback rules (the fetch fallback and its quota; account webhooks need the env key);
      the mode switch; keep an old key of another account until its open payments settle; `MONEI_CONNECT_BASE_URL`; the
      "Use manual keys" cases (http backend, more than 2 path segments, `monei` in the host, partner
      `accountId`); any admin user can connect (no RBAC policy); a new env key of another account does
      not replace a connected key of the same mode (Disconnect first); CHANGELOG through release-it
- [ ] `~/Work/MONEI/docs`: the Medusa guide (EN and ES) starts with "Connect with MONEI"; manual keys
      move to an "Advanced" section; a `changelog.mdx` bullet in EN and ES; PR to `master` only

## Post-Completion

- **Already done in Tasks 1-2:** common release, Node SDK release.
- **Deploy and release order** (each step waits for the user): account-service and appsync-service
  deploys with the new common → authorization-service deploy (broker with `medusa`, switch on) and
  dashboards → PHP SDK release (for Sylius) → plugin release (npm, minor: a migration) → docs `master`
  → `prod`. A plugin release waits for the broker in prod.
- **Demo (MONEI/medusa-demo, Medusa 2.23.1, Admin disabled):** connect through the admin API with a
  secret API key. A demo host under `*.monei.com` cannot connect until the separate `moneiHost`
  exemption for MONEI demo hosts ships. Until then, test a real connect on a tunnel host without
  `monei` in it.
- **Manual e2e:** against the dev broker, then prod in test mode:
  - the Admin page renders in Settings, Connect opens the broker in a new tab, and the page shows
    "•••• last4" on reload;
  - connect, pay, and check that the callback verifies by `v2`;
  - reconnect during an open payment: its callback settles (verified or through the fallback);
  - an order made before the connect, with the env key still set, settles by `v1`;
  - the backend with only the env key works as before.
- **Sylius:** link the Task 1 PRs in both plans. The Sylius plan gates on a PHP SDK release; cut it
  right after Task 1 merges if Sylius is waiting. If the PHP SDK gets the `*.monei.com` demo exemption
  (separate change), the Node SDK `moneiHost` rows must match it in the same release cycle.
- Not covered (known):
  - a Disconnect while a callback's exchange is still running can store the new key after the
    Disconnect (the admin sees it on reload and disconnects again);
  - env `pk_test_` of account A plus a connected Test key of account B strands A's open test payments
    (Solution Overview, Callback verify).
