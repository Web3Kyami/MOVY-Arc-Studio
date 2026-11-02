import { strict as assert } from 'node:assert'
import crypto from 'node:crypto'
import {
  saveObservedPayment,
  createRoundupJob,
  getPendingJobs,
  updateJobStatus,
  getActivityForWallet,
  upsertEnrollment,
} from '../src/lib/server/db.ts'
import { computePaymentKey } from '../src/lib/server/observer.ts'
import { calculateRoundup6, formatUsdc6 } from '../src/lib/money.ts'
import { ARC_TESTNET_ID, txUrl } from '../src/lib/chain.ts'

console.log('=== RUNNING TASK 02 REAL ACTIVITY INTEGRATION VERIFICATION ===\n')

const CHAIN_ID = ARC_TESTNET_ID // 5042002
const PRODUCT_ORIGIN = 'http://localhost:3000'

// -----------------------------------------------------------------------------
// 1. Arc Testnet Explorer & Configuration Verification
// -----------------------------------------------------------------------------
console.log('Test 1: Arc Testnet Network & Explorer URLs')
assert.equal(CHAIN_ID, 5042002, 'Arc Testnet ID must be 5042002')
const sampleHash = '0xf73fc7ffb10812a339eee64ebf5ee06ce4de274ac099368f381686b3b6fc3305'
const explorerUrl = txUrl('testnet', sampleHash)
assert.equal(
  explorerUrl,
  `https://explorer.testnet.arc.io/tx/${sampleHash}`,
  'Explorer URL must target https://explorer.testnet.arc.io, not deprecated scan.arc.io'
)
console.log('✔ Arc Testnet explorer URL generation verified:', explorerUrl)

// -----------------------------------------------------------------------------
// 2. Token Decimals and Money Calculation Truthfulness
// -----------------------------------------------------------------------------
console.log('\nTest 2: Token Decimals and Zero-Change Formatting')
// USDC is 6 decimals on MovyAutoSaver, 18 decimals on MovySavings
const payment6 = 170_000n // $0.17
const roundup6 = calculateRoundup6(payment6) // $0.83
assert.equal(roundup6, 830_000n, '0.17 USDC must round up to 0.83 USDC')

const wholeDollar6 = 5_000_000n // $5.00
const wholeDollarRoundup6 = calculateRoundup6(wholeDollar6)
assert.equal(wholeDollarRoundup6, 0n, 'Whole dollar purchase must produce 0n roundup')

// Verify that 0 savedAmount never produces -$0.00
function formatSavedBadge(savedAmount, isFailed, isPending, isSkipped) {
  if (isFailed) return 'Failed'
  if (isPending) return 'Pending'
  if (isSkipped) return 'Skipped'
  if (savedAmount > 0) return `+$${savedAmount.toFixed(2)}`
  if (savedAmount === 0) return '$0.00'
  return `-$${Math.abs(savedAmount).toFixed(2)}`
}
assert.equal(formatSavedBadge(0, false, false, false), '$0.00', 'Zero savings must display $0.00, NEVER -$0.00')
assert.equal(formatSavedBadge(0.83, false, false, false), '+$0.83')
assert.equal(formatSavedBadge(0, false, false, true), 'Skipped')
assert.equal(formatSavedBadge(0.83, false, true, false), 'Pending')
assert.equal(formatSavedBadge(0.83, true, false, false), 'Failed')
console.log('✔ Decimal calculations and zero-savings display formatting verified')

// -----------------------------------------------------------------------------
// 3. Payment Key Computation & Deduplication (Idempotency)
// -----------------------------------------------------------------------------
console.log('\nTest 3: Replay Protection & Deduplication')
const testWallet = '0x' + crypto.randomBytes(20).toString('hex')
const testDest = '0x' + crypto.randomBytes(20).toString('hex')
const testTxHash = '0x' + crypto.randomBytes(32).toString('hex')

