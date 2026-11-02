import assert from 'node:assert/strict'
const accounting = await import('../src/lib/savings-accounting.ts')
const confirmedSummary = await import('../src/lib/confirmed-roundup-summary.ts')
const database = await import('../src/lib/server/db.ts')
const summaryRoute = await import('../src/app/api/auto-saver/activity/summary/route.ts')
const PRODUCT_ORIGIN = 'http://localhost:3000'
const {
  buildSavingsFigures,
  resolveMoneyQuery,
  savingsFigureText,
  submitVaultWithdrawal,
  validateVaultWithdrawal,
} = accounting
const { fetchConfirmedRoundupSummary } = confirmedSummary

const ready = (value) => ({ status: 'ready', value })

const figures = buildSavingsFigures({
  confirmedRoundups6: ready(23_000_000n),
  destinationUsdc6: ready(5_000_000n),
  legacyVaultWei: ready(2n * 10n ** 18n),
})

assert.deepEqual(
  {
    confirmedRoundups: figures.confirmedRoundups.formatted,
    destinationWallet: figures.destinationWallet.formatted,
    withdrawableLegacyVault: figures.legacyVault.formatted,
    maxWithdrawWei: figures.maxWithdrawWei,
    canTransferFromLegacyVault: figures.canTransferFromLegacyVault,
  },
  {
    confirmedRoundups: '$23.00',
    destinationWallet: '$5.00',
    withdrawableLegacyVault: '$2.00',
    maxWithdrawWei: 2n * 10n ** 18n,
    canTransferFromLegacyVault: true,
  },
  'history, user-owned destination balance, and withdrawable vault funds remain separate',
)

const zeroFigures = buildSavingsFigures({
  confirmedRoundups6: ready(0n),
  destinationUsdc6: ready(0n),
  legacyVaultWei: ready(0n),
})
assert.equal(zeroFigures.confirmedRoundups.formatted, '$0.00', 'confirmed history can be a real zero')
assert.equal(zeroFigures.destinationWallet.formatted, '$0.00', 'destination can have a real zero balance')
assert.equal(zeroFigures.legacyVault.formatted, '$0.00', 'legacy vault can have a real zero balance')
assert.equal(zeroFigures.maxWithdrawWei, 0n)
assert.equal(zeroFigures.canTransferFromLegacyVault, false, 'zero vault funds do not enable transfer')

const subCentVault = buildSavingsFigures({
  confirmedRoundups6: ready(0n),
  destinationUsdc6: ready(0n),
  legacyVaultWei: ready(10n ** 16n - 1n),
})
assert.equal(subCentVault.legacyVault.formatted, '$0.009999999999999999', 'sub-cent vault balances stay exact')
assert.equal(subCentVault.canTransferFromLegacyVault, false, 'cent-denominated controls cannot claim to transfer a sub-cent remainder')
assert.equal(buildSavingsFigures({
  confirmedRoundups6: ready(0n),
  destinationUsdc6: ready(0n),
  legacyVaultWei: ready(10n ** 16n),
}).canTransferFromLegacyVault, true, 'one full cent is an actionable vault balance')

const partialFailure = buildSavingsFigures({
  confirmedRoundups6: { status: 'error', message: 'activity API timeout' },
  destinationUsdc6: { status: 'error', message: 'Arc RPC timeout' },
  legacyVaultWei: ready(2n * 10n ** 18n),
})
assert.equal(partialFailure.confirmedRoundups.formatted, null, 'failed history is not rendered as zero')
assert.equal(partialFailure.destinationWallet.formatted, null, 'failed token reads are not rendered as zero')
assert.equal(partialFailure.legacyVault.formatted, '$2.00', 'an independent vault read remains usable')
assert.equal(partialFailure.canTransferFromLegacyVault, true)

const noDestination = buildSavingsFigures({
  confirmedRoundups6: ready(23_000_000n),
  destinationUsdc6: { status: 'unavailable', reason: 'no-destination' },
  legacyVaultWei: ready(0n),
})
assert.equal(noDestination.destinationWallet.formatted, null, 'no destination is unknown, not zero')
assert.equal(savingsFigureText(noDestination.destinationWallet), 'No savings destination configured')
assert.equal(savingsFigureText(partialFailure.destinationWallet), 'Unavailable · Arc RPC timeout')

