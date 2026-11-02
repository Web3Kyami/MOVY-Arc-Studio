import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  EnrollmentBackendSyncError,
  isEnrollmentSyncReliable,
  isRevocationSyncReliable,
  syncEnrollmentWithRetry,
  waitForSuccessfulReceipt,
} from '../src/lib/enrollment-activation.ts'

const expectedWallet = '0x1111111111111111111111111111111111111111'
const onchainConfig = { enrolled: true, paused: false, configEpoch: 2 }
const activeRecord = { status: 'active', wallet: expectedWallet, chainId: 5042002, configEpoch: 2 }
assert.equal(isEnrollmentSyncReliable(onchainConfig, null, expectedWallet, 5042002), false)
assert.equal(isEnrollmentSyncReliable(onchainConfig, { ...activeRecord, status: 'revoked' }, expectedWallet, 5042002), false)
assert.equal(isEnrollmentSyncReliable(onchainConfig, { ...activeRecord, wallet: '0x2222222222222222222222222222222222222222' }, expectedWallet, 5042002), false)
assert.equal(isEnrollmentSyncReliable(onchainConfig, { ...activeRecord, chainId: 5042 }, expectedWallet, 5042002), false)
assert.equal(isEnrollmentSyncReliable(onchainConfig, { ...activeRecord, configEpoch: 1 }, expectedWallet, 5042002), false)
assert.equal(isEnrollmentSyncReliable(onchainConfig, activeRecord, expectedWallet, 5042002), true)
assert.equal(isEnrollmentSyncReliable({ ...onchainConfig, paused: true }, { ...activeRecord, status: 'paused' }, expectedWallet, 5042002), true)
assert.equal(isEnrollmentSyncReliable({ ...onchainConfig, enrolled: false }, activeRecord, expectedWallet, 5042002), false)
assert.equal(isRevocationSyncReliable({ enrolled: false, configEpoch: 3 }, { ...activeRecord, status: 'revoked', configEpoch: 3 }, expectedWallet, 5042002), true)
assert.equal(isRevocationSyncReliable({ enrolled: false, configEpoch: 3 }, { ...activeRecord, status: 'revoked', configEpoch: 2 }, expectedWallet, 5042002), false)

let resolveReceipt
let completed = false
const delayedReceipt = new Promise((resolve) => { resolveReceipt = resolve })
const confirmation = waitForSuccessfulReceipt('0xconfirmed', () => delayedReceipt).then(() => { completed = true })
await Promise.resolve()
assert.equal(completed, false, 'Activation must wait until the transaction receipt resolves')
resolveReceipt({ status: 'success' })
await confirmation
assert.equal(completed, true)

await assert.rejects(
  () => waitForSuccessfulReceipt('0xreverted', async () => ({ status: 'reverted' })),
  /reverted.*not confirmed/i,
  'A reverted receipt must stop activation'
)

let syncCalls = 0
const enrollment = await syncEnrollmentWithRetry(async () => {
  syncCalls++
  if (syncCalls === 1) return new Response(JSON.stringify({ error: 'not yet indexed' }), { status: 409 })
  if (syncCalls === 2) return new Response(JSON.stringify({ error: 'temporary RPC failure' }), { status: 503 })
  return new Response(JSON.stringify({
    success: true,
    enrollment: { status: 'active', wallet: '0x1111111111111111111111111111111111111111' },
  }), { status: 200 })
}, { attempts: 3, delay: async () => {} })
assert.equal(syncCalls, 3, '409 and 503 enrollment synchronization should be retried')
assert.equal(enrollment.status, 'active')

const revoked = await syncEnrollmentWithRetry(async () => new Response(JSON.stringify({
  success: true,
  enrollment: { status: 'revoked' },
}), { status: 200 }), { allowedStatuses: ['revoked'], delay: async () => {} })
assert.equal(revoked.status, 'revoked', 'A confirmed revoke must accept the authoritative revoked record')

for (const status of [409, 503]) {
  await assert.rejects(
    () => syncEnrollmentWithRetry(async () => new Response(JSON.stringify({ error: 'temporary' }), { status }), {
      attempts: 2,
      delay: async () => {},
    }),
    (error) => error instanceof EnrollmentBackendSyncError && error.retryable,
    `${status} sync errors must remain retryable after bounded retries`
  )
}

const saverHook = readFileSync(new URL('../src/hooks/use-auto-saver.ts', import.meta.url), 'utf8')
const onboardingFlow = readFileSync(new URL('../src/components/movy/onboarding/onboarding-flow.tsx', import.meta.url), 'utf8')
assert.match(saverHook, /waitForSuccessfulReceipt/)
assert.match(saverHook, /syncEnrollmentWithRetry/)
assert.match(saverHook, /isEnrollmentSyncReliable/)
assert.match(saverHook, /publicClient\.readContract\([\s\S]*?functionName: 'getUserConfig'/)
assert.match(saverHook, /isRevocationSyncReliable/)
assert.match(saverHook, /const setUsdcAllowance[\s\S]*?applyAllowanceTargetAndConfirm/)
assert.match(saverHook, /const setUsdcAllowance[\s\S]*?syncBackend/)
assert.match(onboardingFlow, /retryBackendSync/)
assert.doesNotMatch(onboardingFlow, /Active \(ON\)/, 'Onboarding must not claim saving is active before backend confirmation')

console.log('Receipt confirmation and enrollment sync retry tests passed')
