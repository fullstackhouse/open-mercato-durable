#!/bin/bash
# Creates apps/sandbox/.env from .env.example with freshly generated secrets.
#
#   ./scripts/sandbox-env.sh          # keep an existing .env
#   ./scripts/sandbox-env.sh --force  # overwrite it
#
# The template ships placeholders (JWT_SECRET=change-me-dev-secret). Those are fine for
# `yarn dev`, but the ephemeral e2e runner builds and starts the app in PRODUCTION mode,
# where core refuses to boot on a secret published in its own examples — correctly, since
# anyone who read the repo could forge tokens for it. The fix is to generate the secrets
# rather than commit them: a "real" secret checked into a repo that goes public is the same
# hazard wearing a different value.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$root/apps/sandbox/.env"
example_file="$root/apps/sandbox/.env.example"

if [[ -f "$env_file" && "${1:-}" != "--force" ]]; then
  echo "sandbox-env: $env_file already exists (pass --force to regenerate)"
  exit 0
fi

# JWT_SECRET plus any JWT_<AUDIENCE>_SECRET; core enforces >= 32 chars and a non-placeholder
# value on all of them (assertJwtSecretPolicy in @open-mercato/shared).
secret() { openssl rand -hex 32; }

cp "$example_file" "$env_file"
while IFS= read -r key; do
  python3 - "$env_file" "$key" "$(secret)" <<'PY'
import pathlib, re, sys
path, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(path)
p.write_text(re.sub(rf'^{re.escape(key)}=.*$', f'{key}={value}', p.read_text(), flags=re.M))
PY
done < <(grep -oE '^(JWT_SECRET|JWT_[A-Z0-9_]+_SECRET|AUTH_SECRET|TENANT_DATA_ENCRYPTION_FALLBACK_KEY)=' "$example_file" | tr -d '=' | sort -u)

echo "sandbox-env: wrote $env_file with generated secrets"
echo "sandbox-env: TENANT_DATA_ENCRYPTION_FALLBACK_KEY changed — any existing database was"
echo "sandbox-env: encrypted under the old one. Re-run 'yarn initialize' before 'yarn dev'." 