assert.deepEqual(resolveMoneyQuery({
  isConnected: true,
  isWrongNetwork: false,
  isLoading: false,
  isError: false,
  error: null,
  data: 0n,
}), { status: 'ready', value: 0n }, 'a successful zero read remains distinguishable from unavailable')
assert.deepEqual(resolveMoneyQuery({
  isConnected: true,
  isWrongNetwork: false,
  isLoading: false,
  isError: true,
  error: new Error('temporary RPC timeout'),
  data: 5_000_000n,
}), { status: 'error', message: 'temporary RPC timeout' }, 'a stale cached amount is not trusted after RPC failure')
assert.deepEqual(resolveMoneyQuery({
  isConnected: false,
  isWrongNetwork: false,
  isLoading: false,
  isError: false,
  error: null,
  data: 5_000_000n,
}), { status: 'unavailable', reason: 'disconnected' })
assert.deepEqual(resolveMoneyQuery({
  isConnected: true,
  isWrongNetwork: true,
  isLoading: false,
  isError: false,
  error: null,
  data: 5_000_000n,
}), { status: 'unavailable', reason: 'wrong-network' })
assert.deepEqual(resolveMoneyQuery({
  isConnected: true,
  isWrongNetwork: false,
  isLoading: false,
  isError: false,
  error: null,
  data: undefined,
  unavailableReason: 'not-enrolled',
}), { status: 'unavailable', reason: 'not-enrolled' })

const fractionalDestination = buildSavingsFigures({
  confirmedRoundups6: ready(0n),
  destinationUsdc6: ready(5_123_456n),
  legacyVaultWei: ready(0n),
})
assert.equal(fractionalDestination.destinationWallet.formatted, '$5.123456', 'sub-cent ERC-20 units stay visible')

const exactVault = ready(2n * 10n ** 18n)
assert.deepEqual(validateVaultWithdrawal(1n, exactVault), { ok: true })
assert.deepEqual(validateVaultWithdrawal(2n * 10n ** 18n, exactVault), { ok: true })
assert.deepEqual(validateVaultWithdrawal(2n * 10n ** 18n + 1n, exactVault), {
  ok: false,
  reason: 'exceeds-balance',
})
assert.deepEqual(validateVaultWithdrawal(0n, exactVault), { ok: false, reason: 'invalid-amount' })
assert.deepEqual(validateVaultWithdrawal(1n, { status: 'loading' }), {
  ok: false,
  reason: 'balance-unavailable',
})
assert.deepEqual(validateVaultWithdrawal(1n, { status: 'error', message: 'RPC timeout' }), {
  ok: false,
  reason: 'balance-unavailable',
})
assert.deepEqual(validateVaultWithdrawal(1n, { status: 'unavailable', reason: 'wrong-network' }), {
  ok: false,
  reason: 'balance-unavailable',
})
assert.deepEqual(validateVaultWithdrawal(1n, { status: 'simulated', value: 2n * 10n ** 18n }), {
  ok: false,
  reason: 'balance-unavailable',
}, 'Preview fixture amounts cannot authorize a connected withdrawal')

let broadcastAttempts = 0
const mockBroadcast = async (amountWei) => {
  broadcastAttempts += 1
  return `mock:${amountWei}`
}
const exceedsMockBalance = await submitVaultWithdrawal(
  2n * 10n ** 18n + 1n,
  async () => exactVault,
  mockBroadcast,
)
assert.deepEqual(exceedsMockBalance, { ok: false, reason: 'exceeds-balance' })
assert.equal(broadcastAttempts, 0, 'an over-balance request never reaches the transaction writer')

const unavailableMockBalance = await submitVaultWithdrawal(
  1n,
  async () => ({ status: 'error', message: 'RPC timeout' }),
  mockBroadcast,
)
assert.deepEqual(unavailableMockBalance, { ok: false, reason: 'balance-unavailable' })
assert.equal(broadcastAttempts, 0, 'an unknown balance never reaches the transaction writer')

await assert.rejects(
  () => submitVaultWithdrawal(
    1n,
    async () => { throw new Error('RPC request failed') },
    mockBroadcast,
  ),
  /RPC request failed/,
)
assert.equal(broadcastAttempts, 0, 'a rejected balance re-read never reaches the transaction writer')

const exactMockBalance = await submitVaultWithdrawal(
  2n * 10n ** 18n,
  async () => exactVault,
  mockBroadcast,
)
assert.deepEqual(exactMockBalance, { ok: true, result: `mock:${2n * 10n ** 18n}` })
assert.equal(broadcastAttempts, 1, 'the exact verified balance is allowed once')

