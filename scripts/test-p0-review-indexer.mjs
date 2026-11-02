import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  getEnrollment,
  getEnrollmentHistoryAtPosition,
  getEnrollmentHistoryCursor,
  getLatestEnrollmentHistoryState,
  setEnrollmentHistoryCursor,
  upsertEnrollment,
  upsertEnrollmentHistoryState,
} from '../src/lib/server/db.ts'
import { processEnrollmentHistoryWindow } from '../src/lib/server/enrollment-history.ts'
import { syncEnrollmentFromChain } from '../src/lib/server/enrollment-sync.ts'

const wallet = `0x${randomBytes(20).toString('hex')}`
const firstDestination = `0x${randomBytes(20).toString('hex')}`
const secondDestination = `0x${randomBytes(20).toString('hex')}`
let currentBlock = 105
let events = [{
  kind: 'enrolled',
  wallet,
  blockNumber: 101,
  logIndex: 4,
  destination: firstDestination,
  maxRoundup6: '1000000',
  dailyCap6: '5000000',
  configEpoch: 1,
}]
let failSync = false
let syncCount = 0
let latestConfig = {
  destination: firstDestination,
  maxRoundup6: 1_000_000n,
  dailyCap6: 5_000_000n,
  configEpoch: 1,
  paused: false,
  enrolled: true,
}

const dependencies = {
  getCurrentBlock: async () => currentBlock,
  getCursor: getEnrollmentHistoryCursor,
  getDeployBlock: () => 100,
  getEvents: async (chainId, fromBlock, toBlock) => {
    assert.equal(chainId, 5042002)
    if (fromBlock === 100) assert.equal(toBlock, 105)
    else if (fromBlock === 106) assert.equal(toBlock, 115)
    else {
      assert.equal(fromBlock, 116)
      assert.equal(toBlock, 125)
    }
    return events
  },
  getStateBeforePosition: getEnrollmentHistoryAtPosition,
  saveState: upsertEnrollmentHistoryState,
  syncWallet: async (chainId, address) => {
    syncCount++
    if (failSync) throw new Error('temporary onchain read failure')
    await syncEnrollmentFromChain(chainId, address, {
      readConfig: async () => latestConfig,
      getExisting: getEnrollment,
      upsert: upsertEnrollment,
      now: () => '2026-10-08T00:00:00.000Z',
    })
  },
  setCursor: setEnrollmentHistoryCursor,
}

const first = await processEnrollmentHistoryWindow(5042002, 10, dependencies)
assert.equal(first.processedBlocks, 6)
assert.equal(first.savedEvents, 1)
assert.equal(await getEnrollmentHistoryCursor(5042002), 105)
assert.equal((await getEnrollment(5042002, wallet))?.status, 'active', 'Event indexing must recover enrollment state after the browser is gone')
assert.equal((await getEnrollmentHistoryAtPosition(5042002, wallet, 105, 9))?.status, 'active')

const duplicate = await processEnrollmentHistoryWindow(5042002, 10, dependencies)
assert.equal(duplicate.processedBlocks, 0)
assert.equal(syncCount, 1, 'A processed event window must not repeatedly sync the same enrollment')

events = [{
  kind: 'config-updated',
  wallet,
  blockNumber: 110,
  logIndex: 2,
  destination: secondDestination,
  maxRoundup6: '900000',
  dailyCap6: '8000000',
  configEpoch: 2,
}]
latestConfig = { ...latestConfig, destination: secondDestination, maxRoundup6: 900_000n, dailyCap6: 8_000_000n, configEpoch: 2 }
currentBlock = 115
const updated = await processEnrollmentHistoryWindow(5042002, 10, dependencies)
assert.equal(updated.savedEvents, 1)
assert.equal((await getLatestEnrollmentHistoryState(5042002, wallet))?.configEpoch, 2)
assert.equal((await getEnrollmentHistoryAtPosition(5042002, wallet, 110, 1))?.configEpoch, 1, 'A payment before the config event uses the previous epoch')
assert.equal((await getEnrollmentHistoryAtPosition(5042002, wallet, 110, 3))?.destination, secondDestination)
assert.equal((await getEnrollment(5042002, wallet))?.configEpoch, 2, 'The current enrollment row remains synchronized to chain state')

events = [
  {
    kind: 'config-updated',
    wallet,
    blockNumber: 120,
    logIndex: 1,
    destination: firstDestination,
    maxRoundup6: '800000',
    dailyCap6: '7000000',
    configEpoch: 3,
  },
  {
    kind: 'pause-toggled',
    wallet,
    blockNumber: 122,
    logIndex: 2,
    paused: true,
  },
]
latestConfig = { ...latestConfig, maxRoundup6: 800_000n, dailyCap6: 7_000_000n, configEpoch: 3, paused: true }
currentBlock = 125
failSync = true
await assert.rejects(() => processEnrollmentHistoryWindow(5042002, 10, dependencies), /temporary onchain read failure/)
assert.equal(await getEnrollmentHistoryCursor(5042002), 115, 'A failed current-state sync must not advance the history cursor')
failSync = false
const recovered = await processEnrollmentHistoryWindow(5042002, 10, dependencies)
assert.equal(recovered.savedEvents, 2)
assert.equal(await getEnrollmentHistoryCursor(5042002), 125, 'Retry must safely replay a partially stored window')
assert.equal((await getLatestEnrollmentHistoryState(5042002, wallet))?.status, 'paused')
assert.equal(
  (await getEnrollmentHistoryAtPosition(5042002, wallet, 121, 0))?.status,
  'active',
  'A retry must not copy a later pause backward into the preceding config snapshot'
)

const workerSource = readFileSync(new URL('../src/lib/server/worker.ts', import.meta.url), 'utf8')
const indexerSource = readFileSync(new URL('../src/lib/server/enrollment-indexer.ts', import.meta.url), 'utf8')
assert.match(workerSource, /processEnrollmentEvents/, 'The durable event indexer must run without a browser tab')
assert.match(indexerSource, /processEnrollmentHistoryWindow/, 'Production indexing must retain historical event state')

console.log('Enrollment event recovery and historical state indexing tests passed')
