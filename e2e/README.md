# End-to-end tests

The suite runs a real Medusa backend and the example storefront in Docker. The backend installs the plugin from `pnpm pack` output. Playwright pays in the storefront against the real MONEI test API.

It covers the hosted page, embedded monei.js components, saved cards, express checkout, refund, void, callback completion, return and callback races, failed and cancelled payments, trace details and rendering.

MB WAY and Multibanco have unit tests only. MONEI test mode has no processor for them.

## Requirements

- Docker with Compose.
- Node.js from `.nvmrc` and pnpm.
- Outbound internet access: the tunnel, the MONEI API and the PayPal sandbox.
- Free host ports 19000 (backend), 18000 (storefront) and 13333 (visual browser).

Install the dependencies and the Playwright browser from the repository root:

```bash
pnpm install
pnpm exec playwright install chromium
```

## Credentials

Copy `e2e/.env.example` to `e2e/.env` and set:

| Variable                | Required | Description                                                                 |
| ----------------------- | -------- | --------------------------------------------------------------------------- |
| `MONEI_TEST_API_KEY`    | Yes      | Test mode API key of the MONEI account the suite pays with.                 |
| `MONEI_TEST_ACCOUNT_ID` | No       | Cross-check. The run stops when the key belongs to another account.         |

`e2e/.env` is ignored by git. On CI, the same names are repository secrets.

Before any build, `pnpm e2e:start` checks the key:

- It trims surrounding whitespace.
- It refuses a live mode key.
- It refuses a key of an account other than `MONEI_TEST_ACCOUNT_ID`, when that is set.
- It refuses an account that does not offer card, PayPal, Bizum, Apple Pay and Google Pay.

The error messages never print the key.

## Run

```bash
pnpm e2e:start   # check the key, build and pack the plugin, start the stack, seed
pnpm e2e         # run Playwright
pnpm e2e:stop    # remove every container, network and volume
```

`pnpm e2e:start` always starts from an empty database. The storefront builds when its container starts, so the first start takes several minutes.

Run one spec:

```bash
pnpm e2e specs/redirect.spec.ts
```

### Another Medusa version

`pnpm e2e:start` installs Medusa 2.22.3 from the lockfile. Set `MEDUSA_VERSION` to install another version; the backend then resolves its dependencies fresh. CI also runs the lowest supported version, AUTH project only:

```bash
MEDUSA_VERSION=2.17.0 E2E_EVENT_BUS=local pnpm e2e:start
pnpm e2e --project=auth
```

- `E2E_EVENT_BUS` is `redis` (default) or `local`. Medusa 2.17.0 needs `local`: its Redis event bus never lets the server start.
- With `local`, the specs that count Redis event bus jobs (`operations`, `redirect-callback`) give no valid result: the count is always 0. The AUTH project has none.
- `pnpm e2e:start` stops when the backend runs another `@medusajs/framework` version, and the specs expect `Medusa v<MEDUSA_VERSION>` in the MONEI trace details.

The HTML report is in `e2e/playwright-report`. Traces, screenshots and videos of failed tests are in `e2e/test-results`.

## Stack

| Service          | Host port | Notes                                                                 |
| ---------------- | --------- | --------------------------------------------------------------------- |
| `postgres`       |           | Postgres 17.                                                          |
| `redis`          |           | Redis event bus, as in production.                                    |
| `backend`        | 19000     | Medusa (`MEDUSA_VERSION`) with the packed plugin ([`backend`](backend)). |
| `storefront`     | 18000     | Example storefront ([`storefront`](storefront)).                      |
| `tunnel`         |           | cloudflared quick tunnel to the backend.                              |
| `visual-browser` | 13333     | Playwright browser server for the visual project, on the host network. |

- The host ports avoid clashes with a Medusa app on the usual ports 9000 and 8000.
- `DATABASE_URL` has `sslmode=disable`. Medusa turns on SSL for every database host except `localhost`, and this Postgres has no SSL.
- `pnpm e2e:start` writes generated files to `e2e/.generated`: the tunnel URL, the publishable key, the public MONEI account id and the seeded fixtures.

### Tunnel

MONEI sends callbacks to a public URL. The `tunnel` service opens a cloudflared quick tunnel to the backend. `pnpm e2e:start` writes its URL to `e2e/.generated/backend.env` as `MONEI_BACKEND_URL`, and the backend uses it as the plugin's `backendUrl`. The URL changes on every start.

### Storefront

The storefront is the [Medusa Next.js starter](https://github.com/medusajs/nextjs-starter-medusa) at commit `9818886`, with MONEI modules added. One build serves every spec. Cookies select the checkout UI:

| Cookie              | Values                         | Default  |
| ------------------- | ------------------------------ | -------- |
| `monei_flow`        | `hosted`, `embedded`           | `hosted` |
| `monei_card_layout` | `single`, `split`              | `single` |
| `monei_express`     | `on` shows the express buttons | off      |

No automation can approve an Apple Pay or Google Pay sheet. The express specs pass a real token to `window.__moneiExpress.submit`, the same handler the wallet calls.

## Playwright projects

The suite runs with one worker and no parallel runs: it pays with one MONEI account through one backend. The test timeout is 180 seconds.

| Project    | Specs                              | Notes                                                                                   |
| ---------- | ---------------------------------- | --------------------------------------------------------------------------------------- |
| `chromium` | all other specs                    |                                                                                         |
| `paypal`   | `paypal*.spec.ts`                  | 1 retry on CI, because the PayPal sandbox is unstable.                                  |
| `visual`   | `payment-methods-rendering.spec.ts` | Screenshot comparisons. No retries.                                                    |
| `auth`     | `*.auth.spec.ts`                   | Runs last. Recreates the backend with `capture: false` (AUTH). The teardown restores SALE. |

Without `--project`, `pnpm e2e` runs two Playwright invocations: first `chromium`, `paypal` and `visual`, then `auth`. The `auth` invocation runs also when the first one fails. Each invocation writes to its own folder in `test-results` and `playwright-report` (`main`, `auth`). Do not name `auth` together with another project in one command: Playwright does not order them. To run only the AUTH specs:

```bash
pnpm e2e --project=auth
```

## Screenshot baselines

The `visual` project connects to the browser in the `visual-browser` container (the official Playwright image). Local runs and CI render the same pixels.

- Baselines are in `specs/payment-methods-rendering.spec.ts-snapshots`, with the suffix `-linux`.
- Locally, a missing baseline is written. On CI, a missing baseline fails the run.
- To refresh the baselines, run the command below. Look at every changed PNG before you commit it.

```bash
pnpm e2e --project=visual --update-snapshots=all
```

The `visual-browser` image tag and its `playwright run-server` version must equal `@playwright/test` in the root `package.json`.

## Test data

- Test cards and test phone numbers are in the [MONEI testing documentation](https://docs.monei.com/testing/).
- The Bizum test phone number is `+34500000000`. The test processor has a 5 EUR limit: the paying Bizum specs use a 2.50 EUR cart, and the rejection spec uses a 7 EUR cart.

## CI

`.github/workflows/e2e-nightly.yml` runs the suite every night and on manual dispatch. `.github/workflows/test.yml` calls it on every pull request and push to `main`, after the unit tests. The job fails when `MONEI_TEST_API_KEY` is missing. It uploads the report and traces as the `playwright-report` artifact.
