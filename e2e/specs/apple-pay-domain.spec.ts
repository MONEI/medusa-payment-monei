// The plugin registers the storefront domain with Apple Pay; Apple then fetches this file
// from the storefront. The country middleware once redirected it to /es/.well-known/...
import { expect, test } from "@playwright/test";

test("the storefront serves the Apple Pay domain association file without a redirect", async ({
  request,
}) => {
  const response = await request.get("/.well-known/apple-developer-merchantid-domain-association", {
    maxRedirects: 0,
  });
  expect(response.status()).toBe(200);
  // The file is hex-encoded JSON: `{"pspId":...`.
  expect((await response.text()).startsWith("7B227073704964")).toBe(true);
});
