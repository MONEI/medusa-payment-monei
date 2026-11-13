# Vendored from https://github.com/medusajs/nextjs-starter-medusa at
# 9818886f06e493cb2249733d114d339aa216ef00 (2026-04-23). Local changes: `.github` and
# `.yarn/releases` removed, `yarnPath` dropped from `.yarnrc.yml` (corepack provides
# yarn), this Dockerfile and `.dockerignore` added.

FROM node:24-bookworm-slim

WORKDIR /app
# corepack provisions the yarn version pinned in package.json `packageManager`.
RUN corepack enable
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1

COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable

COPY . .

EXPOSE 8000
# Built at start, not at image build: the publishable key is created by the seed, and
# NEXT_PUBLIC_* values are inlined by `next build`.
CMD ["sh", "-c", "yarn build && yarn start"]
