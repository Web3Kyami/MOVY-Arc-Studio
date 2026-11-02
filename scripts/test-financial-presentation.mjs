import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const presentation = await import('../src/lib/financial-presentation.ts')
const money = await import('../src/lib/money.ts')

assert.equal(presentation.goalProgressPercent('manual-plan', 0, 500), null,
  'connected planning targets never turn local zero into displayed financial progress')
assert.equal(presentation.goalProgressPercent('manual-plan', 500, 500), null,
  'even a stale local current value cannot fabricate connected goal progress')
assert.equal(presentation.goalProgressPercent('simulated', 125, 500), 25,
  'Preview goal progress remains simulated and functional')
assert.equal(presentation.formatGoalAmount(0), '$0.00',
  'a zero Preview goal amount remains a truthful zero rather than unavailable')
assert.equal(presentation.formatGoalAmount(12.34), '$12.34',
  'goal amounts are rendered from exact cents')
assert.equal(presentation.formatGoalAmount(0.001), 'Amount unavailable',
  'invalid sub-cent goal data is not rounded into a money claim')

const baseItem = {
  id: 'roundup', merchant: 'Recipient', originalAmount: 3.4,
  roundedAmount: 4, savedAmount: 0.6, multiplier: 1,
  timestamp: 'Oct 9, 12:00 PM', txHash: 'preview',
  category: 'payment', type: 'roundup',
}
assert.equal(presentation.activityAmountLabel({ ...baseItem, status: 'pending', savedAmount: 0.6 }), 'Pending',
  'pending jobs do not display their prospective amount as saved')
assert.equal(presentation.activityAmountLabel({ ...baseItem, status: 'failed', savedAmount: 0.6 }), 'Failed',
  'failed jobs do not display their prospective amount as saved')
assert.equal(presentation.activityAmountLabel({ ...baseItem, status: 'skipped', savedAmount: 0.6 }), 'Skipped',
  'skipped jobs do not display a saved amount')
assert.equal(presentation.activityAmountLabel({
  ...baseItem, status: 'confirmed', savedAmount: 0.600001, savedAmountText: '$0.600001',
}), '+$0.600001', 'confirmed connected activity uses exact 6-decimal text')
assert.equal(presentation.activityAmountLabel({ ...baseItem, status: 'confirmed', savedAmount: 0 }), 'No round-up',
  'whole-dollar payments are not described as a transferred amount')
assert.equal(presentation.activityAmountLabel({
  ...baseItem, type: 'withdrawal', savedAmount: -2.5, savedAmountText: '-$2.50',
}), '-$2.50', 'confirmed withdrawals retain their exact signed amount')

assert.equal(money.formatUsdc6Exact(0n), '$0.00')
assert.equal(money.formatUsdc6Exact(1_000_001n), '$1.000001')
assert.equal(money.formatUsdc6Exact(1_230_000n), '$1.23')
assert.equal(money.formatUsdc6Exact(1_234_567_000n), '$1,234.567')
assert.equal(money.formatUsdc6Exact(-1_000_001n), '-$1.000001')

// --- Optional legacy MovySavings vault ---------------------------------------------------
const accounting = await import('../src/lib/savings-accounting.ts')
const connected = { isConnected: true, isWrongNetwork: false, isLoading: false, isError: false, error: null, data: undefined }
// An absent legacy contract is "unavailable / not configured": not a confirmed zero, not an error.
assert.deepEqual(
  accounting.resolveMoneyQuery({ ...connected, unavailableReason: 'not-configured' }),
  { status: 'unavailable', reason: 'not-configured' },
)
assert.deepEqual(accounting.resolveMoneyQuery({ ...connected, isConnected: false, unavailableReason: 'not-configured' }),
  { status: 'unavailable', reason: 'disconnected' }, 'a disconnected wallet still reports disconnected')
assert.deepEqual(accounting.resolveMoneyQuery({ ...connected, isWrongNetwork: true, unavailableReason: 'not-configured' }),
  { status: 'unavailable', reason: 'wrong-network' }, 'a wrong network still reports wrong-network')
// A CONFIGURED contract keeps its RPC errors, loading state, and genuine zero.
assert.deepEqual(accounting.resolveMoneyQuery({ ...connected, isError: true, error: new Error('Arc Testnet RPC timeout') }),
  { status: 'error', message: 'Arc Testnet RPC timeout' })
assert.deepEqual(accounting.resolveMoneyQuery({ ...connected, isLoading: true }), { status: 'loading' })
assert.deepEqual(accounting.resolveMoneyQuery({ ...connected, data: 0n }), { status: 'ready', value: 0n })

