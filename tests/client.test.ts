import { asValue } from "@medusajs/framework/awilix";
import {
  ContainerRegistrationKeys,
  createMedusaContainer,
  defineConfig,
} from "@medusajs/framework/utils";
import { describe, expect, it } from "vite-plus/test";
import pkg from "../package.json";
import {
  buildUserAgent,
  createMoneiClient,
  getMoneiOptions,
  getUserAgent,
  validateOptions,
} from "../src/providers/monei/core/client";

// Literal copy of the pattern MONEI uses to parse a plugin User-Agent
// (`MONEI/<source>/<x.y.z> (<comment>)`).
// A User-Agent it rejects loses `traceDetails.source` on every charge.
const MONEI_NEW_FORMAT_REGEX =
  /^(?<prefix>MONEI)\/(?<source>[0-9A-Za-z._-]+)\/(?<version>[0-9]+(?:\.[0-9]+){0,2})\s*\((?<comment>[A-Za-z0-9\s\-_.,;:!?@#$%^*+|[\]{}~`]+)\)$/;

describe("User-Agent", () => {
  it("parses as MONEI/Medusa with a prerelease plugin version", () => {
    // Bug: `1.0.0-beta.1` copied verbatim fails MONEI's version pattern, so the
    // whole header is dropped and charges carry no trace details.
    const match = buildUserAgent({
      plugin: "1.0.0-beta.1",
      framework: "2.22.3",
      node: "24.11.0",
    }).match(MONEI_NEW_FORMAT_REGEX);

    expect(match?.groups).toMatchObject({
      source: "Medusa",
      version: "1.0.0",
      comment: "Medusa v2.22.3; Node v24.11.0",
    });
  });

  it("falls back to 0.0.0 for an unusable version", () => {
    // Bug: an unresolvable version rendered as `undefined` breaks the header.
    expect(buildUserAgent({ plugin: undefined, framework: "2.22.3", node: "24.11.0" })).toBe(
      "MONEI/Medusa/0.0.0 (Medusa v2.22.3; Node v24.11.0)",
    );
  });

  it("client sends the plugin and framework versions, the account id and a timeout", () => {
    // Bugs: `@medusajs/framework/package.json` is blocked by its `exports`, so a
    // direct resolve silently reports the 0.0.0 fallback (same risk for the
    // plugin's own package.json); without a timeout a hanging MONEI request
    // blocks the workflow and the "no answer" recovery never runs.
    const client = createMoneiClient({
      apiKey: "pk_test_x",
      accountId: "acc_1",
      backendUrl: "https://shop.test",
    });
    const headers = client.client.defaults.headers.common;

    expect(getUserAgent().startsWith(`MONEI/Medusa/${pkg.version} (`)).toBe(true);
    expect(headers["User-Agent"]).toContain("(Medusa v2.22.3; Node v");
    expect(headers["MONEI-Account-ID"]).toBe("acc_1");
    expect(client.client.defaults.timeout).toBe(30_000);
  });
});

describe("validateOptions", () => {
  it("rejects a missing apiKey", () => {
    expect(() => validateOptions({ backendUrl: "https://shop.test" })).toThrow("apiKey");
  });

  it("rejects a non-boolean capture", () => {
    // Bug: `capture: process.env.X` gives the string "false", and SALE charges at once.
    expect(() =>
      validateOptions({
        apiKey: "pk_test_x",
        backendUrl: "https://shop.test",
        capture: "false" as never,
      }),
    ).toThrow("`capture` must be a boolean");
  });

  it("trims the apiKey and rejects a blank one", () => {
    // Bug: a trailing newline from a secrets file makes MONEI refuse every call.
    expect(
      validateOptions({ apiKey: " pk_test_x\n", backendUrl: "https://shop.test" }).apiKey,
    ).toBe("pk_test_x");
    expect(() => validateOptions({ apiKey: "  ", backendUrl: "https://shop.test" })).toThrow(
      "apiKey",
    );
  });

  it("rejects a missing backendUrl", () => {
    // Bug: without it there is no callbackUrl and MONEI never notifies the store.
    expect(() => validateOptions({ apiKey: "pk_test_x" })).toThrow("backendUrl");
  });

  it("rejects a relative backendUrl", () => {
    expect(() => validateOptions({ apiKey: "pk_test_x", backendUrl: "/api" })).toThrow(
      "absolute http(s) URL",
    );
  });

  it("rejects a backendUrl without scheme", () => {
    // `localhost:9000` parses as a URL with protocol `localhost:`.
    expect(() => validateOptions({ apiKey: "pk_test_x", backendUrl: "localhost:9000" })).toThrow(
      "absolute http(s) URL",
    );
  });

  it("strips a trailing slash so the callback has no `//hooks`", () => {
    expect(
      validateOptions({ apiKey: "pk_test_x", backendUrl: "https://shop.test/medusa/" }).backendUrl,
    ).toBe("https://shop.test/medusa");
  });
});

describe("getMoneiOptions", () => {
  const containerWith = (config: ReturnType<typeof defineConfig>) => {
    const container = createMedusaContainer();
    container.register(ContainerRegistrationKeys.CONFIG_MODULE, asValue(config));
    return container;
  };

  it("finds the monei provider in a real defineConfig output", () => {
    // Bug: `defineConfig` turns the modules array into an object keyed by
    // service name; reading the array shape finds nothing.
    const config = defineConfig({
      modules: [
        {
          resolve: "@medusajs/medusa/payment",
          options: {
            providers: [
              { resolve: "other/provider", id: "other", options: {} },
              {
                resolve: "medusa-payment-monei/providers/monei",
                id: "monei",
                options: { apiKey: "pk_test_x", backendUrl: "https://shop.test/" },
              },
            ],
          },
        },
      ],
    });

    expect(getMoneiOptions(containerWith(config))).toEqual({
      apiKey: "pk_test_x",
      backendUrl: "https://shop.test",
      releaseUnorderedHoldsAfterMinutes: 30,
    });
  });

  it("throws a clear error when the provider is not registered", () => {
    expect(() => getMoneiOptions(containerWith(defineConfig()))).toThrow(
      'No payment provider with id "monei"',
    );
  });
});
