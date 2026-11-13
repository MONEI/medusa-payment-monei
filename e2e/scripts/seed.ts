// Seeds the running backend: store data (e2e/backend/src/scripts/seed.ts), the admin user
// and the shopper accounts, then writes .generated/{fixtures.json,storefront.env}
// (publishable key and the public MONEI account id).
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { FIXTURES_FILE, GENERATED_DIR, type Fixtures } from "../utils/env.ts";
import {
  ADDRESS,
  ADMIN,
  SHOPPERS,
  adminFetch,
  compose,
  customerToken,
  medusaFetch,
} from "../utils/medusa.ts";
import { checkTestAccount } from "../utils/monei.ts";

const FIXTURES_MARKER = "E2E_FIXTURES ";

function seedStore(): Fixtures {
  const output = compose([
    "exec",
    "-T",
    "backend",
    "npx",
    "medusa",
    "exec",
    "./src/scripts/seed.ts",
  ]);
  const line = output.split("\n").find((l) => l.startsWith(FIXTURES_MARKER));
  if (!line) {
    throw new Error(`The backend seed printed no fixtures line:\n${output}`);
  }
  return JSON.parse(line.slice(FIXTURES_MARKER.length));
}

async function registerShopper(shopper: (typeof SHOPPERS)[number]) {
  const { token: registration } = await medusaFetch<{ token: string }>(
    "/auth/customer/emailpass/register",
    { body: { email: shopper.email, password: shopper.password } },
  );
  await medusaFetch("/store/customers", {
    token: registration,
    body: { email: shopper.email, first_name: shopper.first_name, last_name: ADDRESS.last_name },
  });
  const token = await customerToken(shopper);
  const { customer } = await medusaFetch<{ customer: any }>("/store/customers/me/addresses", {
    token,
    body: {
      ...ADDRESS,
      first_name: shopper.first_name,
      is_default_billing: true,
      is_default_shipping: true,
    },
  });
  // The Bizum spec relies on the plugin uppercasing a lowercase stored country.
  const billing = customer.addresses.find((a: any) => a.is_default_billing);
  if (billing?.country_code !== "es") {
    throw new Error(
      `${shopper.email}: default billing country_code is ${billing?.country_code}, expected lowercase "es"`,
    );
  }
}

const fixtures = seedStore();
// Public: monei.js card and wallet components mount with it.
const { accountId } = await checkTestAccount();
mkdirSync(GENERATED_DIR, { recursive: true });
writeFileSync(FIXTURES_FILE, `${JSON.stringify(fixtures, null, 2)}\n`);
writeFileSync(
  resolve(GENERATED_DIR, "storefront.env"),
  `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=${fixtures.publishableKey}\nNEXT_PUBLIC_MONEI_ACCOUNT_ID=${accountId}\n`,
);

compose([
  "exec",
  "-T",
  "backend",
  "npx",
  "medusa",
  "user",
  "-e",
  ADMIN.email,
  "-p",
  ADMIN.password,
]);
// Admin-driven specs (capture, refund, void) need this login.
const { user } = await adminFetch<{ user: { email: string } }>("/admin/users/me");
if (user.email !== ADMIN.email) throw new Error(`Admin login returned ${user.email}`);
for (const shopper of SHOPPERS) {
  await registerShopper(shopper);
}
process.stdout.write(`seeded: region ${fixtures.regionId}, ${SHOPPERS.length} shoppers, admin\n`);
