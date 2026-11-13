import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import MockAdapter from "axios-mock-adapter";
import { describe, expect, it, vi } from "vite-plus/test";
import MoneiBizumService from "../src/providers/monei/services/monei-bizum";
import MoneiCardService from "../src/providers/monei/services/monei-card";
import MoneiMbwayService from "../src/providers/monei/services/monei-mbway";
import MoneiMultibancoService from "../src/providers/monei/services/monei-multibanco";
import MoneiPaypalService from "../src/providers/monei/services/monei-paypal";

// `pnpm test` runs `medusa plugin:build` first, so these read the real build output.
const root = join(__dirname, "..");
const serverDir = join(root, ".medusa", "server");
const require = createRequire(__filename);

describe("plugin package", () => {
  it("resolves the provider entry through package exports with all five services", () => {
    // Bugs: an `exports` path that does not match the plugin:build layout makes
    // `resolve: "medusa-payment-monei/providers/monei"` fail in the host app; a
    // service left out of the export never registers, and a changed identifier
    // moves its provider id and callback path (`pp_<identifier>_monei`).
    const entry = require.resolve("medusa-payment-monei/providers/monei");

    expect(relative(root, entry)).toBe(
      join(".medusa", "server", "src", "providers", "monei", "index.js"),
    );
    const provider = require(entry).default;
    expect(provider.module).toBe("payment");
    expect(provider.services.map((s: { identifier: string }) => s.identifier)).toEqual([
      "monei",
      "monei-bizum",
      "monei-paypal",
      "monei-mbway",
      "monei-multibanco",
    ]);
  });

  it("ships no tests, e2e, docs or tool config", () => {
    // Bug: a tsconfig include that pulls these in compiles and publishes them.
    const files = readdirSync(serverDir, { recursive: true, encoding: "utf8" });
    const leaked = files.filter((file) => {
      const segments = file.split(sep);
      return (
        segments.some((s) => ["tests", "e2e", "docs"].includes(s)) ||
        /^(vite|commitlint)\.config\./.test(segments[0])
      );
    });

    expect(files.length).toBeGreaterThan(0);
    expect(leaked).toEqual([]);
  });
});

describe("payment method providers", () => {
  // MB WAY and Multibanco have no MONEI test processor, so these rows are their
  // only coverage. Bugs: a copied subclass that offers the wrong method; AUTH on a
  // method MONEI captures at once (Bizum, MB WAY, Multibanco); a lowercase country
  // that hides the Portugal-only methods from MONEI routing; a deferred Multibanco
  // reference treated as a failure.
  it.each([
    { Service: MoneiCardService, method: "card", transactionType: "AUTH" },
    { Service: MoneiBizumService, method: "bizum", transactionType: "SALE" },
    { Service: MoneiPaypalService, method: "paypal", transactionType: "AUTH" },
    { Service: MoneiMbwayService, method: "mbway", transactionType: "SALE" },
    { Service: MoneiMultibancoService, method: "multibanco", transactionType: "SALE" },
  ])(
    "$method sends only its method and $transactionType with capture false",
    async ({ Service, method, transactionType }) => {
      const provider = new Service(
        { logger: { warn: vi.fn(), info: vi.fn() } },
        { apiKey: "pk_test_x", backendUrl: "https://shop.test", capture: false },
      );
      const mock = new MockAdapter(provider["client_"].client);
      mock.onPost("https://api.monei.com/v1/payments").reply(200, {
        id: "pay_1",
        amount: 1999,
        currency: "EUR",
        orderId: "payses_01",
        status: "PENDING",
      });

      const result = await provider.initiatePayment({
        amount: 19.99,
        currency_code: "eur",
        data: { session_id: "payses_01" },
        context: {
          customer: {
            id: "cus_1",
            email: "ana@example.com",
            billing_address: { id: "addr_1", country_code: "pt" },
          },
        },
      });

      const sent = JSON.parse(mock.history.post[0].data);
      expect(sent.allowedPaymentMethods).toEqual([method]);
      expect(sent.transactionType).toBe(transactionType);
      expect(sent.billingDetails.address.country).toBe("PT");
      expect(result.status).toBe("pending");
    },
  );
});
