# First MOVY Testnet financial certification

> **Update (2026-10-31):** A fresh AutoSaver is deployed and independently
> verified on Arc Testnet, and the local app selects it. The full controlled
> lifecycle passed with the existing test-4 spender and two existing EVM test
> wallets: a `$0.17` merchant payment and `$0.83` savings transfer both
> finalized. The test enrollment was paused and revoked; its allowance is zero.
> The local encrypted relayer signer and manual worker remain enabled with no
> background schedule. Mainnet was not used. See the current
> evidence table below and the
> separate local-chain certification at
> [`LOCAL-ARC-FINANCIAL-CERTIFICATION.md`](./LOCAL-ARC-FINANCIAL-CERTIFICATION.md).

This runbook records the Arc Testnet financial certification. The original
authorization covered a fresh deployment and bounded wallet activity; the
owner later authorized the complete controlled lifecycle and manual worker
catch-up needed to verify it. It excludes Mainnet, production infrastructure,
and the existing AutoSaver deployment because that deployment uses the known
compromised development identity for both owner and relayer.

The approved deployment and role funding completed on 2026-10-31 using the
host's existing encrypted Testnet wallet pool. No new wallet keys were
generated. The controlled payment and roundup lifecycle is complete. The
spending enrollment was revoked after the test. The relayer and worker are
enabled only in the local Testnet environment; the worker has no schedule and
runs only when manually triggered.

## What this phase verifies

Offline PostgreSQL tests exercise migrations, isolated schemas, worker leases,
fencing, cursor replay, enrollment history, idempotency, relayer receipt
recovery, payment evidence, accounting, and RPC-timeout recovery. Contract
tests exercise role separation, caps, replay protection, pause/revoke, and
transfer behavior in Foundry CI. The isolated relayer integration uses a
mocked RPC and signer; it is not a live financial test.

The relayer now re-reads each payment transaction, receipt, and canonical block
from the configured RPC. It requires a finalized direct USDC transfer whose
sender, recipient, amount, transaction hash, block, log index, and calculated
round-up match the pending record. Before broadcasts it verifies the RPC chain,
deployed bytecode, distinct on-chain owner/relayer, signer address, and canonical
USDC address. It requires a per-gas ceiling and per-transaction maximum fee.
It also checks the relayer has enough native balance to cover the approved
maximum transaction fee before marking a job as submitting. RPC, gas-estimation,
fee-cap, and insufficient-balance failures leave a job retryable; uncertain
submissions remain quarantined for receipt reconciliation.

The observer and enrollment indexer scan finalized blocks. Observer tests check
that a reported Transfer event appears in its transaction receipt and matches
the actual direct transfer. PostgreSQL test connections now search only the
unique test schema; they cannot fall through to `public` tables.

These checks do not prove that a real wallet signature, deployed contract,
production PostgreSQL service, scheduled worker, relayer key, or Testnet
transfer works end to end.

## Contract and role preparation

1. The lifecycle used the existing host-managed Testnet roles: test-1 is the
   funding hub, test-2 is the owner/deployer, test-3 is the relayer, and test-4
   is the spending-wallet role. The existing FundPact freelancer and buyer
   wallets served as merchant and savings destination. No new keys were
   generated; test-1 stayed out of app activity.
2. Build and test the exact source revision in CI. The local deployment helper
   is `scripts/deploy-auto-saver-testnet.mjs`. Its default mode is read-only
   preflight and it writes to `contracts/deployed-testnet-fresh.json` after an
   explicitly approved deployment; it never overwrites the compromised
   `contracts/deployed-testnet.json`.