const chainId = 5_042_002
const walletA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const walletAUpper = `0x${walletA.slice(2).toUpperCase()}`
const walletB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const walletC = '0xcccccccccccccccccccccccccccccccccccccccc'
const walletD = '0xdddddddddddddddddddddddddddddddddddddddd'
let blockNumber = 1

async function seedPayment({ wallet, key, status, roundup6, isEligible = true, createdAt = new Date().toISOString(), paymentChainId = chainId, paymentBlockNumber }) {
  const paymentKey = `issue8:${key}`
  const currentBlock = paymentBlockNumber ?? blockNumber++
  assert.equal(await database.saveObservedPayment({
    paymentKey,
    chainId: paymentChainId,
    txHash: `0x${BigInt(currentBlock).toString(16).padStart(64, '0')}`,
    logIndex: 0,
    blockNumber: currentBlock,
    payer: wallet,
    recipient: '0xdddddddddddddddddddddddddddddddddddddddd',
    amount6: '2000000',
    roundup6: roundup6.toString(),
    isEligible,
    exclusionReason: isEligible ? undefined : 'unsupported_contract_interaction',
    createdAt,
  }), true)

  if (status) {
    assert.equal(await database.createRoundupJob({
      paymentKey,
      chainId: paymentChainId,
      wallet,
      destination: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      roundupAmount6: roundup6.toString(),
      configEpoch: 1,
      status,
      attempts: 0,
      createdAt,
      updatedAt: createdAt,
    }), true)
  }
  return paymentKey
}

// A confirmed-looking legacy job paired with an ineligible payment must not be
// counted. This synthetic row is placed before the feed window as another
// defense assertion for the database eligibility predicate.
await seedPayment({ wallet: walletA, key: 'wallet-a-ineligible-confirmed', status: 'confirmed', roundup6: 40_000n, isEligible: false })

// 105 confirmed rows exceed the separate 100-payment recent feed. The first
// amount is intentionally larger than Number.MAX_SAFE_INTEGER to guard exact
// base-unit summation; these are synthetic database records, not transactions.
const oversizedRoundup6 = 9_007_199_254_740_993n
for (let index = 0; index < 105; index++) {
  await seedPayment({
    wallet: walletA,
    key: `wallet-a-${index}`,
    status: 'confirmed',
    roundup6: index === 0 ? oversizedRoundup6 : 10_001n,
    createdAt: index === 0
      ? '2020-01-01T00:00:00.000Z'
      : new Date(Date.now() - index * 60_000).toISOString(),
  })
}
for (let index = 105; index < 109; index++) {
  await seedPayment({ wallet: walletA, key: `wallet-a-${index}`, status: 'pending', roundup6: 20_000n })
}
for (let index = 109; index < 111; index++) {
  await seedPayment({ wallet: walletA, key: `wallet-a-${index}`, status: 'skipped', roundup6: 30_000n })
}

await seedPayment({ wallet: walletB, key: 'wallet-b-confirmed-1', status: 'confirmed', roundup6: 30_000n })
await seedPayment({ wallet: walletB, key: 'wallet-b-confirmed-2', status: 'confirmed', roundup6: 40_001n })
await seedPayment({ wallet: walletB, key: 'wallet-b-pending', status: 'pending', roundup6: 50_000n })
await seedPayment({ wallet: walletB, key: 'wallet-b-skipped', status: 'skipped', roundup6: 60_000n })
await seedPayment({
  wallet: walletA,
  key: 'wallet-a-other-chain',
  status: 'confirmed',
  roundup6: 70_000n,
  paymentChainId: chainId + 1,
})

const recentActivity = await database.getActivityForWallet(chainId, walletA)
assert.equal(recentActivity.length, 100, 'the recent activity API remains independently capped at 100 payments')
assert.equal(recentActivity.some((item) => item.paymentKey === 'issue8:wallet-a-0'), false, 'the oldest confirmed payment falls outside the recent feed')
assert.equal(recentActivity.some((item) => item.paymentKey === 'issue8:wallet-a-ineligible-confirmed'), false, 'the old ineligible row is outside recent activity')
const recentSavedTotal = recentActivity.reduce(
  (sum, item) => item.roundupStatus === 'saved' ? sum + BigInt(item.roundup6) : sum,
  0n,
)
assert.equal(recentSavedTotal, 94n * 10_001n, 'recent activity remains limited and separate from lifetime totals')

