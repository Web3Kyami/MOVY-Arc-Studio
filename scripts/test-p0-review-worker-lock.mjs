import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { handleWorkerTick } from '../src/lib/server/worker-api.ts'
import { withWorkerLock } from '../src/lib/server/worker-lock.ts'
import {
  getCursor,
  releaseWorkerLock,
  setCursor,
  tryAcquireWorkerLock,
} from '../src/lib/server/db.ts'

const PRODUCT_ORIGIN = 'http://localhost:3000'
const token = 'worker-test-token-0123456789abcdef0123456789abcdef'
const request = () => new Request(`${PRODUCT_ORIGIN}/api/worker/tick`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ chainId: 5042002, maxBlocks: 1 }),
})

const savedWorkerEnabled = process.env.MOVY_WORKER_ENABLED
delete process.env.MOVY_WORKER_ENABLED
let disabledCycleCount = 0
const disabledResponse = await handleWorkerTick(request(), async () => { disabledCycleCount++ }, token)
assert.equal(disabledResponse.status, 503, 'Authenticated requests must not activate a disabled worker')
assert.equal(disabledCycleCount, 0, 'A disabled worker request must not start a cycle')
if (savedWorkerEnabled === undefined) delete process.env.MOVY_WORKER_ENABLED
else process.env.MOVY_WORKER_ENABLED = savedWorkerEnabled
process.env.MOVY_WORKER_ENABLED = 'true'

let releaseFirst
let cycleCount = 0
let signalFirstStarted
const firstStarted = new Promise((resolve) => { signalFirstStarted = resolve })
const firstCycle = () => withWorkerLock(async () => {
  cycleCount++
  signalFirstStarted()
  await new Promise((resolve) => { releaseFirst = resolve })
  return { finished: true }
})
const first = handleWorkerTick(request(), firstCycle, token)
await firstStarted
const overlapping = await handleWorkerTick(request(), firstCycle, token)
assert.equal(overlapping.status, 409, 'A second authorized tick must be rejected while one holds the durable lock')
assert.equal(cycleCount, 1, 'Only one concurrent worker cycle may execute')
releaseFirst()
assert.equal((await first).status, 200)

await assert.rejects(
  () => withWorkerLock(async () => { throw new Error('injected cycle failure') }),
  /injected cycle failure/
)
assert.equal(await withWorkerLock(async () => 'recovered'), 'recovered', 'A failed cycle must release its lock')
const lostLeaseResponse = await handleWorkerTick(request(), () => withWorkerLock(async (lock) => {
  await releaseWorkerLock(lock.token)
  await setCursor(5042004, 10, lock.token)
}), token)
assert.equal(lostLeaseResponse.status, 503, 'A fenced stale write must be reported as a lost worker lease')
await setCursor(5042002, 100)
await setCursor(5042002, 90)
assert.equal(await getCursor(5042002), 100, 'Cursor writes must never move backwards')

const lockNow = Date.now()
const staleFence = await tryAcquireWorkerLock('fencing-test', 1_000, lockNow)
assert.ok(staleFence)
const currentFence = await tryAcquireWorkerLock('fencing-test', 1_000, lockNow + 1_001)
assert.ok(currentFence, 'An expired lease can be taken over with a newer fencing token')
assert.ok(currentFence.fencingToken > staleFence.fencingToken)
await assert.rejects(
  () => setCursor(5042003, 200, staleFence),
  /Worker lock lease is no longer active/,
  'A stale worker must not write after another process takes over its lease'
)
await setCursor(5042003, 150, currentFence)
assert.equal(await getCursor(5042003), 150)
await releaseWorkerLock(currentFence)

const workerSource = readFileSync(new URL('../src/lib/server/worker.ts', import.meta.url), 'utf8')
const routeSource = readFileSync(new URL('../src/app/api/worker/tick/route.ts', import.meta.url), 'utf8')
assert.match(workerSource, /withWorkerLock/)
assert.match(workerSource, /workerLock: lock\.token/)
assert.match(routeSource, /runWorkerCycle/)

console.log('Worker concurrency, recovery, and cursor monotonicity tests passed')