3. Run the read-only preflight after the fresh public addresses are available.
   The already-approved deployment cap is `0.15` native USDC, represented as
   `150000000000000000` wei because Arc's native USDC has 18 decimals:

   ```sh
   MOVY_OWNER_ADDRESS=0xOWNER \
   MOVY_RELAYER_ADDRESS=0xRELAYER \
   MOVY_DEPLOY_MAX_FEE_PER_GAS_WEI=25000000000 \
   MOVY_DEPLOY_MAX_TX_FEE_WEI=150000000000000000 \
   node scripts/deploy-auto-saver-testnet.mjs
   ```

   Expected output is JSON with `mode: "read-only-preflight"`, chain ID
   `5042002`, distinct role addresses, canonical USDC
   `0x3600000000000000000000000000000000000000`, six decimals, estimated gas,
   a 20% gas limit buffer, and a maximum fee below the supplied budget. It must
   fail if the RPC chain, token code/decimals, role addresses, or budget do not
   match. The helper hard-rejects a `MOVY_DEPLOY_MAX_TX_FEE_WEI` above
   `150000000000000000` (the cap above), before any RPC request. This command does
   not sign or broadcast.
4. The owner's authorization already covers one fresh deployment within the
   listed budget. After the read-only preflight passes, the protected signing
   runner may invoke the helper with `--broadcast
   --i-understand-this-broadcasts` and `MOVY_TESTNET_DEPLOY_APPROVED=YES`.
   The helper signs only with an encrypted Foundry keystore plus a password file:
   set `MOVY_DEPLOYER_KEYSTORE` (or `ETH_KEYSTORE`) to the keystore file path and
   `MOVY_DEPLOYER_PASSWORD_FILE` (or `ETH_PASSWORD_FILE`) to a password file with
   mode `0600`. Only these two paths are configured; the helper decrypts in memory
   (ordinary Foundry scrypt and PBKDF2 keystores; keystores whose KDF cost exceeds
   fixed safety bounds are rejected before any derivation) and never accepts a raw
   key or password through env, arguments, logs, or output.
   Do not put keys or passwords in shell history, repository files, tool arguments,
   or logs.
5. **Completed 2026-10-31.** The deployment receipt succeeded at block
   `69940356`; its block hash matches the canonical Testnet block, which is
   finalized. The official Arc Testnet RPC returned 5,734 bytes of runtime
   code and matching `owner()`, `relayer()`, and `usdc()` values. The owner and
   relayer are distinct. The independent Blockdaemon endpoint could not resolve
   in this environment, so the second-provider check remains unavailable.
   The fresh manifest is `contracts/deployed-testnet-fresh.json`.

The server automatically selects `contracts/deployed-testnet-fresh.json` when it
exists, and validates it strictly: Arc Testnet (`network: "testnet"`, chain ID
`5042002`), canonical USDC, valid nonzero contract and role addresses, a positive
deployment block and a 32-byte deployment hash, `owner` equal to `deployer`, `owner`
distinct from `relayer`, and neither role equal to the known compromised
development address (the compromised AutoSaver address is also refused). If that file
exists but is malformed or unsafe, the server fails closed and does not fall back to
the old manifest. Only while the fresh file is absent is
`contracts/deployed-testnet.json` used, read-only, and the connected product keeps
that address write-blocked. After the read-only verification above, set only the
isolated Testnet runtime's `NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET` and
`MOVY_AUTO_SAVER_TESTNET_DEPLOY_BLOCK`; both now match the fresh manifest. The
old manifest remains untouched as audit evidence. The local dev server is
available at `http://localhost:3000`; its health and status routes resolve the
fresh contract and configured relayer. Use that exact host and port: the local
origin guard rejects `127.0.0.1` and unconfigured ports with HTTP 421. The
worker is manual only, with no background schedule. Run
`npm run verify:testnet-deployment-provenance` to read the selected manifest.

The 25 Gwei ceiling in the helper is a hard limit, not a fee quote. The
owner-approved transaction caps are:

| Operation | Maximum fee per transaction | Count | Max buffered gas at 25 Gwei | Maximum total |
| --- | ---: | ---: | ---: | ---: |
| Fresh contract deployment | 0.15 native USDC (`150000000000000000` wei) | 1 | 6,000,000 | 0.15 native USDC |
| Enrollment, approval, payment, pause, revoke | 0.02 each (`20000000000000000` wei) | 5 | 800,000 each | 0.10 native USDC |
| Round-up execution | 0.04 (`40000000000000000` wei) | 1 | 1,600,000 | 0.04 native USDC |
| Funding transfers | 0.02 each (`20000000000000000` wei) | Up to 3 | 800,000 each | 0.06 native USDC |
| **Aggregate hard ceiling** |  |  |  | **0.35 (`350000000000000000` wei)** |