const apiSummaryAResponse = await summaryRoute.GET(new Request(
  `${PRODUCT_ORIGIN}/api/auto-saver/activity/summary?wallet=${walletAUpper}&chainId=${chainId}`,
))
assert.equal(apiSummaryAResponse.status, 200)
const apiSummaryA = await apiSummaryAResponse.json()
assert.deepEqual(
  {
    confirmedRoundups6: apiSummaryA.confirmedRoundups6,
    confirmedRoundupCount: apiSummaryA.confirmedRoundupCount,
    recordedLast7DaysRoundups6: apiSummaryA.recordedLast7DaysRoundups6,
  },
  {
    confirmedRoundups6: (oversizedRoundup6 + 104n * 10_001n).toString(),
    confirmedRoundupCount: '105',
    recordedLast7DaysRoundups6: (104n * 10_001n).toString(),
  },
  'lifetime totals include all confirmed wallet-A jobs, exact large integers, and the complete last-seven-day window while excluding the older event',
)

const walletARead = await fetchConfirmedRoundupSummary(walletAUpper, chainId, async (url) =>
  summaryRoute.GET(new Request(new URL(url, PRODUCT_ORIGIN))),
)
assert.equal(walletARead.confirmedRoundups6, oversizedRoundup6 + 104n * 10_001n)
assert.equal(walletARead.confirmedRoundupCount, 105n)

const apiSummaryBResponse = await summaryRoute.GET(new Request(
  `${PRODUCT_ORIGIN}/api/auto-saver/activity/summary?wallet=${walletB}&chainId=${chainId}`,
))
assert.equal(apiSummaryBResponse.status, 200)
const apiSummaryB = await apiSummaryBResponse.json()
assert.equal(apiSummaryB.confirmedRoundups6, '70001', 'wallet B only receives its own confirmed total')
assert.equal(apiSummaryB.confirmedRoundupCount, '2', 'pending and skipped wallet-B jobs are excluded')

// Use a fixed server clock to exercise exact rolling-window boundaries. The
// recent metric is explicitly recording time because observer rows do not yet
// contain verified block timestamps.
const originalDateNow = Date.now
const fixedNow = Date.UTC(2026, 9, 9, 12, 0, 0)
Date.now = () => fixedNow
const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
const exactBoundary = new Date(fixedNow - sevenDaysMs).toISOString()
const justBeforeBoundary = new Date(fixedNow - sevenDaysMs - 1).toISOString()
const recentlyRecorded = new Date(fixedNow - 1_000).toISOString()

await seedPayment({ wallet: walletC, key: 'exact-seven-day-boundary', status: 'confirmed', roundup6: 100n, createdAt: exactBoundary })
await seedPayment({ wallet: walletC, key: 'one-ms-before-boundary', status: 'confirmed', roundup6: 200n, createdAt: justBeforeBoundary })
await seedPayment({ wallet: walletC, key: 'delayed-old-block-observation', status: 'confirmed', roundup6: 300n, createdAt: recentlyRecorded, paymentBlockNumber: 1 })
await seedPayment({ wallet: walletC, key: 'pending-inside-window', status: 'pending', roundup6: 400n, createdAt: recentlyRecorded })
await seedPayment({ wallet: walletC, key: 'skipped-inside-window', status: 'skipped', roundup6: 500n, createdAt: recentlyRecorded })
await seedPayment({ wallet: walletC, key: 'ineligible-inside-window', status: 'confirmed', roundup6: 600n, createdAt: recentlyRecorded, isEligible: false })