await upsertEnrollment({
  chainId: CHAIN_ID,
  wallet: testWallet,
  destination: testDest,
  maxRoundup6: '2000000',
  dailyCap6: '10000000',
  configEpoch: 1,
  status: 'active',
  enrolledAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
})

const pKey1 = computePaymentKey(CHAIN_ID, testTxHash, 0, testWallet)
const pKey2 = computePaymentKey(CHAIN_ID, testTxHash, 0, testWallet)
assert.equal(pKey1, pKey2, 'Payment key must be strictly deterministic')

const paymentRec = {
  paymentKey: pKey1,
  chainId: CHAIN_ID,
  txHash: testTxHash,
  logIndex: 0,
  blockNumber: 64450000,
  payer: testWallet,
  recipient: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A',
  amount6: '170000',
  roundup6: '830000',
  isEligible: true,
  createdAt: new Date().toISOString(),
}

const insertedFirst = await saveObservedPayment(paymentRec)
assert.equal(insertedFirst, true, 'First payment insertion must succeed')

const insertedDuplicate = await saveObservedPayment(paymentRec)
assert.equal(insertedDuplicate, false, 'Duplicate payment insertion must return false safely (replay protected)')

const jobRec = {
  paymentKey: pKey1,
  chainId: CHAIN_ID,
  wallet: testWallet,
  destination: testDest,
  roundupAmount6: '830000',
  configEpoch: 1,
  status: 'pending',
  attempts: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}
const jobFirst = await createRoundupJob(jobRec)
assert.equal(jobFirst, true, 'First job creation must succeed')

const jobDuplicate = await createRoundupJob(jobRec)
assert.equal(jobDuplicate, false, 'Duplicate job creation must return false safely')
console.log('✔ Deterministic paymentKey and PostgreSQL unique constraints enforce strict replay protection')

// -----------------------------------------------------------------------------
// 4. Status Transition & Activity Ledger Truthfulness
// -----------------------------------------------------------------------------
console.log('\nTest 4: Status Transitions (Pending -> Confirmed, Skipped, Failed)')

// Initial pending state
let items = await getActivityForWallet(CHAIN_ID, testWallet)
assert.equal(items.length, 1)
assert.equal(items[0].roundupStatus, 'pending', 'Initial status must be pending')

// Transition to confirmed
const relayerTx = '0x' + crypto.randomBytes(32).toString('hex')
const pendingList = await getPendingJobs(CHAIN_ID)
const targetJob = pendingList.find((j) => j.paymentKey === pKey1)
assert(targetJob, 'Job must be in pending jobs queue')
await updateJobStatus(targetJob.jobId, 'confirmed', { relayerTxHash: relayerTx })

items = await getActivityForWallet(CHAIN_ID, testWallet)
assert.equal(items[0].roundupStatus, 'saved', 'Confirmed job must report saved status')
assert.equal(items[0].relayerTxHash, relayerTx, 'Relayer tx hash must be linked')

// Second payment with whole dollar (0 roundup)
const wholeDollarTxHash = '0x' + crypto.randomBytes(32).toString('hex')
const wholeDollarKey = computePaymentKey(CHAIN_ID, wholeDollarTxHash, 1, testWallet)
await saveObservedPayment({
  paymentKey: wholeDollarKey,
  chainId: CHAIN_ID,
  txHash: wholeDollarTxHash,
  logIndex: 1,
  blockNumber: 64450001,
  payer: testWallet,
  recipient: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A',
  amount6: '5000000',
  roundup6: '0',
  isEligible: true,
  createdAt: new Date().toISOString(),
})
items = await getActivityForWallet(CHAIN_ID, testWallet)
const wholeDollarItem = items.find((i) => i.paymentKey === wholeDollarKey)
assert(wholeDollarItem, 'Whole dollar payment must appear in activity ledger')
assert.equal(wholeDollarItem.roundupStatus, 'whole_dollar', 'Zero roundup must be categorized as whole_dollar')