For every transaction, compute `ceil(estimate × 1.20) × maxFeePerGas` first,
with `maxFeePerGas <= 25 Gwei`. Stop if the buffered estimate exceeds its
per-transaction cap or the aggregate remaining budget. Do not increase a cap.
The exact deployment preflight estimated `1375935` gas, or `1651122` with the
20% buffer. At 25 Gwei its maximum fee was `41278050000000000` wei
(`0.04127805` native USDC), below the authorized `0.15` cap. The deployment
used the separately funded test-2 owner and test-3 relayer. Wallet and relayer
transaction estimates were refreshed against the exact Testnet state before
signing and remained within the configured fee caps.

## Controlled $0.17 → $0.83 lifecycle

Use an owner-approved test wallet, a distinct controlled merchant recipient,
and a separately controlled savings destination. Use a direct transfer of the
canonical six-decimal USDC token for the $0.17 payment. Do not use a swap,
contract router, or unrelated transaction in this first certification.

**PASS - controlled Arc Testnet lifecycle.** Test-4 enrolled with the existing
buyer wallet as savings destination, approved exactly `830000` units, and paid
exactly `170000` units to the existing freelancer wallet. The local observer
created one job and the relayer sent exactly `830000` units to savings. All six
transaction receipts finalized. Pause and revoke then cleared the enrollment
and allowance. The test account is no longer enrolled.

| Step | Operation | Exact token amount or assertion |
| --- | --- | --- |
| 1 | Wallet calls `enroll(destination, 830000, 830000)` | Per-payment limit `$0.83`; daily limit `$0.83` |
| 2 | Wallet approves canonical USDC to the fresh AutoSaver | Exactly `830000` base units (`$0.83`) |
| 3 | Wallet transfers canonical USDC to the controlled merchant | Exactly `170000` base units (`$0.17`) |
| 4 | Finalized observer records the transaction, receipt, and direct Transfer event | Payment `170000`; calculated roundup `830000` |
| 5 | One explicitly activated worker cycle asks the relayer to execute | Exactly one `executeRoundup`; destination receives `830000` base units |
| 6 | Read the relayer receipt and contract state | Success; one matching `RoundupExecuted`; payment marked processed; allowance is zero; daily spend is `830000` |
| 7 | Wallet calls `setPaused(true)`, then `revoke()` | Paused, not enrolled, caps/destination cleared, epoch advanced; no later transfer |

The spending wallet therefore needs `$1.00` of canonical USDC principal:
`$0.17` merchant payment plus `$0.83` savings transfer. Its total Testnet
funding must stay within `$1.10`, including up to `$0.10` of wallet gas fees.
Arc's native and ERC-20 USDC views share the underlying balance; count them as
one balance and do not double-count the gas amount. The approval is limited to
`830000` base units. Owner/deployer and relayer gas funding must fit within the
three-transfer limit and the aggregate `0.35` native USDC fee ceiling.

The current code estimates deployment and relayer gas, adds a 20% gas buffer,
and refuses to proceed if the maximum cost exceeds the approved cap. Before
funding, estimate `enroll`, `approve`, `transfer`, `setPaused`, and `revoke`
against the fresh deployment. Each wallet transaction cap is `0.02` native
USDC; the relayer cap is `0.04`; deployment cap is `0.15`; each funding
transfer cap is `0.02`. Do not guess or reuse estimates from the compromised
deployment.

If the roundup does not confirm, stop the worker and relayer, preserve the
pending job and transaction evidence, and reconcile the receipt and
`isPaymentProcessed` state before any retry. If the exact allowance remains
after an unsuccessful test, the wallet owner may separately approve an
`approve(AutoSaver, 0)` revocation transaction within a separately approved gas
budget. After a successful `$0.83` transfer, verify the allowance is already
zero; no extra approval transaction is expected.

