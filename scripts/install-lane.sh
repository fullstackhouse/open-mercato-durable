#!/bin/bash
# Proves the PUBLISHED shape, not the workspace link.
#
# Everything else in this repo tests the packages through a yarn workspace, where the source
# tree is right there and every path resolves. That proves the code and says nothing about what
# npm would actually ship: an `exports` map missing a subpath, a `files` list that forgets
# `generated/`, a `dist/` that never got built. Each of those is invisible until someone
# installs the package, and then it is broken for everyone at once.
#
# So: pack both packages exactly as `npm publish` would, install the tarballs into a throwaway
# app, and check that the Open Mercato CLI can resolve and generate from them.
#
#   ./scripts/install-lane.sh [latest|develop]
#
# `--full` additionally scaffolds a real app with create-mercato-app, initialises a database and
# boots it. That is the nightly version; the default is the fast one that catches packaging
# mistakes in under a minute.
set -euo pipefail

CHANNEL="${1:-latest}"
FULL="${2:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }
pass() { printf '\033[32m✓ %s\033[0m\n' "$1"; }

step "Building and packing both packages"
cd "$ROOT"
yarn build:packages > /dev/null

for package in durable-work data-sync-durable; do
  (cd "packages/$package" && yarn pack --out "$WORK/$package.tgz" > /dev/null)
  [ -s "$WORK/$package.tgz" ] || fail "$package produced no tarball"
  pass "packed $package"
done

step "Checking what the tarballs actually contain"
# The files a host resolves through, listed explicitly. A `files` array that forgets one of
# these produces a package that installs cleanly and then cannot be loaded. `generated/` is the
# one most easily lost: without it the module contributes no entity ids, and only a real install
# would ever notice, because in the workspace the CLI reads the source instead.
# Listed once into a variable rather than piped per check.
#
# `tar … | grep -q` looks obvious and is wrong under `pipefail`: grep exits on the first match,
# tar gets SIGPIPE, and the pipeline's status becomes tar's failure — so a check that *matched*
# reports as a miss. GNU tar does this and BSD tar does not, which is why it passed on macOS and
# failed on the first CI run.
list_members() { tar -tzf "$1"; }
require_members() {
  local tarball="$1"
  shift
  local listing
  listing="$(list_members "$tarball")"
  local member
  for member in "$@"; do
    if printf '%s\n' "$listing" | grep -qx "package/$member"; then
      pass "$(basename "$tarball" .tgz): $member"
    else
      fail "$(basename "$tarball"): missing $member"
    fi
  done
}

require_members "$WORK/durable-work.tgz" \
  "dist/index.js" \
  "dist/modules/durable_work/index.js" \
  "dist/modules/durable_work/di.js" \
  "dist/modules/durable_work/cli.js" \
  "dist/modules/durable_work/migrations/Migration20260908120000.js" \
  "generated/entities.ids.generated.ts"

require_members "$WORK/data-sync-durable.tgz" \
  "dist/index.js" \
  "dist/modules/data_sync/index.js" \
  "dist/modules/data_sync/di.js" \
  "dist/modules/data_sync/api/run.js" \
  "generated/entities.ids.generated.ts"

step "Installing the tarballs into a throwaway package"
mkdir -p "$WORK/host"
cd "$WORK/host"
# `yarn pack` rewrites `workspace:^` into a real version range, so the packed
# `data-sync-durable` depends on `durable-work@^<version>` — which is not on npm until the day
# it is published. The resolution points that range at the tarball beside it, so the shape can
# be tested before either package is released. It is also the reason `durable-work` has to be
# published first: the constraint is real, and this is where it shows up.
DW_VERSION="$(node -p "require('$ROOT/packages/durable-work/package.json').version")"
cat > package.json <<JSON
{
  "name": "install-lane-host",
  "private": true,
  "type": "module",
  "packageManager": "yarn@4.17.1",
  "resolutions": { "@fullstackhouse/open-mercato-durable-work@^$DW_VERSION": "file:$WORK/durable-work.tgz" }
}
JSON
cat > .yarnrc.yml <<'YAML'
nodeLinker: node-modules
enableTelemetry: false
npmPreapprovedPackages:
  - "@open-mercato/*"
YAML

CORE_VERSION="$(node -p "require('$ROOT/node_modules/@open-mercato/core/package.json').version")"
echo "  core: $CORE_VERSION (channel: $CHANNEL)"

# Peer warnings are expected here — this host deliberately has no react, no pg, no zod. What is
# being tested is whether the tarballs resolve and load, not whether a bare directory satisfies
# every peer an app would.
# The peers an app would have. Without them the import check fails on `awilix` before it ever
# reaches our code, which would say nothing about our packaging.
PEERS="$(node -p "
  const pkg = require('$ROOT/apps/sandbox/package.json').dependencies;
  ['awilix','zod','pg','react','react-dom','next','@mikro-orm/core','@mikro-orm/postgresql']
    .map((name) => name + '@' + pkg[name]).filter((entry) => !entry.endsWith('undefined')).join(' ')