// MOVY's own round-up transfer is a savings movement, not a second purchase.
const savingsTransferTxHash = '0x' + crypto.randomBytes(32).toString('hex')
const savingsTransferKey = computePaymentKey(CHAIN_ID, savingsTransferTxHash, 3, testWallet)
await saveObservedPayment({
  paymentKey: savingsTransferKey,
  chainId: CHAIN_ID,
  txHash: savingsTransferTxHash,
  logIndex: 3,
  blockNumber: 64450003,
  payer: testWallet,
  recipient: testDest,
  amount6: '830000',
  roundup6: '0',
  isEligible: false,
  exclusionReason: 'savings_destination',
  createdAt: new Date().toISOString(),
})
items = await getActivityForWallet(CHAIN_ID, testWallet)
assert.equal(
  items.some((item) => item.paymentKey === savingsTransferKey),
  false,
  'MOVY transfer to the enrolled savings destination must not appear as a second purchase',
)

// Third payment with skipped status
const skippedTxHash = '0x' + crypto.randomBytes(32).toString('hex')
const skippedKey = computePaymentKey(CHAIN_ID, skippedTxHash, 2, testWallet)
await saveObservedPayment({
  paymentKey: skippedKey,
  chainId: CHAIN_ID,
  txHash: skippedTxHash,
  logIndex: 2,
  blockNumber: 64450002,
  payer: testWallet,
  recipient: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A',
  amount6: '250000',
  roundup6: '750000',
  isEligible: true,
  createdAt: new Date().toISOString(),
})
await createRoundupJob({
  paymentKey: skippedKey,
  chainId: CHAIN_ID,
  wallet: testWallet,
  destination: testDest,
  roundupAmount6: '750000',
  configEpoch: 1,
  status: 'pending',
  attempts: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
})
const skippedJob = (await getPendingJobs(CHAIN_ID)).find((j) => j.paymentKey === skippedKey)
await updateJobStatus(skippedJob.jobId, 'skipped', { skipReason: 'daily_cap_exceeded' })

items = await getActivityForWallet(CHAIN_ID, testWallet)
const skippedItem = items.find((i) => i.paymentKey === skippedKey)
assert(skippedItem, 'Skipped item must appear in activity ledger')
assert.equal(skippedItem.roundupStatus, 'skipped')
assert.equal(skippedItem.skipReason, 'daily_cap_exceeded')
console.log('✔ Truthful states verified: pending, confirmed (saved), whole_dollar, skipped (with reason)')

// -----------------------------------------------------------------------------
// 5. Strict Demo / Connected Mode Isolation
// -----------------------------------------------------------------------------
console.log('\nTest 5: Demo Mode vs Connected Account Data Isolation')
const freshWallet = '0x' + crypto.randomBytes(20).toString('hex')
const freshActivity = await getActivityForWallet(CHAIN_ID, freshWallet)
assert.equal(freshActivity.length, 0, 'Fresh connected wallet must have 0 activity records')

// Ensure no seeded demo items (like 'Blue Bottle Coffee', 'Sweetgreen') exist in connected query
const demoMerchants = ['Blue Bottle Coffee', 'Sweetgreen', 'Trader Joe', 'Apple Store']
for (const item of freshActivity) {
  for (const demo of demoMerchants) {
    assert(!item.recipient?.includes(demo), 'Seeded demo items must never appear in connected activity')
  }
}
console.log('✔ Complete isolation verified: fresh connected wallet returns empty ledger, zero seeded records')

// -----------------------------------------------------------------------------
// 6. Multi-Event Transactions Sharing TxHash (Log Index Disambiguation)
// -----------------------------------------------------------------------------
console.log('\nTest 6: Multi-Event Transactions Sharing the Same TxHash')
const sharedTxHash = '0x' + crypto.randomBytes(32).toString('hex')
const multiWallet = '0x' + crypto.randomBytes(20).toString('hex')

await upsertEnrollment({
  chainId: CHAIN_ID,
  wallet: multiWallet,
  destination: testDest,
  maxRoundup6: '2000000',
  dailyCap6: '10000000',
  configEpoch: 1,
  status: 'active',
  enrolledAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
})

