FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=development

# Medusa version under test (e2e/scripts/start.sh passes MEDUSA_VERSION). The lockfile pins
# the default version only; another version installs the three @medusajs packages at that
# version and resolves the rest of the tree fresh.
ARG MEDUSA_VERSION=2.22.3
# Event bus the backend uses (medusa-config.ts). Baked into the image, so the AUTH fixture's
# backend recreate keeps it. "local" exists for 2.17.0, whose Redis event bus awaits the
# BullMQ worker's run() at startup and, in the default worker mode, never serves HTTP
# (fixed in 2.17.1).
ARG E2E_EVENT_BUS=redis
ENV E2E_EVENT_BUS=$E2E_EVENT_BUS

# Locked dependencies first, so a new plugin tarball does not reinstall Medusa.
COPY package.json package-lock.json ./
RUN if [ "$MEDUSA_VERSION" = "$(node -p 'require("./package.json").dependencies["@medusajs/framework"]')" ]; then \
      npm ci --ignore-scripts --no-audit --no-fund; \
    else \
      npm pkg set "dependencies.@medusajs/cli=$MEDUSA_VERSION" \
        "dependencies.@medusajs/framework=$MEDUSA_VERSION" \
        "dependencies.@medusajs/medusa=$MEDUSA_VERSION" \
      && rm package-lock.json \
      && npm install --ignore-scripts --no-audit --no-fund; \
    fi

# The plugin under test, packed by e2e/scripts/start.sh. --no-save keeps the lockfile
# free of a tarball whose integrity changes on every pack. No peer override: the install
# fails, as a store's would, when the Medusa version is outside the plugin's peer range.
COPY plugin/medusa-payment-monei.tgz /tmp/medusa-payment-monei.tgz
RUN npm install --no-save --ignore-scripts --no-audit --no-fund /tmp/medusa-payment-monei.tgz

COPY tsconfig.json medusa-config.ts ./
COPY src ./src

EXPOSE 9000
CMD ["npm", "run", "start"]
