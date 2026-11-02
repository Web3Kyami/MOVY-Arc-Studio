import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { handleEnrollmentGet, handleEnrollmentPost } from '../src/lib/server/enrollment-api.ts'
import { getRelayerAccount } from '../src/lib/server/relayer.ts'

const PRODUCT_ORIGIN = 'http://localhost:3000'
const wallet = `0x${randomBytes(20).toString('hex')}`
delete process.env.MOVY_TRUST_PROXY_IP_HEADER
const authoritativeEnrollment = { status: 'active', wallet, destination: `0x${randomBytes(20).toString('hex')}` }
const success = async () => ({ enrollment: authoritativeEnrollment, onchainConfig: { enrolled: true } })

let reads = 0
const cachedSync = async () => {
  reads++
  return success()
}
const getRequest = () => new Request(
  `${PRODUCT_ORIGIN}/api/enrollment?wallet=${wallet}&chainId=5042002`,
  { headers: { 'x-real-ip': '198.51.100.17' } }
)
let response = await handleEnrollmentGet(getRequest(), cachedSync)
assert.equal(response.status, 200)
assert.match(response.headers.get('cache-control') ?? '', /private.*max-age/)
response = await handleEnrollmentGet(getRequest(), cachedSync)
assert.equal(reads, 1, 'GET should use a short private cache to avoid repeated onchain RPC reads')

let syncCalls = 0
response = await handleEnrollmentPost(new Request(`${PRODUCT_ORIGIN}/api/enrollment`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-real-ip': '198.51.100.18' },
  body: JSON.stringify({ padding: 'x'.repeat(5_000), chainId: 5042002, wallet }),
}), async () => {
  syncCalls++
  return success()
})
assert.equal(response.status, 413, 'Enrollment POST must reject oversized JSON before parsing or RPC work')
assert.equal(syncCalls, 0)

for (let i = 0; i < 11; i++) {
  response = await handleEnrollmentPost(new Request(`${PRODUCT_ORIGIN}/api/enrollment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '198.51.100.19' },
    body: JSON.stringify({ chainId: 5042002, wallet }),
  }), async () => {
    syncCalls++
    return success()
  })
}
assert.equal(response.status, 429, 'Enrollment POST must throttle repeated sync requests from one wallet')
assert.ok(Number(response.headers.get('retry-after')) > 0)
assert.equal(syncCalls, 10)

for (let i = 0; i < 19; i++) {
  const distinctWallet = `0x${randomBytes(20).toString('hex')}`
  response = await handleEnrollmentPost(new Request(`${PRODUCT_ORIGIN}/api/enrollment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': `198.51.100.${20 + i}` },
    body: JSON.stringify({ chainId: 5042002, wallet: distinctWallet }),
  }), async () => {
    syncCalls++
    return success()
  })
}
assert.equal(response.status, 429, 'Caller-supplied x-real-ip values must not evade the shared fallback limit')
assert.equal(syncCalls, 28)

process.env.MOVY_TRUST_PROXY_IP_HEADER = 'x-real-ip'
let trustedProxySyncCalls = 0
for (let i = 0; i < 31; i++) {
  const distinctWallet = `0x${randomBytes(20).toString('hex')}`
  response = await handleEnrollmentPost(new Request(`${PRODUCT_ORIGIN}/api/enrollment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '198.51.100.200' },
    body: JSON.stringify({ chainId: 5042002, wallet: distinctWallet }),
  }), async () => {
    trustedProxySyncCalls++
    return success()
  })
}
assert.equal(response.status, 429, 'An explicitly trusted proxy IP must be throttled across wallets')
assert.equal(trustedProxySyncCalls, 30)

const previousRelayerKey = process.env.RELAYER_PRIVATE_KEY
const previousDeployerKey = process.env.MOVY_DEPLOYER_KEY
delete process.env.RELAYER_PRIVATE_KEY
process.env.MOVY_DEPLOYER_KEY = `0x${randomBytes(32).toString('hex')}`
try {
  assert.equal(getRelayerAccount(), null, 'The deployment key must never activate the relayer')
} finally {
  if (previousRelayerKey === undefined) delete process.env.RELAYER_PRIVATE_KEY
  else process.env.RELAYER_PRIVATE_KEY = previousRelayerKey
  if (previousDeployerKey === undefined) delete process.env.MOVY_DEPLOYER_KEY
  else process.env.MOVY_DEPLOYER_KEY = previousDeployerKey
}

console.log('Enrollment abuse-control and dedicated relayer configuration tests passed')
