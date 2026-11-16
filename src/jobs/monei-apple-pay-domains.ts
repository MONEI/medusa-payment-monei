import type { ConfigModule, Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { callMonei } from "../providers/monei/core/errors";
import { moneiClient } from "../providers/monei/core/scope";

// Medusa's project template puts the docs site in STORE_CORS.
const IGNORED_HOSTS = new Set(["docs.medusajs.com"]);

/**
 * The storefront hosts in `storeCors` that Apple can reach: https only, no localhost,
 * IP address or pattern.
 */
export function storefrontDomains(storeCors: string | undefined): string[] {
  const hosts = (storeCors ?? "").split(",").flatMap((origin) => {
    let url: URL;
    try {
      url = new URL(origin.trim());
    } catch {
      return [];
    }
    const host = url.hostname;
    if (url.protocol !== "https:" || !host.includes(".") || IGNORED_HOSTS.has(host)) return [];
    if (host.endsWith(".localhost") || /^[\d.]+$/.test(host) || host.startsWith("[")) return [];
    return [host];
  });
  return [...new Set(hosts)];
}

/**
 * Registers the storefront domains with Apple Pay once per start (`numberOfExecutions`), so Apple Pay works in
 * embedded and express checkout without the MONEI Dashboard step. The storefront must
 * serve Apple's domain association file; a domain MONEI refuses is a warning.
 */
export default async function moneiApplePayDomains(container: MedusaContainer) {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  const { storeCors } = container.resolve<ConfigModule>(ContainerRegistrationKeys.CONFIG_MODULE)
    .projectConfig.http;
  const domains = storefrontDomains(storeCors);
  if (!domains.length) return;
  const client = moneiClient(container);
  for (const domainName of domains) {
    try {
      await callMonei("register Apple Pay domain", () =>
        client.applePayDomain.register({ domainName }),
      );
      logger.info(`MONEI Apple Pay: registered ${domainName}`);
    } catch (error) {
      logger.warn(
        `MONEI Apple Pay: could not register ${domainName}: ${(error as Error).message}. Serve /.well-known/apple-developer-merchantid-domain-association on it, or register it in the MONEI Dashboard (Settings, Payment methods, Apple Pay)`,
      );
    }
  }
}

export const config = {
  name: "monei-apple-pay-domains",
  schedule: "* * * * *",
  numberOfExecutions: 1,
};
