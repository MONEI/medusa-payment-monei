import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config, parse } from "dotenv";

export const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const COMPOSE_FILE = resolve(E2E_DIR, "docker-compose.yml");
export const GENERATED_DIR = resolve(E2E_DIR, ".generated");
export const FIXTURES_FILE = resolve(GENERATED_DIR, "fixtures.json");
export const BACKEND_ENV_FILE = resolve(GENERATED_DIR, "backend.env");
const MEDUSA_VERSION_FILE = resolve(GENERATED_DIR, "medusa-version");
/** The version `pnpm pack` publishes; MONEI must see it in `traceDetails.sourceVersion`. */
export const PLUGIN_VERSION: string = JSON.parse(
  readFileSync(resolve(E2E_DIR, "..", "package.json"), "utf8"),
).version;

export const STOREFRONT_URL = "http://localhost:18000";
export const BACKEND_LOCAL_URL = "http://localhost:19000";

config({ path: resolve(E2E_DIR, ".env"), quiet: true });

/**
 * A required setting. Trimmed: a secret pasted into a CI store almost always carries a
 * trailing newline, which turns a valid key into a 401 that reads like a wrong key.
 */
export function requireEnv(name: string, hint: string): string {
  const value = (process.env[name] ?? "").trim();
  if (!value) {
    throw new Error(
      `${name} is not set. ${hint}\nCopy e2e/.env.example to e2e/.env and set it there.`,
    );
  }
  return value;
}

export const moneiApiKey = () =>
  requireEnv(
    "MONEI_TEST_API_KEY",
    "It must be the test mode API key of the MONEI account the suite pays with.",
  );

/** Public tunnel URL the backend registers as MONEI `callbackUrl` base. */
export function tunnelUrl(): string {
  if (!existsSync(BACKEND_ENV_FILE)) {
    throw new Error(`${BACKEND_ENV_FILE} is missing; run pnpm e2e:start first`);
  }
  const url = parse(readFileSync(BACKEND_ENV_FILE)).MONEI_BACKEND_URL;
  if (!url) throw new Error(`MONEI_BACKEND_URL is missing from ${BACKEND_ENV_FILE}`);
  return url;
}

export type Fixtures = {
  publishableKey: string;
  regionId: string;
  salesChannelId: string;
  products: Record<string, { id: string; variantId: string }>;
  shippingOptions: Record<string, string>;
  promotionCode: string;
  /** Stock of the managed-inventory product the stock-out specs empty. */
  limitedStock: { inventoryItemId: string; locationId: string };
};

export function fixtures(): Fixtures {
  if (!existsSync(FIXTURES_FILE)) {
    throw new Error(`${FIXTURES_FILE} is missing; run pnpm e2e:start first`);
  }
  return JSON.parse(readFileSync(FIXTURES_FILE, "utf8"));
}

/**
 * The Medusa version `pnpm e2e:start` was asked for (MEDUSA_VERSION), not the one the
 * backend reports: the plugin reads the installed version, so comparing it with itself
 * would pass on a wrong install.
 */
export function medusaVersion(): string {
  if (!existsSync(MEDUSA_VERSION_FILE)) {
    throw new Error(`${MEDUSA_VERSION_FILE} is missing; run pnpm e2e:start first`);
  }
  return readFileSync(MEDUSA_VERSION_FILE, "utf8").trim();
}
