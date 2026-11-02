// Offline behavior check for the real useAutoSaver hook.
// Run from the project root with Node 24:
// node --experimental-test-module-mocks --import tsx --disable-warning=ExperimentalWarning scripts/test-auto-saver-global-pause-hook.mjs
// Only the Wagmi and React Query provider boundaries are mocked. No network,
// wallet, database, transaction, deployment, or worker is used.
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import { mock } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)))
const hookPath = path.join(projectRoot, 'src/hooks/use-auto-saver.ts')
const file = (p) => pathToFileURL(path.resolve(p)).href
const require = createRequire(path.join(projectRoot, 'package.json'))
const React = require('react')
const { act, create } = require('react-test-renderer')

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Use the projectRoot's selected Arc Testnet build configuration, with a
// deterministic test address. These are local fixture values, not credentials.
process.env.NEXT_PUBLIC_MOVY_TARGET_NETWORK = 'testnet'
process.env.NEXT_PUBLIC_MOVY_CHAIN_ID = '5042002'
process.env.NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET = '0x3333333333333333333333333333333333333333'

const OWNER_A = '0x1111111111111111111111111111111111111111'
const OWNER_B = '0x2222222222222222222222222222222222222222'
const TEST_CONTRACT = process.env.NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET

let wallet = { address: OWNER_A, isConnected: true, chainId: 5_042_002 }
let reads = Object.create(null)
const readCalls = []
const readResults = []
const refetchCounts = Object.create(null)
let enrollmentQueryOptions

const emptyRead = {
  data: undefined,
  isLoading: false,
  isFetching: false,
  isStale: false,
  isError: false,
  error: undefined,
}
const useReadContract = (options) => {
  readCalls.push(options)
  const state = { ...emptyRead, ...(reads[options.functionName] ?? {}) }
  readResults.push({ functionName: options.functionName, state })
  return {
    ...state,
    refetch: async () => {
      refetchCounts[options.functionName] = (refetchCounts[options.functionName] ?? 0) + 1
      return { data: reads[options.functionName]?.data }
    },
  }
}

// Mock the provider boundaries while the copied test runs in projectRoot's
// package context, so its TypeScript paths and dependencies resolve normally.
mock.module('wagmi', {
  exports: {
    useAccount: () => wallet,
    usePublicClient: () => null,
    useReadContract,
    useWriteContract: () => ({ writeContractAsync: async () => { throw new Error('unexpected write') } }),
    useWaitForTransactionReceipt: () => ({ isLoading: false }),
  },
})
mock.module('@tanstack/react-query', {
  exports: {
    useQuery: (options) => {
      enrollmentQueryOptions = options
      return { data: null, isLoading: false, isError: false, error: undefined, refetch: async () => ({ data: null }) }
    },
    useQueryClient: () => ({
      setQueryData() {},
      invalidateQueries: async () => {},
    }),
  },
})

const { ACTIVE_CHAIN_ID } = await import(file(path.join(projectRoot, 'src/lib/chain.ts')))
const { useAutoSaver } = await import(file(hookPath))
assert.equal(ACTIVE_CHAIN_ID, 5_042_002, 'the projectRoot fixture selects Arc Testnet')

let latest
function Probe({ enabled = true }) {
  latest = useAutoSaver({ enabled })
  return null
}
let renderer
function mount(props = {}) {
  act(() => { renderer = create(React.createElement(Probe, props)) })
}
function update(props = {}) {
  act(() => renderer.update(React.createElement(Probe, props)))
}
function lastRead(functionName) {
  return [...readCalls].reverse().find((read) => read.functionName === functionName)
}
function lastReadResult(functionName) {
  return [...readResults].reverse().find((read) => read.functionName === functionName)?.state
}
function setGlobalRead(state) {
  reads = { ...reads, paused: state }
  update(currentProps)
}
let currentProps = { enabled: true }
function renderUpdate(props) {
  currentProps = props
  update(props)
}

// A connected wallet on the selected network gets an enabled paused() read at
// the configured contract address and selected chain.
reads = { paused: { data: undefined, isLoading: true, isError: false, error: undefined } }
mount(currentProps)
assert.equal(latest.contractAddress, TEST_CONTRACT)
assert.deepEqual(latest.globalPause, { status: 'loading' })
let pausedRead = lastRead('paused')
assert.ok(pausedRead, 'the hook issues a separate paused() contract read')
assert.equal(pausedRead.address, TEST_CONTRACT)
assert.equal(pausedRead.chainId, ACTIVE_CHAIN_ID)
assert.equal(pausedRead.functionName, 'paused')
assert.equal(pausedRead.args, undefined, 'paused() has no arguments')
assert.equal(pausedRead.query.enabled, true)
assert.equal(pausedRead.query.refetchInterval, 5_000)
assert.equal(enrollmentQueryOptions.queryKey[1], OWNER_A)

// Known values are reported through the real hook resolver.
setGlobalRead({ data: false, isLoading: false, isError: false, error: undefined })
assert.deepEqual(latest.globalPause, { status: 'running' })
setGlobalRead({ data: true, isLoading: false, isError: false, error: undefined })
assert.deepEqual(latest.globalPause, { status: 'paused' })

// TanStack can retain old `data` on a failed refetch. The hook must surface the
// error instead of reusing a stale prior `false` as proof the service runs.
setGlobalRead({ data: false, isLoading: false, isError: true, error: new Error('read failed') })
assert.deepEqual(latest.globalPause, { status: 'error', message: 'Saving status is unavailable. Try again.' })
setGlobalRead({ data: false, isLoading: false, isError: false, error: undefined })
assert.deepEqual(latest.globalPause, { status: 'running' }, 'a successful read recovers from error')

