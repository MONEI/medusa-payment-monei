import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*.ts": "vp check --fix",
  },
  fmt: {
    ignorePatterns: [
      ".medusa/**",
      "docs/**",
      "*.md",
      "pnpm-lock.yaml",
      "e2e/storefront/**",
      "e2e/backend/package-lock.json",
    ],
  },
  lint: {
    ignorePatterns: [
      ".medusa/**",
      "node_modules/**",
      // The starter is upstream code; only the MONEI modules are ours. A negation
      // needs every parent directory re-included.
      "e2e/storefront/**",
      "!e2e/storefront/src/",
      "!e2e/storefront/src/modules/",
      "!e2e/storefront/src/modules/checkout/",
      "!e2e/storefront/src/modules/checkout/monei/**",
      "!e2e/storefront/src/modules/products/",
      "!e2e/storefront/src/modules/products/components/",
      "!e2e/storefront/src/modules/products/components/monei-express/**",
      "!e2e/storefront/src/modules/account/",
      "!e2e/storefront/src/modules/account/components/",
      "!e2e/storefront/src/modules/account/components/saved-cards/**",
    ],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
