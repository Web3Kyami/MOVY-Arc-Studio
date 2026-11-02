import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { handleWorkerTick, MAX_WORKER_BLOCKS } from '../src/lib/server/worker-api.ts'
import { assertWorkerExecutionLimits } from '../src/lib/server/worker-limits.ts'
import { getRelayerAccount, processPendingJobs } from '../src/lib/server/relayer.ts'
import { createRoundupJob, getPendingJobs, saveObservedPayment } from '../src/lib/server/db.ts'
import { handleEnrollmentGet, handleEnrollmentPost } from '../src/lib/server/enrollment-api.ts'
import { syncEnrollmentFromChain } from '../src/lib/server/enrollment-sync.ts'

const PRODUCT_ORIGIN = 'http://localhost:3000'
const token = randomBytes(32).toString('hex')
process.env.MOVY_WORKER_ENABLED = 'true'
const validWallet = '0x1111111111111111111111111111111111111111'
const calls = []
const runCycle = async (...args) => {
  calls.push(args)
  return { observerResult: { processedBlocks: 1 }, relayerResult: { processed: 0 } }
}

function request(body, authorization) {
  const headers = { 'content-type': 'application/json' }
  if (authorization) headers.authorization = authorization
  return new Request(`${PRODUCT_ORIGIN}/api/worker/tick`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

async function workerResponse(body, authorization, configuredToken = token) {
  return handleWorkerTick(request(body, authorization), runCycle, configuredToken)
}

let response = await handleWorkerTick(request({}, undefined), runCycle, undefined)
assert.equal(response.status, 503, 'Worker API must fail closed when its auth token is not configured')
assert.equal(calls.length, 0, 'Unconfigured worker API must not start a cycle')

response = await workerResponse({}, undefined)
assert.equal(response.status, 401, 'Worker API must reject requests without authorization')
assert.equal(calls.length, 0, 'Unauthorized worker API must not start a cycle')

response = await workerResponse({}, 'Bearer wrong-token')
assert.equal(response.status, 401, 'Worker API must reject an incorrect authorization token')
assert.equal(calls.length, 0, 'Incorrect token must not start a cycle')

response = await workerResponse({ chainId: 5042 }, `Bearer ${token}`)
assert.equal(response.status, 400, 'Worker API must reject mainnet')
assert.equal(calls.length, 0, 'Wrong-chain request must not start a cycle')

response = await workerResponse({ maxBlocks: MAX_WORKER_BLOCKS + 1 }, `Bearer ${token}`)
assert.equal(response.status, 400, 'Worker API must reject block ranges over the hard limit')
assert.equal(calls.length, 0, 'Over-limit request must not start a cycle')

response = await workerResponse({ maxBlocks: 0 }, `Bearer ${token}`)
assert.equal(response.status, 400, 'Worker API must reject a zero block range')

response = await workerResponse({ maxBlocks: 1.5 }, `Bearer ${token}`)
assert.equal(response.status, 400, 'Worker API must reject a fractional block range')

response = await workerResponse({ targetWallet: 'not-an-address' }, `Bearer ${token}`)
assert.equal(response.status, 400, 'Worker API must reject an invalid target wallet')

response = await workerResponse({ unexpected: true }, `Bearer ${token}`)
assert.equal(response.status, 400, 'Worker API must reject unsupported fields instead of ignoring them')

response = await workerResponse({ padding: 'x'.repeat(5_000) }, `Bearer ${token}`)
assert.equal(response.status, 413, 'Worker API must bound request bodies even without Content-Length')
assert.equal(calls.length, 0, 'Invalid worker inputs must never start a cycle')

response = await workerResponse({ chainId: 5042002, maxBlocks: 500, targetWallet: validWallet }, `Bearer ${token}`)
assert.equal(response.status, 200, 'Authorized Arc Testnet request within limits should run')
assert.deepEqual(calls.at(-1), [5042002, { maxBlocks: 500, targetWallet: validWallet }])

response = await workerResponse({}, `Bearer ${token}`)
assert.equal(response.status, 200, 'Authorized request may use safe defaults')
assert.deepEqual(calls.at(-1), [5042002, { maxBlocks: MAX_WORKER_BLOCKS }])

assert.doesNotThrow(() => assertWorkerExecutionLimits(5042002, MAX_WORKER_BLOCKS))
assert.throws(() => assertWorkerExecutionLimits(5042, 1), /Arc Testnet/)
assert.throws(() => assertWorkerExecutionLimits(5042002, MAX_WORKER_BLOCKS + 1), /maxBlocks/)

assert.equal(getRelayerAccount(null), null, 'Missing signer configuration must not select an embedded account')
assert.equal(getRelayerAccount('invalid'), null, 'Invalid signer configuration must fail safely')
const proofScript = readFileSync(new URL('./prove-auto-saver-testnet.ts', import.meta.url), 'utf8')
const deploymentScript = readFileSync(new URL('./deploy-auto-saver-testnet.mjs', import.meta.url), 'utf8')
assert.match(proofScript, /process\.env\.RELAYER_PRIVATE_KEY/, 'Manual relayer proof uses its dedicated signer identity')
assert.doesNotMatch(proofScript, /MOVY_DEPLOYER_KEY|\|\|\s*'0x[a-fA-F0-9]{64}'/, 'Proof script must not reuse or embed a deployment signer')
assert.match(deploymentScript, /process\.env\.MOVY_DEPLOYER_KEY/, 'Deployment remains controlled by a separate deployment identity')
assert.doesNotMatch(deploymentScript, /MOVY_DEPLOYER_KEY\s*\|\|/, 'Deployment script has no embedded key fallback')

const wallet = `0x${randomBytes(20).toString('hex')}`
const paymentHash = `0x${randomBytes(32).toString('hex')}`
const destination = `0x${randomBytes(20).toString('hex')}`
const now = new Date().toISOString()
await saveObservedPayment({
  paymentKey: paymentHash,
  chainId: 5042002,
  txHash: paymentHash,
  logIndex: 0,
  blockNumber: 1,
  payer: wallet,
  recipient: destination,
  amount6: '170000',
  roundup6: '830000',
  isEligible: true,
  createdAt: now,
})
await createRoundupJob({
  paymentKey: paymentHash,
  chainId: 5042002,
  wallet,
  destination,
  roundupAmount6: '830000',
  configEpoch: 1,
  status: 'pending',
  attempts: 0,
  createdAt: now,
  updatedAt: now,
})
const savedRelayerKey = process.env.RELAYER_PRIVATE_KEY
const savedDeployerKey = process.env.MOVY_DEPLOYER_KEY
delete process.env.RELAYER_PRIVATE_KEY
delete process.env.MOVY_DEPLOYER_KEY
try {
  const deferred = await processPendingJobs(5042002)
  assert.equal(deferred.deferred, 1, 'Pending jobs must remain deferred when no signer is configured')
  assert.equal((await getPendingJobs(5042002)).find((job) => job.paymentKey === paymentHash)?.status, 'pending')

  await assert.rejects(() => processPendingJobs(5042), /Arc Testnet/)

  const { GET: getStatus } = await import('../src/app/api/status/route.ts')
  const statusResponse = await getStatus(new Request(`${PRODUCT_ORIGIN}/api/status`))
  assert.equal(statusResponse.status, 200, 'Read-only status endpoint must work without relayer configuration')
  const statusBody = await statusResponse.json()
  assert.equal(statusBody.relayerAddress, null)
  assert.equal(statusBody.relayerConfigured, false)
} finally {
  if (savedRelayerKey === undefined) delete process.env.RELAYER_PRIVATE_KEY
  else process.env.RELAYER_PRIVATE_KEY = savedRelayerKey
  if (savedDeployerKey === undefined) delete process.env.MOVY_DEPLOYER_KEY
  else process.env.MOVY_DEPLOYER_KEY = savedDeployerKey
}

const activityHookSource = readFileSync(new URL('../src/hooks/use-auto-activity.ts', import.meta.url), 'utf8')
assert.doesNotMatch(activityHookSource, /\/api\/worker\/tick|triggerTick/)

const enrollmentWallet = `0x${randomBytes(20).toString('hex')}`
const chainDestination = `0x${randomBytes(20).toString('hex')}`
const forgedDestination = `0x${randomBytes(20).toString('hex')}`
const chainConfig = {
  destination: chainDestination,
  maxRoundup6: 250_000n,
  dailyCap6: 2_000_000n,
  configEpoch: 7,
  paused: true,
  enrolled: true,
}
let readConfigCalls = 0
let savedEnrollment
const sync = (chainId, address) => syncEnrollmentFromChain(chainId, address, {
  readConfig: async (requestedChain, requestedWallet) => {
    readConfigCalls++
    assert.equal(requestedChain, 5042002)
    assert.equal(requestedWallet, enrollmentWallet)
    return chainConfig
  },
  getExisting: () => savedEnrollment ?? null,
  upsert: (record) => { savedEnrollment = record },
  now: () => '2026-10-08T00:00:00.000Z',
})
const enrollmentRequest = new Request(`${PRODUCT_ORIGIN}/api/enrollment`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    chainId: 5042002,
    wallet: enrollmentWallet,
    destination: forgedDestination,
    maxRoundup6: '999999999999',
    dailyCap6: '999999999999',
    configEpoch: 999,
    status: 'active',
  }),
})
response = await handleEnrollmentPost(enrollmentRequest, sync)
assert.equal(response.status, 200)
assert.equal(readConfigCalls, 1, 'POST must read the wallet configuration from Arc Testnet')
assert.equal(savedEnrollment.destination, chainDestination, 'POST must persist the onchain destination')
assert.equal(savedEnrollment.maxRoundup6, '250000')
assert.equal(savedEnrollment.dailyCap6, '2000000')
assert.equal(savedEnrollment.configEpoch, 7)
assert.equal(savedEnrollment.status, 'paused')

