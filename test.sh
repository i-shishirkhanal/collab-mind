#!/bin/bash
# Runs the automated test suites. Integration tests need a throwaway Postgres and Redis:
#   TEST_DATABASE_URL=postgres://... TEST_REDIS_URL=redis://... ./test.sh
set -eo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "== backend ==";  (cd "$ROOT/backend"  && npm test)
echo "== frontend =="; (cd "$ROOT/frontend" && npm test)
echo "== ai ==";       (cd "$ROOT/ai" && python -m pytest -q)
echo "All suites passed."
