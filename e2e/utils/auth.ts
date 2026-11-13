import { existsSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test as base } from "@playwright/test";
import { GENERATED_DIR } from "./env.ts";
import { restartBackend } from "./medusa.ts";

// Present while the backend runs with MONEI_CAPTURE=false.
const AUTH_MARKER = resolve(GENERATED_DIR, "capture-false");

/** Put SALE back if a run (or a crashed one) left the backend in AUTH mode. */
export async function restoreSaleBackend(): Promise<void> {
  if (!existsSync(AUTH_MARKER)) return;
  await restartBackend(true);
  rmSync(AUTH_MARKER);
}

/**
 * `test` for `*.auth.spec.ts`: the backend is recreated with `capture: false` once, before
 * the first AUTH spec, so a run without AUTH specs never restarts it. The global teardown
 * restores SALE.
 */
export const test = base.extend<{}, { authBackend: void }>({
  authBackend: [
    // Playwright reads fixture dependencies from a destructured first parameter.
    // oxlint-disable-next-line no-empty-pattern
    async ({}, use) => {
      if (!existsSync(AUTH_MARKER)) {
        await restartBackend(false);
        writeFileSync(AUTH_MARKER, "");
      }
      await use();
    },
    { scope: "worker", auto: true, timeout: 240_000 },
  ],
});

export { expect } from "@playwright/test";