## Local backend readiness

- The local Testnet app uses an isolated PostgreSQL schema and reports schema
  version 2 ready. Do not connect this rehearsal to production data.
- The fresh contract, chain `5042002`, canonical USDC, and Arc Testnet RPC were
  verified through read-only RPC. The local status route resolves the fresh
  contract.
- The relayer signer is loaded from the host-managed encrypted test-3
  keystore/password files, both mode `0600`. No raw key is in environment
  configuration. The 25 Gwei and `0.04` USDC transaction caps are configured.
- At the user's request, `MOVY_WORKER_ENABLED` and `MOVY_RELAYER_ENABLED` are
  true in local `.env.local`. The worker route requires authentication and has
  no cron/background schedule; it runs only on a manual tick. Do not enable
  production infrastructure or use Mainnet. Stop the worker and relayer if a
  receipt, fee, role, database, or RPC check is unexpected.
- Confirm emergency stop access before activation. Stop on role mismatch,
  non-finalized evidence, DB/RPC uncertainty, unexpected eligible payments,
  incorrect amounts, a fee cap breach, or an unexpected receipt.

## Authorization status and browser boundary

The owner authorized the exact Testnet lifecycle and budgets in this runbook:
fresh deployment; enrollment; exact `$0.83` approval; exact `$0.17` payment;
one finalized observation; one `$0.83` round-up; receipt and balance checks;
pause; and revoke. A later explicit request enabled the local worker and
relayer for manual Testnet use and bounded catch-up batches. There is still no
background schedule. No separate approval is needed to use the shared testnet
roles or stated fee caps. All buffered gas estimates were calculated before
each write and stayed within their caps.

The controlled Testnet lifecycle used the host-managed test-4 signer and the
existing EVM recipient wallets. The browser session available to automation
had no injected `window.ethereum` provider, so the user-signing step was not
exercised through the browser. The actual deployed contract, observer,
authenticated local worker, relayer, database, and public receipts did run.
The local worker remains manual only. Do not touch the old compromised
contract.

## Current evidence and status

