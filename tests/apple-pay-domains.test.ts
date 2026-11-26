import { Monei } from "@monei-js/node-sdk";
import MockAdapter from "axios-mock-adapter";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { clearCredentialsCache } from "../src/providers/monei/core/credentials";
import registerDomains, { storefrontDomains } from "../src/jobs/monei-apple-pay-domains";
import { API_KEY } from "./helpers";

const shared = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock("../src/providers/monei/core/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createMoneiClient: () => shared.client,
}));

const REGISTER = "https://api.monei.com/v1/apple-pay/domains";

describe("storefrontDomains", () => {
  it("keeps the public https storefront hosts of storeCors", () => {
    // Bug: registering a dev or Medusa template origin warns on every start.
    expect(
      storefrontDomains(
        "http://localhost:8000, https://docs.medusajs.com,https://shop.example.com/,https://shop.example.com,http://staging.example.com,https://127.0.0.1:8000,/vercel\\.app$/,https://es.shop.example.com",
      ),
    ).toEqual(["shop.example.com", "es.shop.example.com"]);
  });
});

describe("Apple Pay domain job", () => {
  let mock: MockAdapter;
  let logger: Record<"warn" | "info", ReturnType<typeof vi.fn>>;
  const run = (storeCors: string) =>
    registerDomains({
      resolve: (key: string) =>
        ({
          logger,
          configModule: {
            projectConfig: { http: { storeCors } },
            modules: {
              payment: {
                options: {
                  providers: [
                    { id: "monei", options: { apiKey: API_KEY, backendUrl: "https://api.test" } },
                  ],
                },
              },
            },
          },
        })[key],
    } as never);

  beforeEach(() => {
    clearCredentialsCache();
    const client = new Monei(API_KEY);
    shared.client = client;
    mock = new MockAdapter(client.client);
    logger = { warn: vi.fn(), info: vi.fn() };
  });

  it("registers each domain, and a refused one is a warning, not a failed job", async () => {
    // Bug: a domain without the association file would throw and stop the others.
    mock
      .onPost(REGISTER, { domainName: "a.example.com" })
      .reply(422, { status: 422, message: "Domain verification failed" })
      .onPost(REGISTER, { domainName: "b.example.com" })
      .reply(200, { success: true });

    await expect(run("https://a.example.com,https://b.example.com")).resolves.toBeUndefined();

    expect(mock.history.post.map((r) => JSON.parse(r.data).domainName)).toEqual([
      "a.example.com",
      "b.example.com",
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not register a.example.com"),
    );
    expect(logger.info).toHaveBeenCalledWith("MONEI Apple Pay: registered b.example.com");
  });

  it("calls MONEI for no domain when storeCors has no public https storefront", async () => {
    // Bug: CI and local stores (localhost) would call MONEI on every start.
    await run("http://localhost:8000,https://docs.medusajs.com");
    expect(mock.history.post).toHaveLength(0);
  });
});
