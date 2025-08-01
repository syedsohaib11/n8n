#!/bin/bash

# Install pnpm manually to avoid corepack issues
curl -fsSL https://get.pnpm.io/install.sh | sh -

# Add pnpm to PATH (Render uses /opt/render/project/... as working dir)
export PATH="/root/.local/share/pnpm:$PATH"

# Install dependencies using frozen lockfile
pnpm install --frozen-lockfile

# Increase memory limit and build
NODE_OPTIONS="--max-old-space-size=4096" pnpm run build
