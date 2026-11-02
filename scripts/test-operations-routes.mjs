import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { GET as healthGet } from '../src/app/api/health/route.ts'
import { GET as operationsGet } from '../src/app/api/ops/health/route.ts'
import { GET as cronGet } from '../src/app/api/worker/cron/route.ts'

const PRODUCT_ORIGIN = 'http://localhost:3000'

const health = await healthGet(new Request(`${PRODUCT_ORIGIN}/api/health`))
assert.equal(health.status, 200)
assert.deepEqual(await health.json(), { status: 'ok', database: { ready: true, schemaVersion: 2 } })

const unauthorized = await operationsGet(new Request(`${PRODUCT_ORIGIN}/api/ops/health`))
assert.equal(unauthorized.status, 401, 'operational signals require a bearer token')
const opsToken = randomBytes(32).toString('hex')
process.env.MOVY_OPS_AUTH_TOKEN = opsToken
const authorized = await operationsGet(new Request(`${PRODUCT_ORIGIN}/api/ops/health`, {
  headers: { authorization: `Bearer ${opsToken}` },
}))
assert.equal(authorized.status, 200)
const signals = await authorized.json()
assert.equal(signals.chainId, 5042002)
assert.equal(signals.database.ready, true)
assert.ok('cursors' in signals && 'jobs' in signals && 'workerLeaseActive' in signals)
assert.doesNotMatch(JSON.stringify(signals), /RELAYER_PRIVATE_KEY|DATABASE_URL|0x[a-fA-F0-9]{40,}/,
  'operational signals do not expose connection secrets, signer values, addresses, or transaction hashes')

const oldWorkerEnabled = process.env.MOVY_WORKER_ENABLED
const oldCronSecret = process.env.CRON_SECRET
process.env.MOVY_WORKER_ENABLED = 'false'
process.env.CRON_SECRET = randomBytes(32).toString('hex')
try {
  const badCronAuth = await cronGet(new Request(`${PRODUCT_ORIGIN}/api/worker/cron`))
  assert.equal(badCronAuth.status, 401)
  const disabledCron = await cronGet(new Request(`${PRODUCT_ORIGIN}/api/worker/cron`, {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  }))
  assert.equal(disabledCron.status, 503, 'authenticated schedule requests cannot start a disabled worker')
  assert.equal((await disabledCron.json()).error, 'Worker execution is disabled')
} finally {
  if (oldWorkerEnabled === undefined) delete process.env.MOVY_WORKER_ENABLED
  else process.env.MOVY_WORKER_ENABLED = oldWorkerEnabled
  if (oldCronSecret === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = oldCronSecret
}
console.log('Health, authenticated operations signals, and disabled scheduled-worker route tests passed')
