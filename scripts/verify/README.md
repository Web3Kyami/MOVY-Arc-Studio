# Browser verification

The release browser gate runs the Batch 2 functional, layout, accessibility,
dialog, wallet-mock, and recovery checks against a production Next.js build.
It covers all nine routes at 320, 390, 768, 900, 1440, and 1920 pixels.

```bash
npm ci
npx playwright-core install chromium
npm run build
npm run verify:batch-2
```

On Linux, provision browser system dependencies with:

```bash
npx playwright-core install --with-deps chromium
```

`verify:batch-2` starts and stops its own production server on an available
loopback port, launches the Playwright-managed Chromium revision pinned by the
lockfile, and runs every check even if an earlier check fails. A missing build,
server startup failure, assertion failure, browser error, or timeout returns a
non-zero exit code. It does not use a system Chrome path or contact a live wallet.

The default evidence directory is `artifacts/browser-verification/`; set
`EVIDENCE_OUT` to choose another location. It contains `browser-results.json`,
per-check logs, the 54-case route/viewport matrix, and screenshots. GitHub Actions
uploads the directory as `movy-browser-evidence-<commit>` even when a check fails.

The connected cases use intercepted EIP-1193 providers and mocked RPC/API
responses. Start Saving uses this flow to connect a test account, validate a
separate savings address and key-ownership confirmation, choose limits, and
reach wallet authorization review. The test stops before any enrollment or
allowance request and asserts that no signing or transaction method is called.
Other cases cover wallet cancellation and retry, wrong network, merchant payment
rejection, receipt RPC failure and retry, and reverted receipts. They assert
that recovery does not submit duplicate payments. Demo cases verify that
simulated data remains separate from connected reads and no transaction is
requested. This suite provides browser regression evidence only; it is not a
real-wallet or Arc Testnet certification.

The separate `verify:connected` script uses a fake wallet for read-only Arc
Testnet inspection and intentionally rejects any signature request. It is not
part of the pull request browser job. The PR job performs no live chain reads,
wallet signing, worker action, or transaction submission.