| Check | Result | Evidence |
| --- | --- | --- |
| TypeScript, ESLint, production build | **PASS** | Build and typecheck completed. ESLint: 0 errors, 8 warnings. Testnet build guards passed. |
| Payment evidence and deployment preflight | **PASS — offline fixtures** | `$0.17` → `$0.83`, direct transfer/receipt/block binding, finalization, tampered evidence, missing logs, distinct-role validation, and fee-budget rejection. No RPC writes. |
| PostgreSQL, security, observer, and accounting suites | **PASS — isolated local DB** | Fresh PostgreSQL 17 container, unique schema per suite; migrations, concurrency/fencing, cursor replay, recovery, idempotency, authorization, activity, exact accounting, and fail-closed cases passed. Container removed; worker/relayer gates were false during those suites. |
| Mainnet build fail-closed and audit deployment-off checks | **PASS** | Missing/unverified Mainnet configuration and Testnet runtime artifacts are rejected; audit branch remains deployment-disabled. No Mainnet build or deployment. |
| Arc Testnet chain and canonical USDC | **PASS — live read-only** | At block `67220020`, chain ID `5042002`, canonical USDC code was present (1,798 bytes) and the ERC-20 view reported six decimals. Exact-head CI job `38637926985` passed. No AutoSaver contract was queried by this check. |
| Fresh deployment gas estimate | **PASS — preflight and deployment** | Exact compiled bytecode: `1375935` estimated gas; `1651122` with 20% buffer; maximum `0.04127805` native USDC at 25 Gwei, below the `0.15` cap. The deployment succeeded and is independently recorded below. |
| Arc Foundry Solidity suites | **PASS — local Arc EVM** | Circle Arc Foundry `v0.8.0-2`, Solidity `0.8.28`: 79 tests passed (34 AutoSaver, 14 global-pause, 31 legacy savings), with 5,000 fuzz runs and seed 42. Exact-head CI also runs the Arc Foundry suites. |
| Local signed financial lifecycle | **LOCAL PASS** | Fresh local AutoSaver with separate random owner/relayer; six-decimal `$0.83` approval; signed `$0.17` USDC payment; actual PostgreSQL observer job; signed relayer `$0.83` transfer; receipt/balance reconciliation; pause/revoke. See the local certification evidence. |
| Connected local application | **PASS — controlled browser/read-only** | Arc Studio connected-readiness changes are integrated. Local Next.js `/` and `/api/health` return 200 with the isolated database ready; the Testnet-only production build passes. The connected browser audit passed 119 checks at 390×844 and 1440×900 using an in-memory wallet stub and live read-only Arc Testnet RPC. It made no wallet signatures or RPC writes. This does not prove a real-wallet approval or financial transaction. |
| Arc Testnet read-only fork | **PUBLIC TESTNET PASS — read only** | Arc Foundry fork at public block `67226595`, chain `5042002`; canonical USDC code hash and six-decimal ERC-20 view verified. No local accounts exposed and no writes broadcast. |
| Faucet funding and role transfers | **PASS — finalized Testnet receipts** | Faucet transaction [0xb373…4599](https://testnet.arcscan.app/tx/0xb373b5a83bb069467d72be6ef00a9f6789f36ec1424087a5f393699b20f74599) funded test-1. Transfer of `0.16` USDC to test-2 is [0xdcb9…f7d](https://testnet.arcscan.app/tx/0xdcb9303b1220993ad6016c2f66b179208c680aa4fb1a1d534a877fe08c522f7d). To prepare local app roles, `1.10` USDC was sent to test-4 ([0x0482…650f](https://testnet.arcscan.app/tx/0x0482ed078e8ef19675096488b1a8b07b6bada7c6d183551e377d93a9eec6650f)) and `0.04` USDC to test-3 ([0x0e2b…ccf8](https://testnet.arcscan.app/tx/0x0e2b50289ded02752da70d396386c2dd62731a88dca4361fdd939aff097dccf8)). All receipts succeeded, are canonical and finalized. Current test-1 balance is `38.695341` six-decimal USDC units. |
| Fresh public Testnet deployment | **PASS — finalized and independently read back** | AutoSaver at `0xfefad1873cf3908887b7f3bc452b701baf3c9703`, deploy block `69940356`, transaction [0x8875…0a5](https://testnet.arcscan.app/tx/0x8875510235e0d0efeb563515e4064eca8ff8ec2ee622e4368be89481e3fe60a5). Official RPC confirmed status 1, bytecode, owner, distinct relayer, and canonical USDC. Blockdaemon DNS was unavailable. |
| Local product app | **PASS — local Testnet configuration** | `http://localhost:3000/` returns 200. `/api/health` reports database ready, schema v2. `/api/status?chainId=5042002` returns the fresh AutoSaver address and `relayerConfigured:true`. The worker is enabled locally and manual only. The previous read-only connected browser audit passed 119 checks at 390×844 and 1440×900; it made no signatures or RPC writes. |
| Arc Testnet payment and roundup | **PASS - live contract and app backend** | Test-4 enrollment [0xa44c…9910](https://testnet.arcscan.app/tx/0xa44c3301bd2c7b6ac871efe4951520254f909acecdce90d325ccce0466769910), exact approval [0x946b…c941](https://testnet.arcscan.app/tx/0x946b976ac0d533803998381d3b7bf9390657ade33a3d2bc1b80d9c732c89c941), and `$0.17` merchant payment [0xe11a…6d66](https://testnet.arcscan.app/tx/0xe11a583c50b555fb1307831c21364d50b119de872824bd6f1f1a614d42cc6d66) finalized. The authenticated local worker recorded the payment; the relayer's `$0.83` transfer [0xec7d…673e](https://testnet.arcscan.app/tx/0xec7d06078123147d4e895f3f7da5e9e0ffcd8357586c379a2e7b2f795f6e673e) finalized. Merchant received `170000` six-decimal units; savings received `830000`; processed flag is true and allowance is zero. |
| Test-account cleanup | **PASS - finalized** | Personal pause [0xfc5d…a98a](https://testnet.arcscan.app/tx/0xfc5da60c5f1f2987053e8e41e8a5b3d145cfa618ea14aa1126dce28027caa98a) and revocation [0x5626…e1ad](https://testnet.arcscan.app/tx/0x562616b50c9346ea48a9328c3d22eabc8a3258455425a66274213f9f0631e1ad) finalized. On-chain config is revoked, paused, and cleared; allowance is zero. |
| Local manual worker and activity feed | **PASS** | Worker caught up in five bounded batches, observed one eligible merchant payment, created and confirmed one roundup job, then synced pause/revoke in a final batch. Database has one confirmed job, no pending work, zero active users and one activity row. The API omits MOVY's own transfer to the savings destination so it is not shown as a second purchase. |
| Local transaction receipts and database reconciliation | **PASS — local only** | Actual local transaction hashes, full receipts/logs, native/ERC-20 balance snapshots, observer rows, roundup jobs, cursors, and migration version are in `docs/evidence/local-arc-financial-certification.json`. These are not public Testnet receipts. |
| WalletConnect connection picker | **PASS — local QR and wallet list; pairing unverified** | The project ID is configured locally. The Settings dialog lists WalletConnect first, with injected and Coinbase fallbacks; Demo stays connector-free. Chromium at 1440×900 opened the desktop QR modal. At 390×844, WalletConnect opened its mobile wallet list with no horizontal overflow. Cancel returned to onboarding with a retryable message. No phone pairing, wallet account connection, signature, or transaction was performed through WalletConnect. |
| Arc Studio source verification, November 1, 2026 | **PASS: CLI completed checks** | Studio reported exit code zero for `bun run typecheck`, `bun run test:walletconnect`, `bun run test:financial-presentation`, `bun run test:auto-saver-write-safety`, `bun run test:withdrawal-fee-policy`, and syntax checks of `scripts/test-financial-presentation.mjs` and `scripts/verify/connected-app-readonly.mjs`. The previously cancelled verification batch is complete. Studio did not run the browser script, pair a wallet, sign, deploy, or broadcast transactions in these turns. |

The offline PostgreSQL tests cover observer retry, worker lock/recovery,
migration replay, authorization, idempotency, accounting, and operations
routes. Isolated test connections cannot resolve objects from `public`. The
first exact-head CI run also ran the historical connected-app read-only job,
which queried the existing compromised deployment's code and read-only state;
it did not sign or broadcast. That job is now disabled on `audit/movy-*`
branches. The audit branch instead runs the safe chain/canonical-USDC
read-only preflight above and will not query the compromised contract again.
The historical read-only browser helper generated unfunded throwaway accounts
in process memory; their private keys were not printed, persisted, or used to
sign. For local certification only, six fresh identities were generated in
memory and used only against non-forked `127.0.0.1` Arc Anvil with zero generated
Anvil accounts. Their private keys were not persisted or included in evidence.
The local Anvil lifecycle is separate from the public Testnet lifecycle and
does not verify production relayer custody, scheduled worker activation, or
hosted PostgreSQL. The public Testnet lifecycle and its finalized receipts are
recorded above. No Mainnet transaction or deployment occurred.

Exact-head CI `38637926985` completed successfully for the earlier commit
`0dab1a6d9e1e5e8f875797bc2f05701b3ec438e9`. The updated workflow adds the local
Arc Foundry/PostgreSQL financial certification to the next exact-head run. The
connected-app job that queried the old contract and the historical browser
suite remain skipped on this audit branch.

For the existing worker activation and recovery model, see
[`WORKER-OPERATIONS.md`](./WORKER-OPERATIONS.md). For later Mainnet migration
gates, see [`MOVY-MAINNET-CUTOVER.md`](./MOVY-MAINNET-CUTOVER.md).