const separateWallet = { status: 'ready', value: 5_000_000n }
const confirmedHistory = { status: 'ready', value: 48_600_000n }
const absentLegacy = accounting.buildSavingsFigures({
  confirmedRoundups6: confirmedHistory,
  destinationUsdc6: separateWallet,
  legacyVaultWei: { status: 'unavailable', reason: 'not-configured' },
})
assert.equal(absentLegacy.destinationWallet.status, 'ready', 'the separately owned savings wallet is readable without the legacy contract')
assert.equal(absentLegacy.destinationWallet.formatted, '$5.00')
assert.equal(absentLegacy.confirmedRoundups.formatted, '$48.60', 'AutoSaver history is independent of the legacy vault')
assert.equal(absentLegacy.legacyVault.status, 'unavailable')
assert.equal(absentLegacy.legacyVault.formatted, null, 'an absent legacy vault has no number at all, not "$0.00"')
assert.equal(accounting.savingsFigureText(absentLegacy.legacyVault), 'Legacy vault not configured')
assert.equal(absentLegacy.maxWithdrawWei, null)
assert.equal(absentLegacy.canTransferFromLegacyVault, false, 'withdrawal is disabled while the legacy vault is not configured')
// The legacy withdrawal needs a verified, sufficient CURRENT balance.
const legacyWith = (legacyVaultWei) => accounting.buildSavingsFigures({ confirmedRoundups6: confirmedHistory, destinationUsdc6: separateWallet, legacyVaultWei })
assert.equal(legacyWith({ status: 'ready', value: 0n }).canTransferFromLegacyVault, false)
assert.equal(legacyWith({ status: 'ready', value: money.CENTS_UNIT - 1n }).canTransferFromLegacyVault, false, 'a sub-cent balance cannot be requested accurately')
assert.equal(legacyWith({ status: 'ready', value: money.CENTS_UNIT }).canTransferFromLegacyVault, true)
assert.equal(legacyWith({ status: 'loading' }).canTransferFromLegacyVault, false)
assert.equal(legacyWith({ status: 'error', message: 'rpc down' }).canTransferFromLegacyVault, false)
assert.match(accounting.savingsFigureText(legacyWith({ status: 'error', message: 'rpc down' }).legacyVault), /^Unavailable · rpc down$/,
  'a configured legacy read failure stays visible')
assert.equal(accounting.validateVaultWithdrawal(money.CENTS_UNIT, { status: 'unavailable', reason: 'not-configured' }).reason, 'balance-unavailable')
let submittedWithoutLegacy = 0
const blockedSubmission = await accounting.submitVaultWithdrawal(
  money.CENTS_UNIT,
  async () => ({ status: 'unavailable', reason: 'not-configured' }),
  async () => { submittedWithoutLegacy += 1 },
)
assert.deepEqual(blockedSubmission, { ok: false, reason: 'balance-unavailable' })
assert.equal(submittedWithoutLegacy, 0, 'no withdrawal is submitted without a verified legacy balance')

const savingsHookSource = await readFile(new URL('../src/hooks/use-savings.ts', import.meta.url), 'utf8')
assert.match(savingsHookSource, /const walletReady = surfaceEnabled && isConnected && !isWrongNetwork && address !== undefined/)
assert.match(savingsHookSource, /const enabled = walletReady && contract !== undefined/,
  'legacy vault reads and legacy events are gated on the legacy address')
assert.match(savingsHookSource, /const destinationEnabled = walletReady && destination !== undefined\s/,
  'the savings-wallet balance does not depend on the legacy address')
assert.doesNotMatch(savingsHookSource, /destinationEnabled = [^\n]*contract/)
assert.match(savingsHookSource, /enabled: destinationEnabled/)
assert.match(savingsHookSource, /unavailableReason: contract === undefined \? 'not-configured' : undefined/)
assert.doesNotMatch(savingsHookSource, /isError: savingsRead\.isError \|\| \(isConnected && !isWrongNetwork && contract === undefined\)/,
  'an absent legacy contract is no longer an RPC error')

const homeSource = await readFile(new URL('../src/components/movy/views/home-view.tsx', import.meta.url), 'utf8')
const modeDataSource = await readFile(new URL('../src/hooks/use-movy-mode-data.ts', import.meta.url), 'utf8')
const activitySource = await readFile(new URL('../src/components/movy/views/activity-view.tsx', import.meta.url), 'utf8')
const financeSource = await readFile(new URL('../src/components/movy/consumer-finance.tsx', import.meta.url), 'utf8')
const savingsSource = await readFile(new URL('../src/components/movy/views/savings-view.tsx', import.meta.url), 'utf8')
const settingsSource = await readFile(new URL('../src/components/movy/views/settings-view.tsx', import.meta.url), 'utf8')
const onboardingSource = await readFile(new URL('../src/components/movy/onboarding/onboarding-flow.tsx', import.meta.url), 'utf8')
assert.match(modeDataSource, /recorded by MOVY in the last 7 days/,
  'Home explains the timestamp basis for the seven-day figure')
