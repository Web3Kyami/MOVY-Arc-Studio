#!/usr/bin/env bash
# Codex Cloud installation bootstrap for MOVY. No secrets, chain writes or deployment.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

# MOVY uses Node 24 and a PostgreSQL driver; deployment has no SQLite fallback.
node_major=""
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
fi
if [[ "$node_major" != "24" ]]; then
  nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  if [[ -s "$nvm_dir/nvm.sh" ]]; then
    export NVM_DIR="$nvm_dir"
    # shellcheck source=/dev/null
    source "$NVM_DIR/nvm.sh"
    nvm install 24
    nvm use 24
  else
    echo "MOVY needs Node 24; configure Node 24 in the Codex Cloud setup, then rerun." >&2
    exit 1
  fi
fi
npm --version >/dev/null

# Repeatable, lockfile-based install. No generated .env, database or credentials.
npm ci --no-audit --no-fund
node --input-type=module -e 'await import("pg")' >/dev/null

# Foundry tests depend on the checked-in forge-std submodule reference.
if [[ -f ".gitmodules" ]]; then
  git submodule update --init --recursive -- contracts/lib/forge-std
fi

# Codex Cloud can provision additional build tools during initial environment setup.
# Reuse Foundry already installed by the environment, including ~/.foundry/bin.
export PATH="$HOME/.foundry/bin:$PATH"
if command -v forge >/dev/null 2>&1; then
  echo "Foundry ready: $(forge --version | head -n 1)"
elif command -v foundryup >/dev/null 2>&1; then
  foundryup
  echo "Foundry ready: $(forge --version | head -n 1)"
else
  echo "Foundry not installed. Ask Codex Cloud setup to install official Foundry before contract-test tasks."
fi

echo "MOVY Cloud bootstrap ready: Node $(node --version); npm $(npm --version)."
echo "PostgreSQL tests require a disposable local DATABASE_URL or CI PostgreSQL service."
echo "No secrets or on-chain commands were used."
