import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ConfigModule, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { Monei } from "@monei-js/node-sdk";
import type { MoneiOptions } from "../types";
import { PROVIDER_ID } from "./ids";

/** A request that hangs would block the workflow; past this the "no answer" path runs. */
const REQUEST_TIMEOUT_MS = 30_000;

const DEFAULT_RELEASE_HOLDS_AFTER_MINUTES = 30;
/**
 * 7 days, about how long a card authorization lasts. Also far below 35791 minutes
 * (2^31 ms): the local event bus delays with `setTimeout`, and Node runs a longer timer
 * after 1 ms, which would release the hold while cart completion still runs.
 */
const MAX_RELEASE_HOLDS_AFTER_MINUTES = 10_080;

export function validateOptions(options: Partial<MoneiOptions> | undefined): MoneiOptions {
  const apiKey = typeof options?.apiKey === "string" ? options.apiKey.trim() : undefined;
  if (!options || !apiKey) {
    throw new Error("Required option `apiKey` is missing in the MONEI payment provider");
  }
  if (!options.backendUrl) {
    throw new Error("Required option `backendUrl` is missing in the MONEI payment provider");
  }
  let protocol: string;
  try {
    protocol = new URL(options.backendUrl).protocol;
  } catch {
    protocol = "";
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(
      `Option \`backendUrl\` must be an absolute http(s) URL, got "${options.backendUrl}"`,
    );
  }
  // An env string such as "false" would silently charge at once (SALE).
  if (options.capture !== undefined && typeof options.capture !== "boolean") {
    throw new Error(`Option \`capture\` must be a boolean, got ${JSON.stringify(options.capture)}`);
  }
  const release = options.releaseUnorderedHoldsAfterMinutes ?? DEFAULT_RELEASE_HOLDS_AFTER_MINUTES;
  // An env string such as "30" or a fraction would schedule nothing or the wrong delay.
  if (!Number.isInteger(release) || release < 0 || release > MAX_RELEASE_HOLDS_AFTER_MINUTES) {
    throw new Error(
      `Option \`releaseUnorderedHoldsAfterMinutes\` must be a whole number of minutes from 0 (off) to ${MAX_RELEASE_HOLDS_AFTER_MINUTES}, got ${JSON.stringify(options.releaseUnorderedHoldsAfterMinutes)}`,
    );
  }
  return {
    ...options,
    apiKey,
    backendUrl: options.backendUrl.replace(/\/+$/, ""),
    releaseUnorderedHoldsAfterMinutes: release,
  };
}

function toSemver(version: string | undefined): string {
  return version?.match(/^\d+\.\d+\.\d+/)?.[0] ?? "0.0.0";
}

export function buildUserAgent(versions: {
  plugin?: string;
  framework?: string;
  node?: string;
}): string {
  return `MONEI/Medusa/${toSemver(versions.plugin)} (Medusa v${toSemver(versions.framework)}; Node v${toSemver(versions.node)})`;
}

const localRequire = createRequire(__filename);

function readVersion(packageJsonPath: string): string | undefined {
  try {
    return JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
  } catch {
    return undefined;
  }
}

function pluginVersion(): string | undefined {
  try {
    return readVersion(localRequire.resolve("medusa-payment-monei/package.json"));
  } catch {
    return undefined;
  }
}

// `@medusajs/framework` has no `./package.json` in `exports`, so walk up from its entry.
function frameworkVersion(): string | undefined {
  let dir: string;
  try {
    dir = dirname(localRequire.resolve("@medusajs/framework"));
  } catch {
    return undefined;
  }
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg.name === "@medusajs/framework") return pkg.version;
    } catch {
      // no readable package.json at this level
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

let userAgent: string | undefined;

export function getUserAgent(): string {
  userAgent ??= buildUserAgent({
    plugin: pluginVersion(),
    framework: frameworkVersion(),
    node: process.versions.node,
  });
  return userAgent;
}

export function createMoneiClient(options: MoneiOptions): Monei {
  const monei = new Monei(options.apiKey, {
    accountId: options.accountId,
    userAgent: getUserAgent(),
    timeout: REQUEST_TIMEOUT_MS,
  });
  // Some MONEI error bodies (a refused API key) carry no statusCode, and the SDK
  // builds ApiException from the body alone, so copy the HTTP status into it.
  const { defaults } = monei.client;
  defaults.transformResponse = [
    ...[defaults.transformResponse ?? []].flat(),
    (data: unknown, _headers: unknown, status?: number) =>
      status !== undefined &&
      status >= 400 &&
      data !== null &&
      typeof data === "object" &&
      (data as { statusCode?: unknown }).statusCode === undefined
        ? { ...data, statusCode: status }
        : data,
  ];
  return monei;
}

type ProviderEntry = { id?: string; options?: Partial<MoneiOptions> };

/** Provider options for routes and subscribers, which cannot resolve the provider itself. */
export function getMoneiOptions(container: MedusaContainer): MoneiOptions {
  const config = container.resolve<ConfigModule>(ContainerRegistrationKeys.CONFIG_MODULE);
  const payment = config.modules?.payment;
  const providers =
    typeof payment === "object"
      ? ((payment.options as { providers?: ProviderEntry[] } | undefined)?.providers ?? [])
      : [];
  const entry = providers.find((p) => p.id === PROVIDER_ID);
  if (!entry) {
    throw new Error(
      `No payment provider with id "${PROVIDER_ID}" in medusa-config: register medusa-payment-monei/providers/monei with id "${PROVIDER_ID}"`,
    );
  }
  return validateOptions(entry.options);
}