assert.doesNotMatch(homeSource, /this week/,
  'Home does not imply the recorded-time aggregate uses payment dates')
assert.match(activitySource, /confirmedRoundupCount/,
  'Activity lifetime totals come from the unbounded savings summary')
assert.match(financeSource, /USDC payment/,
  'connected activity calls the source amount a payment rather than a retail purchase')
assert.doesNotMatch(activitySource, /Zero Fee \(\$0\.00\)/,
  'receipts do not claim unverified zero network fees')
assert.match(savingsSource, /Manual plans\. Round-ups go to your savings address and are not allocated/,
  'connected goal targets are presented as planning only')
assert.match(settingsSource, /00:00 UTC/,
  'Settings matches the contract daily reset boundary')
assert.match(settingsSource, /Wallet disconnected\. No wallet is connected/,
  'Settings does not claim a disconnected wallet is connected to live contracts')
assert.doesNotMatch(onboardingSource, /updateProfile|profile\.demoAddress|isPreviewMode/,
  'connected onboarding does not read or mutate Demo profile state')
assert.doesNotMatch(onboardingSource, /setIsDemoMode|isDemoMode/,
  'connected onboarding has no in-app Demo mode toggle')
assert.match(modeDataSource, /merchant: 'USDC Payment'[\s\S]*category: 'payment'[\s\S]*timestampBasis: 'recorded'/,
  'connected verification activity does not invent merchant categories or payment timestamps')
assert.match(settingsSource, /Connecting shares your public wallet address[\s\S]*Wallet requests require your approval[\s\S]*MOVY is configured for \{ACTIVE_NETWORK_LABEL\}/,
  'wallet connection boundary names the selected network and permission requirement')
assert.match(savingsSource, /disabled=\{\s*!savings\.canTransferFromLegacyVault \|\| account\.isWrongNetwork \|\| !account\.isConnected\s*\}/,
  'mobile transfers are disabled without verified withdrawable vault funds')
// --- Final review: missing or unsafe AutoSaver disables activation before any wallet request ---
assert.match(onboardingSource, /!autoSaver\.contractAddress\s*\?\s*'missing-contract'\s*:\s*autoSaver\.financialWritesBlocked\s*\?\s*'blocked-contract'/,
  'activation is blocked for an absent or flagged AutoSaver')
assert.match(onboardingSource, /wallet\.isConnected && wallet\.address && !wallet\.isWrongNetwork/,
  'the block applies on the right network, leaving the wrong-network recovery path intact')
assert.match(onboardingSource, /Switch to \$\{ACTIVE_NETWORK_LABEL\} \(chain \$\{ACTIVE_CHAIN_ID\}\) before enrolling or setting an allowance\./,
  'the wrong-network recovery message is preserved')
assert.match(onboardingSource, /disabled=\{isActivating \|\| activationBlock !== null\}/, 'the activation control is disabled')
assert.match(onboardingSource, /'Automatic saving unavailable'/)
assert.match(onboardingSource, /No wallet approval prompt will open\./, 'the notice says no wallet approval prompt will open')
for (const handler of ['handleActivate', 'handleRetryEnrollmentSync']) {
  const start = onboardingSource.indexOf(`const ${handler} = async () => {`)
  assert.ok(start > 0, `${handler} exists`)
  const body = onboardingSource.slice(start, start + 260)
  assert.ok(body.indexOf('if (activationBlock) return') > 0 && body.indexOf('if (activationBlock) return') < body.indexOf('setIsActivating(true)'),
    `${handler} refuses before any state change or wallet request`)
}
assert.match(onboardingSource, /Could not confirm \$\{ACTIVE_NETWORK_LABEL\} activation\. Retry when the wallet and network are available\./,
  'recoverable wallet and RPC errors keep their retry message')
const autoSaverHookSource = await readFile(new URL('../src/hooks/use-auto-saver.ts', import.meta.url), 'utf8')
assert.match(autoSaverHookSource, /assertAutoSaverWriteAllowed\(ACTIVE_NETWORK, contractAddress, 'enroll'\)/,
  'the low-level write safety gate is preserved')
assert.match(activitySource, /Example only — no money moved\./,
  'Demo receipt explicitly states that no transaction moved money')

console.log('PASS: financial labels preserve exact amounts, honest statuses, and unallocated connected goal plans')
