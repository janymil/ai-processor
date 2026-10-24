#!/bin/sh
# Kept so old habits still work. The real release flow (typecheck, tests, health gate,
# automatic rollback) lives in release.sh.
exec sh "$(dirname "$0")/release.sh" "$@"