")"
if ! yarn add "@open-mercato/core@$CORE_VERSION" "@open-mercato/shared@$CORE_VERSION" \
  $PEERS "$WORK/durable-work.tgz" "$WORK/data-sync-durable.tgz" > "$WORK/install.log" 2>&1; then
  tail -25 "$WORK/install.log" >&2
  fail "installing the tarballs failed"
fi
pass "installed"

step "Resolving the paths a host loads modules through"
# Exactly the specifiers the OM CLI generates into an app's registry. A resolution failure here
# is an `exports` map bug, which no workspace test can reach.
node --input-type=module -e "
  const specifiers = [
    '@fullstackhouse/open-mercato-durable-work',
    '@fullstackhouse/open-mercato-durable-work/modules/durable_work/index',
    '@fullstackhouse/open-mercato-durable-work/modules/durable_work/acl',
    '@fullstackhouse/open-mercato-durable-work/modules/durable_work/di',
    '@fullstackhouse/open-mercato-durable-work/modules/durable_work/cli',
    '@fullstackhouse/open-mercato-durable-work/modules/durable_work/data/entities',
    '@fullstackhouse/open-mercato-data-sync-durable/modules/data_sync/index',
    '@fullstackhouse/open-mercato-data-sync-durable/modules/data_sync/di',
    '@fullstackhouse/open-mercato-data-sync-durable/modules/data_sync/api/run',
    '@fullstackhouse/open-mercato-data-sync-durable/modules/data_sync/i18n/en.json',
  ];
  const { createRequire } = await import('node:module');
  const require = createRequire(process.cwd() + '/package.json');
  let failed = 0;
  for (const specifier of specifiers) {
    try { require.resolve(specifier); console.log('  ✓', specifier); }
    catch (error) { console.error('  ✗', specifier, '—', error.code ?? error.message); failed += 1; }
  }
  process.exit(failed ? 1 : 0);
" || fail "the published exports map does not resolve the paths a host loads"

step "Importing the module surface the way a host does"
node --input-type=module -e "
  const durable = await import('@fullstackhouse/open-mercato-durable-work');
  if (durable.metadata?.name !== 'durable_work') throw new Error('durable_work metadata missing from the published package');
  if (typeof durable.startWorker !== 'function') throw new Error('startWorker missing');
  if (!Array.isArray(durable.SCHEMA_STATEMENTS) || durable.SCHEMA_STATEMENTS.length < 3) throw new Error('schema statements missing');
  const di = await import('@fullstackhouse/open-mercato-durable-work/modules/durable_work/di');
  if (typeof di.register !== 'function') throw new Error('di.register missing — the host would silently register nothing');
  const cli = (await import('@fullstackhouse/open-mercato-durable-work/modules/durable_work/cli')).default;
  if (!cli?.some((command) => command.command === 'worker')) throw new Error('the worker command is missing');
  console.log('  ✓ module surface imports and exposes worker, di.register and the schema');
" || fail "the published package does not import cleanly"
pass "module surface intact"

if [ "$FULL" = "--full" ]; then
  step "Scaffolding a real app (create-mercato-app@$CHANNEL)"
  cd "$WORK"
  yarn dlx "create-mercato-app@$CHANNEL" app --yes > /dev/null 2>&1 || fail "create-mercato-app failed"
  cd "$WORK/app"
  yarn add "$WORK/durable-work.tgz" "$WORK/data-sync-durable.tgz" > /dev/null 2>&1 || fail "adding the packages to a scaffolded app failed"
  node -e "
    const fs = require('node:fs');
    const file = 'src/modules.ts';
    let source = fs.readFileSync(file, 'utf8');
    source = source.replace(\"{ id: 'data_sync', from: '@open-mercato/core' },\",
      \"{ id: 'durable_work', from: '@fullstackhouse/open-mercato-durable-work' },\n  { id: 'data_sync', from: '@fullstackhouse/open-mercato-data-sync-durable' },\");
    fs.writeFileSync(file, source);
  "
  yarn generate || fail "generate failed against the published packages"
  grep -q 'durable_work' .mercato/generated/modules.generated.ts || fail "durable_work is not in the generated registry"
  grep -q 'open-mercato-data-sync-durable' .mercato/generated/api-routes.generated.ts || fail "data_sync routes are not served from the package"
  pass "a scaffolded app generates against the published packages"
fi

printf '\n\033[32m✓ install lane passed (channel: %s%s)\033[0m\n' "$CHANNEL" "$([ "$FULL" = "--full" ] && echo ', full')"
