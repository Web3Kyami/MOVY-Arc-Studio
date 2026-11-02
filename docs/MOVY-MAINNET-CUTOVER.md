# MOVY Mainnet release procedure

**Status: current-source AutoSaver deployed; isolated Mainnet build verified; financial pilot pending.**
The connected app, API, observer, worker, relayer, transaction links, and database
are now selected per deployment. A process can serve exactly one Arc network;
database/schema bindings and API chain checks fail closed across networks.
Mainnet transaction processing is disabled. The verified deployment manifest is
`config/networks/arc-mainnet.json`. No Mainnet application savings transaction
has been verified.

## Mainnet source and live-read status

As of **2026-10-15 00:55 UTC**, Circle's current Arc reference values are
corroborated in Circle's maintained Arc integration guide at the pinned
[Circle skills commit](https://github.com/circlefin/skills/blob/04cbd18fdf7e2e459452f2a94594fb5c526d9908/plugins/circle/skills/use-arc/SKILL.md):
Mainnet chain ID `5042` (`0x13B2`), `https://rpc.mainnet.arc.io`,
`https://explorer.arc.io`, and USDC interface
`0x3600000000000000000000000000000000000000`. It documents one underlying
USDC balance with an 18-decimal native view for gas/`msg.value` and a 6-decimal
ERC-20 view for allowance/transfer operations. The [Viem Arc chain definition](https://github.com/wevm/viem/blob/bd8e313490d6f788a5d6f93c76f55fed606d78b9/src/chains/definitions/arc.ts)
and [Ethereum chain registry](https://github.com/ethereum-lists/chains/blob/fce7c2bf75e7428836c1f4f660ed1115d3e2f465/_data/chains/eip155-5042.json)
independently list the chain ID, explorer, and alternative RPC providers.
These are configuration sources, not live RPC or explorer verification. The
relevant Arc Docs references remain [Connect to Arc](https://docs.arc.io/arc/references/connect-to-arc),
[Contract addresses](https://docs.arc.io/arc/references/contract-addresses),
[Gas and fees](https://docs.arc.io/arc/references/gas-and-fees), and
[EVM differences](https://docs.arc.io/arc/references/evm-differences); direct
requests to those pages were blocked by this environment's proxy.

Live reads were attempted against the Circle endpoint and six publicly listed
alternatives: Blockdaemon (`rpc.blockdaemon.mainnet.arc.io`), dRPC
(`rpc.drpc.mainnet.arc.io` and `arc.drpc.org`), QuickNode
(`rpc.quicknode.mainnet.arc.io`), Beam (`rpc.beamrpc.com`), and BlockRequest
(`arc-rpc.blockreq.com/v1/rpc/public`). The verifier received no JSON-RPC
response from any of them (`fetch failed`; Node's resolver returned
`EAI_AGAIN` for the official, Blockdaemon, dRPC, QuickNode, and Beam hosts).
The docs-site request was stopped at the environment's outbound proxy:
`CONNECT tunnel failed, response 403`; it did not reach Arc Docs. So **no
current block, USDC bytecode/hash or decimals, native balance, gas price, or
explorer response was independently read on Mainnet in this environment**.
Current gas estimates and deployment costs are therefore unknown; do not use
Testnet fee settings as a Mainnet estimate.

The verifier below is read-only and emits the USDC runtime-code Keccak hash so
the operator can compare it across providers and the official explorer. Run it
separately against Circle and at least one independent listed provider. Accept
no alternative on its own: require chain ID `5042`, matching USDC code hash and
decimals `6`, near-current blocks, and a plausible gas quote from both; then
compare addresses and contract reads with the official explorer. Record each
provider's result independently. A disagreement or unavailable read is a stop
condition.

## Ordered owner-gated checklist

### 1. Approve the release boundary and custody

- [ ] Owner approves the launch scope, pilot cohort, USDC limits, transaction
  fee ceilings, deployment operator, maintenance window, on-call owner, stop
  conditions, and rollback authority.
- [ ] Provision independently controlled owner/deployer and relayer signers.
  Use the approved hardware or managed signer; keep recovery material under
  owner custody. Do not use a developer key, shared account, or key copied into
  CI/Vercel environment output.
- [ ] Provision a separate Mainnet spending wallet and savings destination for
  the supervised pilot. The owner approves pilot funding and transaction budget
  separately. Never use a Testnet identity or Testnet assets.
- [ ] Create a separate Vercel release-candidate project, Mainnet PostgreSQL
  database, RPC configuration, encrypted backup target, secret set, monitoring,
  and operator access. Do not inherit Testnet data, secrets, or scheduled jobs.
  Do not edit the current production project, alias, or domain during rehearsal.

### 2. Verify Arc Mainnet read-only

Use the official endpoint and one independent provider from the [Viem Arc list](https://github.com/wevm/viem/blob/bd8e313490d6f788a5d6f93c76f55fed606d78b9/src/chains/definitions/arc.ts).
These commands use only `eth_chainId`, `eth_blockNumber`, `eth_getCode`,
`eth_call`, `eth_getBalance`, and `eth_gasPrice`. Use provider credentials only
through a protected secret mechanism; never include them in a committed artifact
or shell history.

```sh
mkdir -p artifacts
ARC_MAINNET_RPC_URL=https://rpc.mainnet.arc.io \
  ARC_MAINNET_READONLY_EVIDENCE=artifacts/arc-mainnet-readonly.json \
  npm run verify:arc-mainnet:readonly

ARC_MAINNET_RPC_URL=https://rpc.blockdaemon.mainnet.arc.io \
  ARC_MAINNET_READONLY_EVIDENCE=artifacts/arc-mainnet-readonly-blockdaemon.json \
  npm run verify:arc-mainnet:readonly
```

Expected: JSON `result: "PASS"`, `chainId: 5042`, a decimal latest block,
nonempty USDC code and `usdcRuntimeCodeHash`, `erc20Decimals: 6`, successful
native `eth_getBalance`, and an `observedGasPriceWei`. The two outputs must agree
on chain ID, code hash, and decimals; blocks must be close enough to reflect the
same live head. Record both gas quotes and confirm the official explorer resolves
to the same chain/contracts. Any timeout, wrong chain, hash/decimals mismatch,
unexplained block divergence, redirect, or malformed response is a stop
condition. This repository's blocked attempts are not a Mainnet verification.

### 3. Run offline gates, estimate deployment fees, and deploy

```sh
npm ci
npm run typecheck
npm run lint
npm run test:mainnet-build-guard
npm run test:network-isolation
npm run test:financial-presentation
npm run test:spending-permissions
npm run test:postgres
npm run test:security
npm run test:observer
npm run test:activity
npm run test:savings-accounting
npm run contract:test
```

Expected: all commands pass; worker and relayer remain disabled. Capture the
exact source commit and `forge build --sizes` output. Independently review the
Solidity source and constructor arguments. Estimate the exact creation gas for
both `MovyAutoSaver` (canonical USDC address and separately controlled relayer)
and `MovySavings` (no constructor arguments) against the verified Mainnet RPC.
Add the 20% gas limit buffer, calculate worst-case fees at the owner-approved
maximum fee per gas, and compare with the owner's explicit per-transaction and
aggregate budget. If an estimate exceeds any approved ceiling, stop. No fee
ceiling is preapproved by this code change. **Expected numeric deployment and
pilot costs are currently unknown** because no Mainnet provider returned an RPC
quote; do not substitute Testnet values. Calculate each worst case as
`ceil(eth_estimateGas × 1.20) × owner-approved maxFeePerGas`, in 18-decimal
native USDC, then sum the approved transactions. Require both the Circle RPC
and an independent provider to return matching deployment estimates before
presenting exact amounts to the owner. If either quote is unavailable, the
estimates disagree, or any per-transaction/aggregate ceiling is absent or
exceeded, stop before any signer prompt.

**Owner approval gate:** before running any deployment command, approve the
exact artifact hashes, constructor parameters, signer, estimated gas, buffered
gas limit, maximum fee per gas, maximum transaction fee, and aggregate budget.
Use the owner's hardware/managed signer, not a private-key environment
variable. Example operator commands (broadcasting commands; run only after the
separate approval above):

```sh
cd contracts
arc-forge --version # verify the checksum-pinned Circle Arc Foundry release
arc-forge build --sizes
arc-forge create src/MovyAutoSaver.sol:MovyAutoSaver \
  --rpc-url "$ARC_MAINNET_RPC_URL" --ledger \
  --constructor-args "$ARC_USDC_ADDRESS" "$MOVY_MAINNET_RELAYER_ADDRESS"
arc-forge create src/MovySavings.sol:MovySavings \
  --rpc-url "$ARC_MAINNET_RPC_URL" --ledger
```

Before each broadcast, the operator must supply the reviewed buffered gas limit
and fee parameters supported by the installed Foundry version; record them with
the transaction hash. `--ledger` must display the expected owner address and
the operator must verify the transaction on the device. Do not paste a mnemonic
or raw key into a command. If the signer cannot apply the approved fee ceilings,
stop and use an owner-approved compatible signer.

### 4. Verify deployments and create the owner-reviewed manifest

For each deployment, read the receipt and code using `cast`:

```sh
cast chain-id --rpc-url "$ARC_MAINNET_RPC_URL"
cast receipt "$MOVY_AUTO_SAVER_DEPLOY_TX" --rpc-url "$ARC_MAINNET_RPC_URL" --json
cast code "$MOVY_AUTO_SAVER_ADDRESS" --rpc-url "$ARC_MAINNET_RPC_URL"
cast keccak "$(cast code "$MOVY_AUTO_SAVER_ADDRESS" --rpc-url "$ARC_MAINNET_RPC_URL")"
cast call "$MOVY_AUTO_SAVER_ADDRESS" 'owner()(address)' --rpc-url "$ARC_MAINNET_RPC_URL"
cast call "$MOVY_AUTO_SAVER_ADDRESS" 'relayer()(address)' --rpc-url "$ARC_MAINNET_RPC_URL"
cast call "$MOVY_AUTO_SAVER_ADDRESS" 'usdc()(address)' --rpc-url "$ARC_MAINNET_RPC_URL"
cast receipt "$MOVY_SAVINGS_VAULT_DEPLOY_TX" --rpc-url "$ARC_MAINNET_RPC_URL" --json
cast code "$MOVY_SAVINGS_VAULT_ADDRESS" --rpc-url "$ARC_MAINNET_RPC_URL"
```

Expected: chain `5042`; both receipts succeeded at their recorded blocks and
contain the expected contract addresses; runtime hashes match the code reviewed
for this source commit; AutoSaver USDC matches the canonical address; owner and
relayer are nonzero, independently controlled, and distinct. Verify the
relayer signer address without exposing its credential. Compare every readback
with the official explorer and retain RPC outputs.

Only after those checks, owner-review `config/networks/arc-mainnet.json` using
the enforced schema: `network: "arc-mainnet"`, `status: "owner-verified"`,
chain ID, approved RPC/explorer, canonical USDC, both deployment addresses,
blocks, transaction hashes and runtime code hashes, AutoSaver owner/relayer
addresses with `roles.verified: true`, and a fee policy with decimal-string
`minBaseFeePerGasWei`, `maxFeePerGasWei`, `priorityFeePerGasWei`, and
`maxTransactionFeeWei`. Record `observedGasPriceWei` from the read-only check
and require it to remain below the approved maximum. Include approver
identity/time and links to official documentation and RPC evidence. Do not
create a placeholder or synthetic manifest. Server startup rechecks deployment
receipts, runtime hashes, roles, fee bounds, RPC chain ID, USDC code, and ERC-20
decimals.

### 5. Configure an isolated release candidate with financial actions off

Set these values only in the separate release-candidate project and its
Mainnet-only database. All address/deploy-block values must match the reviewed
manifest. `MOVY_WORKER_ENABLED` and `MOVY_RELAYER_ENABLED` must remain `false`.

```text
MOVY_TARGET_NETWORK=mainnet
NEXT_PUBLIC_MOVY_TARGET_NETWORK=mainnet
NEXT_PUBLIC_MOVY_CHAIN_ID=5042
MOVY_DATABASE_NETWORK=mainnet
ARC_MAINNET_RPC_URL=https://rpc.mainnet.arc.io
NEXT_PUBLIC_ARC_MAINNET_RPC_URL=https://rpc.mainnet.arc.io
NEXT_PUBLIC_ARC_MAINNET_EXPLORER_URL=<verified manifest explorer URL>
NEXT_PUBLIC_MOVY_AUTO_SAVER_MAINNET=<verified AutoSaver address>
NEXT_PUBLIC_MOVY_ADDRESS_MAINNET=<verified Savings Vault address>
NEXT_PUBLIC_MOVY_AUTO_SAVER_DEPLOY_BLOCK_MAINNET=<verified AutoSaver block>
NEXT_PUBLIC_MOVY_DEPLOY_BLOCK_MAINNET=<verified Savings Vault block>
NEXT_PUBLIC_MOVY_MIN_BASE_FEE_PER_GAS_WEI_MAINNET=<manifest minimum base fee in wei>
NEXT_PUBLIC_MOVY_MAX_FEE_PER_GAS_WEI_MAINNET=<manifest maximum fee in wei>
NEXT_PUBLIC_MOVY_PRIORITY_FEE_PER_GAS_WEI_MAINNET=<manifest priority fee in wei>
NEXT_PUBLIC_MOVY_MAX_TRANSACTION_FEE_WEI_MAINNET=<manifest max transaction fee in wei>
MOVY_RELAYER_MAX_FEE_PER_GAS_WEI=<manifest maximum fee in wei>
MOVY_RELAYER_MAX_TX_FEE_WEI=<manifest max transaction fee in wei>
MOVY_WORKER_ENABLED=false
MOVY_RELAYER_ENABLED=false
MOVY_DEMO_MERCHANT_PAYMENT_ENABLED=false
DATABASE_URL=<separate TLS-verified Mainnet PostgreSQL endpoint>
```

Provision the database and run the reviewed schema migration only against that
Mainnet database:

```sh
npm run db:migrate
# Expected: schema version 3 and database network binding `mainnet`.
MOVY_TARGET_NETWORK=mainnet NEXT_PUBLIC_MOVY_TARGET_NETWORK=mainnet \
  NEXT_PUBLIC_MOVY_CHAIN_ID=5042 MOVY_DATABASE_NETWORK=mainnet \
  MOVY_WORKER_ENABLED=false MOVY_RELAYER_ENABLED=false npm run build
node scripts/verify/network-build-guard.mjs postbuild
```

Expected: with a real owner-verified manifest, build succeeds and the postbuild
guard confirms that Testnet endpoints, explorer links, chain ID, and deployment
addresses are absent. Missing manifest/configuration or any Testnet artifact
must fail the build. The repository now has a verified Mainnet deployment manifest. The complete
prebuild and postbuild gates must pass for the isolated release candidate.

Configure product and Demo origins explicitly. Confirm there is no inherited
Testnet database, cron schedule, relayer signer, Testnet RPC, or Testnet
contract setting. Keep the release candidate private. Deploy only to the new
candidate project after owner approval; do not change production aliases.
Verify `/api/health`, authenticated `/api/ops/health`, wallet chain display,
Mainnet-only explorer links, contract role/configuration readbacks, error
monitoring, and Testnet mismatch rejection with a controlled, unfunded wallet.
No funding, signature, enrollment, or broadcast is part of this release-candidate
check.

### 6. Pilot activation, monitoring, and rollback

- [ ] Owner approves a separate pilot transaction budget, wallet, maximum
  allowance, per-roundup cap, daily cap, and cohort. Secure the dedicated
  relayer signer in the approved secret manager and verify its address matches
  the onchain relayer role. Do not add a key to GitHub, logs, or browser config.
- [ ] Run one owner-supervised wallet enrollment and capped approval, inspect
  both wallet requests, verify onchain and database enrollment state, and stop
  on any mismatch. Owner approval is required for each signature and broadcast.
- [ ] Enable the relayer only for the approved pilot after verifying both
  independent controls, per-transaction fee caps, worker lock, database binding,
  RPC health, and emergency operator access. Enable the bounded worker schedule
  only after separate owner approval; there is no default Vercel Cron schedule.
- [ ] Monitor RPC failures/latency, observer and enrollment cursors, finalized
  block lag, duplicate/idempotent events, pending/submitted/uncertain jobs,
  receipt reconciliation, fee ceilings, allowance/cap rejects, DB pool/locks,
  4xx/5xx rates, and worker completion. Alert the on-call owner before
  automatic retry limits or function duration are exceeded.
- [ ] Emergency stop: set `MOVY_RELAYER_ENABLED=false` first and
  `MOVY_WORKER_ENABLED=false` immediately after, then redeploy the isolated
  candidate. Preserve submitted/uncertain jobs and reconcile receipts; never
  reset them to pending. If contract-level shutdown is required, owner approves
  and signs `setGlobalPaused(true)` with a separately stated fee budget, then
  verify its receipt and read back `paused() == true`.
- [ ] Roll back candidate traffic only to the last reviewed compatible build.
  Keep the Mainnet database and manifest isolated; never point Mainnet services
  to Testnet state or reverse a financial migration by discarding receipts.
  Record the rollback commit, disabled controls, unresolved jobs, and owner who
  authorized recovery.

## Arc Studio preparation and current release evidence (2026-11-02)

Arc Studio project: [MOVY](https://studio.arc.io/app/303b83d4-ba20-46ff-a3de-93e5f83d73a8).
Studio implemented the initial Mainnet fee policy, enforced the documented
20 Gwei floor at build and runtime boundaries, added ten Solidity readiness
tests, and reviewed the contract/source correspondence. The public preparation
files are `config/networks/arc-mainnet.env.template` and
`config/networks/arc-mainnet.candidate.json`. Candidate evidence does not grant
release approval.

The approved initial policy is a 20 Gwei minimum base fee, 30 Gwei maximum fee
per gas, 1 Gwei priority fee, and 0.05 native USDC maximum transaction fee.
Relayer ceilings match. Read the network quote and estimate gas again before
signing; a higher estimate must stop at the approved ceiling.

`arc-mainnet.source-lock.json` pins the exact Solidity files, Foundry settings,
and expected runtime code hashes. A Mainnet prebuild checks the source SHA-256
values, and server configuration binds the manifest hashes to the bundled lock.
Changing approval flags cannot select the older AutoSaver. Preserve LF line
endings using the repository's existing attributes.

Both the official and Blockdaemon RPC providers returned chain 5042 and matching
canonical USDC code, six-decimal ERC-20 units, and MOVY runtime code hashes.
Their source comparison found that the earlier AutoSaver is 5706 bytes while
current source compiles to 5734 bytes. The difference is the allowance-view
pause fix; executor pause enforcement is unchanged. The owner approved and signed a new current-source AutoSaver deployment at
`0x98ab14da8f6e68add0cdfeb75bdc4c2ea9044539`, block `29090033`. Both providers
verified receipt status 1 and runtime hash
`0xbcc96066def2f5f9764dab9eebb4616bae441cb4739e29af4c83c7be7fd45eb8`.
Its transaction is
`0x4c1f8c9f29754bb046f49fbb0a9606263f7b4b1f4f990d8ee725b166b302354c`;
the actual fee was 0.028642803 USDC, below the approved 0.05 USDC ceiling.
The release template and verified manifest now select this deployment.
The 1584-byte Savings Vault matches current source and can be reused.

Both providers estimated AutoSaver creation at 1375935 gas for the proposed
constructor inputs. A 20 percent gas buffer gives 1651122 gas, with a worst-case
fee of 0.04953366 USDC at the 30 Gwei ceiling. This is a snapshot, not approval
to send. Re-estimate with the final relayer address before signing.

The official RPC returned status 1 for both earlier deployment receipts in the
later local observation. Blockdaemon returned null receipts; that is missing
independent receipt evidence, not a failed transaction. The official explorer
was not accessible from this executor. The candidate records these limits.
A separate Mainnet database was initialized at schema version 3, including
wallet profiles, with a Mainnet network binding and no enrollments or jobs.

Local candidate origins are `http://localhost:3211` for the product and
`http://localhost:3212` for the isolated Demo boundary. Use a separate source
snapshot without Testnet `.env` or `.env.local` files for the Mainnet build;
Next.js would otherwise load those files. Replace local origins with exact
approved HTTPS origins when preparing hosted release configuration.

## Remaining release gates

- Keep the current source frozen against the release lock. Any further
  deployment or transaction requires its own approval.
- The new receipt, current-source runtime hash, roles, USDC and pause readbacks
  are verified in `arc-mainnet.json`. Recheck them if release inputs change.
  Historical candidate observations remain unapproved.
- The isolated Mainnet production build and read-only API checks passed against
  its dedicated schema-3 database and exact local origins. Connected-wallet
  review and hosted release verification remain, with financial services off.
- Separately authorize the controlled financial pilot. The public Testnet run
  is recorded in `TESTNET-FIRST-FINANCIAL-CERTIFICATION.md`; Mainnet application
  transactions remain unverified.
- Complete the live app, real Mainnet USDC transaction and submission evidence.
  Studio preparation and contract tests do not establish a Mainnet app flow.

Exactly one owner-approved AutoSaver deployment was signed through MetaMask.
No further Mainnet transaction, production worker activation, relayer funding,
hosted deployment, GitHub publication or traffic cutover was performed.
