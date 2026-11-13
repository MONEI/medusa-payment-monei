import { restoreSaleBackend } from "./auth.ts";
import { fixtures, medusaVersion, tunnelUrl } from "./env.ts";
import { waitForBackend } from "./medusa.ts";

// Fail the run at once, with the fix, when the stack is not up.
export default async function globalSetup() {
  fixtures();
  tunnelUrl();
  medusaVersion();
  await waitForBackend(10_000).catch(() => {
    throw new Error("The e2e backend is not running; start it with pnpm e2e:start");
  });
  await restoreSaleBackend();
  return restoreSaleBackend;
}