const recoveryKey = 'issue8:inspection-recovered-on-replay'
const recoveryTxHash = `0x${BigInt(blockNumber++).toString(16).padStart(64, '0')}`
const recoveryRecord = {
  paymentKey: recoveryKey,
  chainId,
  txHash: recoveryTxHash,
  logIndex: 0,
  blockNumber: 2,
  payer: walletC,
  recipient: '0xdddddddddddddddddddddddddddddddddddddddd',
  amount6: '2000000',
  roundup6: '700',
  isEligible: false,
  exclusionReason: 'tx_inspection_failed',
  createdAt: '2020-01-01T00:00:00.000Z',
}
assert.equal(await database.saveObservedPayment(recoveryRecord), true, 'initial inspection failure is stored for replay')
assert.equal(await database.saveObservedPayment({
  ...recoveryRecord,
  isEligible: true,
  exclusionReason: undefined,
  createdAt: recentlyRecorded,
}), true, 'successful replay recovers the row and updates observer recording time')
assert.equal(await database.saveObservedPayment({
  ...recoveryRecord,
  isEligible: true,
  exclusionReason: undefined,
  createdAt: new Date(fixedNow).toISOString(),
}), false, 'duplicate terminal replay does not refresh or duplicate the recovered payment')
assert.equal(await database.createRoundupJob({
  paymentKey: recoveryKey,
  chainId,
  wallet: walletC,
  destination: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  roundupAmount6: '700',
  configEpoch: 1,
  status: 'confirmed',
  attempts: 0,
  createdAt: recentlyRecorded,
  updatedAt: recentlyRecorded,
}), true)
assert.equal(await database.createRoundupJob({
  paymentKey: recoveryKey,
  chainId,
  wallet: walletC,
  destination: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  roundupAmount6: '700',
  configEpoch: 1,
  status: 'confirmed',
  attempts: 0,
  createdAt: recentlyRecorded,
  updatedAt: recentlyRecorded,
}), false, 'duplicate replay cannot create a second confirmed roundup job')

const apiSummaryCResponse = await summaryRoute.GET(new Request(
  `${PRODUCT_ORIGIN}/api/auto-saver/activity/summary?wallet=${walletC}&chainId=${chainId}`,
))
assert.equal(apiSummaryCResponse.status, 200)
const apiSummaryC = await apiSummaryCResponse.json()
assert.equal(apiSummaryC.confirmedRoundups6, '1300', 'lifetime total also includes the confirmed payment just outside the seven-day window')
assert.equal(apiSummaryC.confirmedRoundupCount, '4')
assert.equal(apiSummaryC.recordedLast7DaysRoundups6, '1100', 'recording-time window includes exact boundary, delayed observation, and recovered replay once')
Date.now = originalDateNow

const apiSummaryEmptyResponse = await summaryRoute.GET(new Request(
  `${PRODUCT_ORIGIN}/api/auto-saver/activity/summary?wallet=${walletD}&chainId=${chainId}`,
))
assert.equal(apiSummaryEmptyResponse.status, 200)
const apiSummaryEmpty = await apiSummaryEmptyResponse.json()
assert.equal(apiSummaryEmpty.confirmedRoundups6, '0', 'a successful empty wallet aggregate is a confirmed zero')
assert.equal(apiSummaryEmpty.confirmedRoundupCount, '0')

const wrongWalletResponse = new Response(JSON.stringify({
  chainId,
  wallet: walletB,
  confirmedRoundups6: '0',
  confirmedRoundupCount: '0',
  recordedLast7DaysRoundups6: '0',
}), { status: 200, headers: { 'content-type': 'application/json' } })
await assert.rejects(
  () => fetchConfirmedRoundupSummary(walletA, chainId, async () => wrongWalletResponse.clone()),
  /did not match the connected wallet and network/,
)

const unavailableSummaryResponse = new Response(JSON.stringify({
  error: 'Confirmed round-up totals are temporarily unavailable.',
}), { status: 503, headers: { 'content-type': 'application/json' } })
await assert.rejects(
  () => fetchConfirmedRoundupSummary(walletA, chainId, async () => unavailableSummaryResponse.clone()),
  /temporarily unavailable/,
)
assert.deepEqual(resolveMoneyQuery({
  isConnected: true,
  isWrongNetwork: false,
  isLoading: false,
  isError: true,
  error: new Error('Confirmed round-up totals are temporarily unavailable.'),
  data: walletARead.confirmedRoundups6,
}), {
  status: 'error',
  message: 'Confirmed round-up totals are temporarily unavailable.',
}, 'a summary HTTP failure stays an error even when a prior total is cached')

await database.getDb().query('DROP TABLE roundup_jobs')
const dbFailureResponse = await summaryRoute.GET(new Request(
  `${PRODUCT_ORIGIN}/api/auto-saver/activity/summary?wallet=${walletA}&chainId=${chainId}`,
))
assert.equal(dbFailureResponse.status, 503, 'database read errors do not return a fabricated zero total')
assert.equal((await dbFailureResponse.json()).confirmedRoundups6, undefined)

console.log('PASS: savings figures stay distinct; lifetime totals exceed feed limits exactly per wallet; unknown reads remain unknown; withdrawal limits are enforced')
