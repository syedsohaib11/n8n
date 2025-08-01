#!/bin/bash
corepack enable
corepack prepare pnpm@latest --activate
pnpm install --frozen-lockfile
pnpm run build
