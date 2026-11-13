import { defineConfig, loadEnv } from "@medusajs/framework/utils";

loadEnv(process.env.NODE_ENV || "development", process.cwd());

function required(name: string): string {
  // A secret pasted into a CI store usually carries a trailing newline.
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set; start the stack with pnpm e2e:start`);
  }
  return value;
}

// The AUTH project restarts the backend with MONEI_CAPTURE=false. Any other value is
// a broken harness, not a reason to fall back to SALE.
function capture(): boolean {
  const value = process.env.MONEI_CAPTURE ?? "true";
  if (value !== "true" && value !== "false") {
    throw new Error(`MONEI_CAPTURE must be "true" or "false", got "${value}"`);
  }
  return value === "true";
}

// The stock-out specs wait for the release; 1 minute is the smallest delay.
function releaseAfterMinutes(): number {
  const value = Number(required("MONEI_RELEASE_HOLDS_AFTER_MINUTES"));
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`MONEI_RELEASE_HOLDS_AFTER_MINUTES must be a whole number, got "${value}"`);
  }
  return value;
}

// Set by the Dockerfile; see E2E_EVENT_BUS there.
function eventBusModules() {
  const value = process.env.E2E_EVENT_BUS ?? "redis";
  if (value === "local") return [];
  if (value !== "redis") {
    throw new Error(`E2E_EVENT_BUS must be "redis" or "local", got "${value}"`);
  }
  return [{ resolve: "@medusajs/medusa/event-bus-redis", options: { redisUrl } }];
}

const redisUrl = required("REDIS_URL");
const cors = required("E2E_CORS");

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: required("DATABASE_URL"),
    redisUrl,
    http: {
      storeCors: cors,
      adminCors: cors,
      authCors: cors,
      jwtSecret: "e2e-jwt-secret",
      cookieSecret: "e2e-cookie-secret",
    },
  },
  admin: { disable: true },
  plugins: ["medusa-payment-monei"],
  modules: [
    ...eventBusModules(),
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "medusa-payment-monei/providers/monei",
            id: "monei",
            options: {
              apiKey: required("MONEI_API_KEY"),
              backendUrl: required("MONEI_BACKEND_URL"),
              capture: capture(),
              releaseUnorderedHoldsAfterMinutes: releaseAfterMinutes(),
            },
          },
        ],
      },
    },
  ],
});