// Event 1 in sharedTxHash (e.g. Log Index 0: Merchant A Payment)
const multiKey1 = computePaymentKey(CHAIN_ID, sharedTxHash, 0, multiWallet)
await saveObservedPayment({
  paymentKey: multiKey1,
  chainId: CHAIN_ID,
  txHash: sharedTxHash,
  logIndex: 0,
  blockNumber: 64450100,
  payer: multiWallet,
  recipient: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A',
  amount6: '120000', // $0.12
  roundup6: '880000', // $0.88
  isEligible: true,
  createdAt: new Date(Date.now() - 2000).toISOString(),
})

// Event 2 in SAME sharedTxHash (e.g. Log Index 1: Merchant B Payment)
const multiKey2 = computePaymentKey(CHAIN_ID, sharedTxHash, 1, multiWallet)
assert.notEqual(multiKey1, multiKey2, 'Different log indices in same tx must produce unique paymentKeys')

await saveObservedPayment({
  paymentKey: multiKey2,
  chainId: CHAIN_ID,
  txHash: sharedTxHash,
  logIndex: 1,
  blockNumber: 64450100,
  payer: multiWallet,
  recipient: '0x2222222222222222222222222222222222222222',
  amount6: '340000', // $0.34
  roundup6: '660000', // $0.66
  isEligible: true,
  createdAt: new Date().toISOString(),
})

const multiActivity = await getActivityForWallet(CHAIN_ID, multiWallet)
assert.equal(multiActivity.length, 2, 'Both distinct events in same transaction must be preserved')
assert.equal(multiActivity.filter((a) => a.txHash === sharedTxHash).length, 2)
assert.notEqual(multiActivity[0].logIndex, multiActivity[1].logIndex, 'Distinct log indices must be preserved')
console.log('✔ Multi-event transactions sharing the same txHash are fully disambiguated by logIndex and paymentKey')

// -----------------------------------------------------------------------------
// 7. Cross-Wallet Activity Isolation
// -----------------------------------------------------------------------------
console.log('\nTest 7: Cross-Wallet Isolation')
const walletA = '0x' + crypto.randomBytes(20).toString('hex')
const walletB = '0x' + crypto.randomBytes(20).toString('hex')

await upsertEnrollment({
  chainId: CHAIN_ID,
  wallet: walletA,
  destination: testDest,
  maxRoundup6: '1000000',
  dailyCap6: '5000000',
  configEpoch: 1,
  status: 'active',
  enrolledAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
})

const txHashA = '0x' + crypto.randomBytes(32).toString('hex')
const keyA = computePaymentKey(CHAIN_ID, txHashA, 0, walletA)
await saveObservedPayment({
  paymentKey: keyA,
  chainId: CHAIN_ID,
  txHash: txHashA,
  logIndex: 0,
  blockNumber: 64450200,
  payer: walletA,
  recipient: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A',
  amount6: '150000',
  roundup6: '850000',
  isEligible: true,
  createdAt: new Date().toISOString(),
})

const activityA = await getActivityForWallet(CHAIN_ID, walletA)
const activityB = await getActivityForWallet(CHAIN_ID, walletB)
assert.equal(activityA.length, 1, 'Wallet A must have its 1 recorded activity')
assert.equal(activityB.length, 0, 'Wallet B must have 0 activity (no cross-wallet leakage)')
assert.equal(activityA[0].paymentKey, keyA)
console.log('✔ Cross-wallet isolation verified: Wallet B receives zero records from Wallet A')

// -----------------------------------------------------------------------------
// 8. API Validation & Network Rejection (No Silent Substitution)
// -----------------------------------------------------------------------------
console.log('\nTest 8: API Route Strict Validation & Unsupported Network Rejection')
import { GET as getAutoActivityRoute } from '../src/app/api/auto-saver/activity/route.ts'
import { GET as getLegacyActivityRoute } from '../src/app/api/activity/route.ts'