// The dedicated retry and aggregate refresh both re-read paused().
const beforeDedicatedRefetch = refetchCounts.paused ?? 0
latest.refetchGlobalPause()
assert.equal(refetchCounts.paused, beforeDedicatedRefetch + 1)
const beforeAggregateRefetch = refetchCounts.paused
latest.refetch()
assert.equal(refetchCounts.paused, beforeAggregateRefetch + 1, 'aggregate refetch includes paused()')
assert.equal(refetchCounts.allowance, 1)
assert.equal(refetchCounts.getUserConfig, 1)
assert.equal(refetchCounts.getRemainingDailyAllowance, 1)

// When any applicability condition fails, cached values are ignored and the
// query is disabled. Exercise the enabled flag, disconnect, and wrong network.
reads = { ...reads, paused: { data: true, isLoading: false, isError: false, error: undefined } }
renderUpdate({ enabled: false })
assert.deepEqual(latest.globalPause, { status: 'idle' }, 'disabled hook discards cached global value')
assert.equal(lastRead('paused').query.enabled, false)

wallet = { address: undefined, isConnected: false, chainId: ACTIVE_CHAIN_ID }
renderUpdate({ enabled: true })
assert.deepEqual(latest.globalPause, { status: 'idle' }, 'disconnected wallet discards cached global value')
assert.equal(lastRead('paused').query.enabled, false)

wallet = { address: OWNER_B, isConnected: true, chainId: ACTIVE_CHAIN_ID + 1 }
renderUpdate({ enabled: true })
assert.deepEqual(latest.globalPause, { status: 'idle' }, 'wrong network discards cached global value')
assert.equal(lastRead('paused').query.enabled, false)
assert.equal(lastRead('paused').chainId, ACTIVE_CHAIN_ID, 'read remains pinned to the selected chain')

// Forcing data to undefined checks the explicit loading path. It does not model
// a refetch that retains stale cached data, which is covered separately below.
wallet = { address: OWNER_B, isConnected: true, chainId: ACTIVE_CHAIN_ID }
reads = { ...reads, paused: { data: undefined, isLoading: true, isError: false, error: undefined } }
renderUpdate({ enabled: true })
assert.deepEqual(latest.globalPause, { status: 'loading' })
assert.equal(lastRead('paused').query.enabled, true)
assert.equal(enrollmentQueryOptions.queryKey[1], OWNER_B)
setGlobalRead({ data: false, isLoading: false, isError: false, error: undefined })
assert.deepEqual(latest.globalPause, { status: 'running' }, 'a current-context read recovers from idle')

act(() => renderer.unmount())

// Separate reconnect regression: a successful old `false` remains cached while
// the connected read is fetching and stale. That value must stay unknown until
// a successful read for the current connection completes.
wallet = { address: OWNER_A, isConnected: true, chainId: ACTIVE_CHAIN_ID }
reads = {
  paused: {
    data: false,
    isLoading: false,
    isFetching: false,
    isStale: false,
    isError: false,
    error: undefined,
  },
}
currentProps = { enabled: true }
mount(currentProps)
assert.deepEqual(latest.globalPause, { status: 'running' }, 'first successful false read is running')

wallet = { address: undefined, isConnected: false, chainId: ACTIVE_CHAIN_ID }
renderUpdate({ enabled: true })
assert.deepEqual(latest.globalPause, { status: 'idle' }, 'disconnect clears the applicable reading')

wallet = { address: OWNER_A, isConnected: true, chainId: ACTIVE_CHAIN_ID }
reads = {
  paused: {
    data: false,
    isLoading: false,
    isFetching: true,
    isStale: true,
    isError: false,
    error: undefined,
  },
}
renderUpdate({ enabled: true })
assert.equal(lastReadResult('paused').data, false)
assert.equal(lastReadResult('paused').isFetching, true)
assert.equal(lastReadResult('paused').isStale, true)

assert.deepEqual(latest.globalPause, { status: 'loading' }, 'stale cached false during reconnect must remain unknown')

setGlobalRead({ data: false, isLoading: false, isFetching: false, isStale: true, isError: false, error: undefined })
assert.deepEqual(latest.globalPause, { status: 'loading' }, 'stale idle cached false must remain unknown')
setGlobalRead({ data: false, isLoading: false, isFetching: false, fetchStatus: 'paused', isStale: true, isError: false, error: undefined })
assert.deepEqual(latest.globalPause, { status: 'loading' }, 'offline paused refresh cannot make stale cache current')
assert.equal(lastRead('paused').query.staleTime, lastRead('paused').query.refetchInterval, 'service freshness must match its polling interval')


setGlobalRead({
  data: false,
  isLoading: false,
  isFetching: false,
  isStale: false,
  isError: false,
  error: undefined,
})
assert.deepEqual(latest.globalPause, { status: 'running' }, 'a successful current read restores running')
setGlobalRead({
  data: true,
  isLoading: false,
  isFetching: false,
  isStale: false,
  isError: false,
  error: undefined,
})
assert.deepEqual(latest.globalPause, { status: 'paused' }, 'a successful current read can confirm paused')
act(() => renderer.unmount())

console.log('PASS: real useAutoSaver selected-chain reads, refetch, stale reconnect, and wallet/network guards')