response = await handleEnrollmentPost(new Request(`${PRODUCT_ORIGIN}/api/enrollment`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ chainId: 5042002, wallet: 'not-a-wallet', destination: forgedDestination }),
}), sync)
assert.equal(response.status, 400, 'Enrollment API must reject an invalid wallet address')
assert.equal(readConfigCalls, 1, 'Invalid wallet must not trigger an onchain read')

response = await handleEnrollmentPost(new Request(`${PRODUCT_ORIGIN}/api/enrollment`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ chainId: 5042, wallet: enrollmentWallet }),
}), sync)
assert.equal(response.status, 400, 'Enrollment API must reject non-Testnet chain IDs')
assert.equal(readConfigCalls, 1, 'Invalid chain must not trigger an onchain read')

chainConfig.destination = '0x0000000000000000000000000000000000000000'
chainConfig.maxRoundup6 = 0n
chainConfig.dailyCap6 = 0n
chainConfig.configEpoch = 8
chainConfig.paused = false
chainConfig.enrolled = false
response = await handleEnrollmentPost(new Request(`${PRODUCT_ORIGIN}/api/enrollment`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ chainId: 5042002, wallet: enrollmentWallet }),
}), sync)
assert.equal(response.status, 200, 'POST must return the authoritative revoked record so sync callers can confirm revocation')
assert.equal(savedEnrollment.status, 'revoked')
assert.equal(savedEnrollment.destination, chainConfig.destination, 'Revoked records must also be reconciled to onchain values')
assert.equal(savedEnrollment.maxRoundup6, '0')
assert.equal(savedEnrollment.configEpoch, 8)

response = await handleEnrollmentGet(
  new Request(`${PRODUCT_ORIGIN}/api/enrollment?wallet=not-a-wallet&chainId=5042002`),
  async () => { throw new Error('must not be called') }
)
assert.equal(response.status, 400, 'GET must reject invalid wallet addresses before querying chain state')

const staleGetResponse = await handleEnrollmentGet(
  new Request(`${PRODUCT_ORIGIN}/api/enrollment?wallet=${enrollmentWallet}&chainId=5042002`),
  async () => { throw new Error('rpc unavailable') }
)
assert.equal(staleGetResponse.status, 503, 'GET must not report stored enrollment when onchain state cannot be verified')

console.log('P0 security regression tests passed')