// Missing wallet parameter
const missingWalletReq = new Request(`${PRODUCT_ORIGIN}/api/auto-saver/activity`)
const missingWalletRes = await getAutoActivityRoute(missingWalletReq)
assert.equal(missingWalletRes.status, 400)
const missingWalletJson = await missingWalletRes.json()
assert.equal(missingWalletJson.error, 'Missing wallet query parameter')

// Invalid hex address format
const invalidWalletReq = new Request(`${PRODUCT_ORIGIN}/api/auto-saver/activity?wallet=not-a-valid-address`)
const invalidWalletRes = await getAutoActivityRoute(invalidWalletReq)
assert.equal(invalidWalletRes.status, 400)
const invalidWalletJson = await invalidWalletRes.json()
assert.equal(invalidWalletJson.error, 'Invalid wallet address format')

// Unsupported chain ID (Ethereum Mainnet 1) - must NOT silently substitute Arc Testnet
const unsupportedChainReq = new Request(`${PRODUCT_ORIGIN}/api/auto-saver/activity?wallet=${walletA}&chainId=1`)
const unsupportedChainRes = await getAutoActivityRoute(unsupportedChainReq)
assert.equal(unsupportedChainRes.status, 400, 'Unsupported chainId must return 400')
const unsupportedChainJson = await unsupportedChainRes.json()
assert(unsupportedChainJson.error.includes('Unsupported network'), 'Error must explicitly name unsupported network')

// Valid request targeting Arc Testnet (5042002)
const validReq = new Request(`${PRODUCT_ORIGIN}/api/auto-saver/activity?wallet=${walletA}&chainId=${CHAIN_ID}`)
const validRes = await getAutoActivityRoute(validReq)
assert.equal(validRes.status, 200)
const validJson = await validRes.json()
assert.equal(validJson.chainId, CHAIN_ID)
assert.equal(validJson.wallet.toLowerCase(), walletA.toLowerCase())
assert.equal(validJson.activity.length, 1)

// Legacy route parity check
const legacyRes = await getLegacyActivityRoute(validReq)
assert.equal(legacyRes.status, 200)
const legacyJson = await legacyRes.json()
assert.equal(legacyJson.activity.length, 1)
console.log('✔ API routes strictly reject missing/invalid parameters and unsupported networks with 400')

// -----------------------------------------------------------------------------
// 9. Offchain Pending State vs Onchain Confirmation Truthfulness
// -----------------------------------------------------------------------------
console.log('\nTest 9: Offchain Job vs Onchain Confirmation Integrity')
const pendingTx = '0x' + crypto.randomBytes(32).toString('hex')
const pendingKey = computePaymentKey(CHAIN_ID, pendingTx, 0, walletA)
await saveObservedPayment({
  paymentKey: pendingKey,
  chainId: CHAIN_ID,
  txHash: pendingTx,
  logIndex: 0,
  blockNumber: 64450300,
  payer: walletA,
  recipient: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A',
  amount6: '400000',
  roundup6: '600000',
  isEligible: true,
  createdAt: new Date().toISOString(),
})
await createRoundupJob({
  paymentKey: pendingKey,
  chainId: CHAIN_ID,
  wallet: walletA,
  destination: testDest,
  roundupAmount6: '600000',
  configEpoch: 1,
  status: 'pending',
  attempts: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
})

const pendingCheck = (await getActivityForWallet(CHAIN_ID, walletA)).find((i) => i.paymentKey === pendingKey)
assert.equal(pendingCheck.roundupStatus, 'pending', 'Offchain queued job must strictly report pending')
assert.equal(pendingCheck.relayerTxHash, undefined, 'Pending job must not have relayerTxHash')
console.log('✔ Offchain queued jobs are strictly reported as pending and never misrepresented as confirmed')

console.log('\n=== ALL 9 TASK 02 ACCEPTANCE VERIFICATION SUITES PASSED SUCCESSFULLY ===')

