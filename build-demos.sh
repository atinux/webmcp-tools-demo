#!/usr/bin/env bash
set -e

# Change to repo root directory
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${REPO_ROOT}/demos"

echo "=========================================="
echo "   Building Sports Shop Demo   "
echo "=========================================="

BASE_HREF="${BASE_HREF:-/}"

echo -e "\n[1/1] Building sport-shop-angular with base href ${BASE_HREF}..."
(cd sport-shop-angular && npm ci && npm run build -- --base-href "${BASE_HREF}")

echo -e "\n==============================================="
echo "   ✓ SPORTS SHOP BUILD COMPLETED SUCCESSFULLY!  "
echo "==============================================="
