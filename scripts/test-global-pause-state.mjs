// Offline checks for the contract-wide (service) pause in the connected app.
// Run with: node --experimental-test-module-mocks --import tsx scripts/test-global-pause-state.mjs
// No network, wallet, database, or worker is used. Contract reads are replaced by fixed values.
import assert from 'node:assert/strict'
import path from 'node:path'
import { mock } from 'node:test'
import { pathToFileURL } from 'node:url'
import React from 'react'
import { act, create } from 'react-test-renderer'
import {
  GLOBAL_PAUSE_UNAVAILABLE_MESSAGE,
  resolveAutomationAvailability,
  resolveGlobalPauseRead,
} from '../src/lib/global-pause.ts'
import {
  AutomationServiceNotice,
  AutomationSwitch,
  automationSwitchView,
  serviceNoticeKind,
} from '../src/components/movy/automation-control.tsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const text = (node) => (node.children ?? []).map((child) => (typeof child === 'string' ? child : text(child))).join(' ')

// ---------------------------------------------------------------------------
// 1. Reading the flag: only a successfully read boolean is a known state.
// ---------------------------------------------------------------------------
const base = { applicable: true, contractConfigured: true, isError: false, data: undefined }
assert.deepEqual(resolveGlobalPauseRead({ ...base, data: true }), { status: 'paused' })
assert.deepEqual(resolveGlobalPauseRead({ ...base, data: false }), { status: 'running' })
assert.deepEqual(resolveGlobalPauseRead(base), { status: 'loading' }, 'no data yet is loading, not running')
for (const bogus of [null, 0, 0n, 'false', {}, []]) {
  assert.equal(resolveGlobalPauseRead({ ...base, data: bogus }).status, 'loading', `non-boolean ${String(bogus)} must not count as a reading`)
}
assert.equal(resolveGlobalPauseRead({ ...base, isError: true, data: false }).status, 'error', 'a failed refetch must discard an older "running" value')
assert.equal(resolveGlobalPauseRead({ ...base, isError: true, data: true }).status, 'error')
assert.equal(GLOBAL_PAUSE_UNAVAILABLE_MESSAGE, 'Saving status is unavailable. Try again.')

// Adversarial: provider errors can carry credential-bearing endpoints. None of it may be returned.
const SECRET_SHAPED = 'https://rpc.example.invalid/v1/s3cr3t-api-key-0123456789abcdef?token=abc123tok&apikey=zzTOPSECRETzz'
const SECRET_PARTS = ['s3cr3t', 'abc123tok', 'zzTOPSECRETzz', 'rpc.example.invalid', 'apikey', 'https://']
const hostile = [
  new Error(`HTTP request failed. URL: ${SECRET_SHAPED}`),
  Object.assign(new Error('x'), { message: SECRET_SHAPED, details: SECRET_SHAPED, cause: new Error(SECRET_SHAPED) }),
  SECRET_SHAPED,
  { message: SECRET_SHAPED, shortMessage: SECRET_SHAPED },
]
for (const error of hostile) {
  for (const data of [undefined, true, false]) {
    for (const contractConfigured of [true, false]) {
      // `error` is passed on purpose: the helper must not read, copy, or echo it.
      const result = resolveGlobalPauseRead({ ...base, isError: true, error, data, contractConfigured })
      assert.deepEqual(result, { status: 'error', message: GLOBAL_PAUSE_UNAVAILABLE_MESSAGE })
      const serialized = JSON.stringify(result)
      for (const part of SECRET_PARTS) assert.ok(!serialized.includes(part), `helper output leaked ${part}`)
      const availability = resolveAutomationAvailability({ isEnrolled: true, personalPaused: false, globalPause: result, isPending: false })
      assert.equal(availability.isActive, false, 'a failed read never becomes Active')
      assert.equal(availability.statusLabel, 'Service Unavailable')
      assert.ok(!JSON.stringify(availability).includes('s3cr3t'))
    }
  }
}
assert.equal(resolveGlobalPauseRead({ ...base, isError: true, error: hostile[0] }).status, 'error', 'an error is never a zero or running reading')
assert.deepEqual(resolveGlobalPauseRead({ ...base, contractConfigured: false, data: false }), { status: 'error', message: GLOBAL_PAUSE_UNAVAILABLE_MESSAGE }, 'no contract address is unknown, not running, and the diagnostic stays out of the UI')
for (const data of [true, false, undefined]) {
  assert.deepEqual(resolveGlobalPauseRead({ ...base, applicable: false, data }), { status: 'idle' }, 'disconnected or wrong-network contexts keep no reading')
  assert.deepEqual(resolveGlobalPauseRead({ ...base, applicable: false, isError: true, data }), { status: 'idle' })
}

// ---------------------------------------------------------------------------
// 2. Effective availability: exhaustive over every input combination.
// ---------------------------------------------------------------------------
const reads = [
  { status: 'idle' },
  { status: 'loading' },
  { status: 'running' },
  { status: 'paused' },
  { status: 'error', message: 'x' },
]
let combinations = 0
for (const isEnrolled of [false, true]) {
  for (const personalPaused of [false, true]) {
    for (const globalPause of reads) {
      for (const isPending of [false, true]) {
        const result = resolveAutomationAvailability({ isEnrolled, personalPaused, globalPause, isPending })
        const expected = isEnrolled && !personalPaused && globalPause.status === 'running'
        assert.equal(result.isActive, expected, `isActive for ${JSON.stringify({ isEnrolled, personalPaused, globalPause, isPending })}`)
        assert.equal(result.personalActive, isEnrolled && !personalPaused, 'personalActive ignores the service state')
        if (globalPause.status !== 'running') assert.equal(result.isActive, false, 'unknown or paused service is never Active')
        combinations++
      }
    }
  }
}
assert.equal(combinations, 40)
const label = (isEnrolled, personalPaused, globalPause) =>
  resolveAutomationAvailability({ isEnrolled, personalPaused, globalPause: { status: globalPause, message: 'x' }, isPending: false }).statusLabel
assert.equal(label(true, false, 'running'), 'Active')
assert.equal(label(true, false, 'paused'), 'Service Paused')
assert.equal(label(true, false, 'loading'), 'Checking Service')
assert.equal(label(true, false, 'idle'), 'Checking Service')
assert.equal(label(true, false, 'error'), 'Service Unavailable')
assert.equal(label(true, true, 'running'), 'Paused', 'a personal pause is reported as Paused')
assert.equal(label(true, true, 'paused'), 'Paused', 'personal pause stays visible while the service is paused')
assert.equal(label(false, false, 'paused'), 'Not Enrolled')
assert.equal(resolveAutomationAvailability({ isEnrolled: true, personalPaused: false, globalPause: { status: 'running' }, isPending: true }).statusLabel, 'Updating...')

// ---------------------------------------------------------------------------
// 3. Components: the switch is the PERSONAL permission; the notice is separate.
// ---------------------------------------------------------------------------
const automation = (overrides = {}) => {
  const retries = { count: 0 }
  return {
    retries,
    value: {
      isEnrolled: true,
      personalActive: true,
      isPending: false,
      service: { status: 'available', retry: () => { retries.count += 1 } },
      ...overrides,
    },
  }
}
let renderer
const hostById = (id) => renderer.root.findAll((n) => typeof n.type === 'string' && n.props.id === id)[0]
const render = (element) => {
  act(() => { renderer = create(element) })
  return renderer
}

// Service paused while the user is personally ON: still shows On / Pause, never Resume.
{
  const { value } = automation({ service: { status: 'paused', retry() {} } })
  const view = automationSwitchView(value)
  assert.deepEqual(view, { checked: true, ariaLabel: 'Pause automatic savings', text: 'On' })
  let toggles = 0
  render(React.createElement('div', null,
    React.createElement(AutomationSwitch, { automation: value, disabled: false, onToggle: () => { toggles += 1 } }),
    React.createElement(AutomationServiceNotice, { automation: value, id: 'svc' }),
  ))
  const sw = renderer.root.findByProps({ role: 'switch' })
  assert.equal(sw.props['aria-checked'], true)
  assert.equal(sw.props['aria-label'], 'Pause automatic savings')
  assert.equal(sw.props.disabled, false, 'protective personal pause stays available while the service is paused')
  act(() => sw.props.onClick())
  assert.equal(toggles, 1)
  const everything = text(renderer.toJSON())
  assert.match(everything, /paused service-wide/i)
  assert.match(everything, /you can still pause or revoke/i)
  assert.doesNotMatch(everything, /resume/i, 'a service pause must never produce a Resume action')
  assert.equal(renderer.root.findAllByType('button').length, 1, 'only the personal switch, no service restart control')
  assert.equal(hostById('svc').props.role, 'status')
  act(() => renderer.unmount())
}

// Personal pause is its own state: Paused / Resume, whatever the service says.
for (const status of ['available', 'paused', 'checking', 'unavailable']) {
  const { value } = automation({ personalActive: false, service: { status, retry() {} } })
  assert.deepEqual(automationSwitchView(value), { checked: false, ariaLabel: 'Resume automatic savings', text: 'Paused' })
}
// Not enrolled is Off and carries no service notice.
{
  const { value } = automation({ isEnrolled: false, personalActive: false, service: { status: 'unavailable', retry() {} } })
  assert.equal(automationSwitchView(value).text, 'Off')
  assert.equal(serviceNoticeKind(value, false), null)
}
assert.equal(automationSwitchView({ isEnrolled: true, personalActive: true, isPending: true }).text, 'Updating…')
assert.equal(automationSwitchView({ isEnrolled: false, personalActive: false, isPending: false }, { isDemoMode: true }).ariaLabel, 'Demo enrollment off')

// Notice states: available shows nothing; loading and failure are explicit and never "active".
{
  const available = automation().value
  assert.equal(serviceNoticeKind(available, false), null)
  render(React.createElement(AutomationServiceNotice, { automation: available, id: 'svc' }))
  assert.equal(renderer.toJSON(), null, 'a confirmed running service shows no notice')
  act(() => renderer.unmount())

  const checking = automation({ service: { status: 'checking', retry() {} } }).value
  render(React.createElement(AutomationServiceNotice, { automation: checking, id: 'svc' }))
  assert.match(text(renderer.toJSON()), /Checking whether the saving service is running/)
  assert.equal(hostById('svc').props.role, 'status')
  act(() => renderer.unmount())

  const demo = automation({ service: { status: 'paused', retry() {} } }).value
  assert.equal(serviceNoticeKind(demo, true), null, 'the isolated demo never shows a service notice')
}

// Read failure: alert with a retry that only re-reads; it changes no setting.
{
  const { value, retries } = automation({ service: { status: 'unavailable', retry: () => { retries.count += 1 } } })
  let toggles = 0
  render(React.createElement('div', null,
    React.createElement(AutomationSwitch, { automation: value, disabled: false, onToggle: () => { toggles += 1 } }),
    React.createElement(AutomationServiceNotice, { automation: value, id: 'svc' }),
  ))
  const alert = hostById('svc')
  assert.equal(alert.props.role, 'alert')
  assert.match(text(renderer.toJSON()), /Saving status is unavailable\. Try again\./)
  for (const part of SECRET_PARTS) assert.ok(!text(renderer.toJSON()).includes(part), `rendered notice leaked ${part}`)
  const retry = renderer.root.findAllByType('button').find((b) => /Retry/.test(text(b)))
  assert.ok(retry, 'failed read exposes a retry')
  assert.match(retry.props.className, /min-h-11/)
  act(() => retry.props.onClick())
  assert.equal(retries.count, 1, 'retry re-reads the service state')
  assert.equal(toggles, 0, 'retry must not change the personal setting')
  act(() => renderer.unmount())
}

// ---------------------------------------------------------------------------
// 4. The mode-data hook, with the five data hooks replaced by fixed states.
// ---------------------------------------------------------------------------
const file = (p) => pathToFileURL(path.resolve(p)).href
const OWNER = '0x1111111111111111111111111111111111111111'
const DEST = '0x2222222222222222222222222222222222222222'
const calls = { setPaused: [], refetchGlobalPause: 0, refetch: 0, revoke: [] }
let autoSaverState
let walletState

mock.module(file('src/hooks/use-wallet.ts'), { exports: { useWallet: () => walletState } })
mock.module(file('src/hooks/use-auto-saver.ts'), { exports: { useAutoSaver: () => autoSaverState } })
mock.module(file('src/hooks/use-auto-activity.ts'), {
  exports: {
    useAutoActivity: () => ({
      items: [], confirmedRoundups6: undefined, confirmedRoundupCount: undefined, recordedLast7DaysRoundups6: undefined,
      summaryIsLoading: false, summaryIsError: false, summaryErrorMessage: null,
      isLoading: false, isError: false, errorMessage: null, isWrongNetwork: false, refetch: async () => {},
    }),
  },
})
mock.module(file('src/hooks/use-savings.ts'), {
  exports: {
    useSavings: () => ({
      savingsWei: 0n, savingsCents: 0n,
      legacyVault: { status: 'unavailable', reason: 'not-enrolled' },
      destinationBalance6: { status: 'unavailable', reason: 'not-enrolled' },
      refetchLegacyVault: async () => ({ status: 'unavailable', reason: 'not-enrolled' }),
      totalLiabilitiesWei: 0n, purchases: [], withdrawals: [], savedThisWeekCents: 0n, roundupCountThisWeek: 0,
      isTruncated: false, isLoading: false, isError: false, error: null, refetch: () => {}, isStale: false, queryClient: null,
    }),
  },
})
mock.module(file('src/context/demo-mode-context.tsx'), {
  exports: {
    useDemoMode: () => ({
      isDemoMode: false, browserTestFixturesEnabled: false,
      profile: { totalSaved: 0, isEnrolled: false, isPaused: false, dailyCap: 0 },
      goals: [], addGoal: () => {}, updateGoal: () => {}, activities: [],
    }),
  },
})

const { useMovyModeData } = await import('../src/hooks/use-movy-mode-data.ts')

function connectedAutoSaver({ globalPause, personalPaused = false, enrolled = true } = {}) {
  return {
    contractAddress: '0x3333333333333333333333333333333333333333',
    userConfig: enrolled
      ? { destination: DEST, maxRoundup6: 1_000_000n, dailyCap6: 5_000_000n, configEpoch: 1, paused: personalPaused, enrolled: true }
      : null,
    allowance: 5_000_000n, isAllowanceLoading: false, isAllowanceError: false,
    remainingDaily: 5_000_000n,
    isEnrolled: enrolled, isPaused: enrolled && personalPaused,
    isPending: false, enrollmentStatusLoading: false, enrollmentStatusError: null,
    globalPause,
    refetchGlobalPause: () => { calls.refetchGlobalPause += 1 },
    refetch() { calls.refetch += 1; calls.refetchGlobalPause += 1 },
    setPaused: async (value) => { calls.setPaused.push(value) },
    revoke: async (epoch) => { calls.revoke.push(epoch) },
  }
}

let latest
function Probe() {
  latest = useMovyModeData()
  return null
}
function mount({ globalPause, personalPaused, enrolled, wrongNetwork = false, connected = true }) {
  walletState = {
    address: OWNER, chainId: 5_042_002, isConnected: connected, isWrongNetwork: wrongNetwork,
    nativeWei: 0n, isBalanceLoading: false, isBalanceError: false, refetchBalance: () => {},
    connectors: [], connect: () => {}, disconnect: () => {},
  }
  autoSaverState = connectedAutoSaver({ globalPause, personalPaused, enrolled })
  const r = create(React.createElement(Probe))
  return r
}

async function scenario(name, input, check) {
  let r
  act(() => { r = mount(input) })
  try {
    await check(latest.automation, latest)
  } catch (error) {
    error.message = `${name}: ${error.message}`
    throw error
  } finally {
    act(() => r.unmount())
    calls.setPaused.length = 0
    calls.refetchGlobalPause = 0
    calls.refetch = 0
  }
}

await scenario('confirmed running service is Active', { globalPause: { status: 'running' } }, (a) => {
  assert.equal(a.isActive, true)
  assert.equal(a.personalActive, true)
  assert.equal(a.service.status, 'available')
  assert.equal(a.statusLabel, 'Active')
})

await scenario('service paused is not Active but personal stays On', { globalPause: { status: 'paused' } }, async (a, data) => {
  assert.equal(a.isActive, false)
  assert.equal(a.personalActive, true)
  assert.equal(a.isPaused, false, 'the personal pause flag is untouched by the service pause')
  assert.equal(a.service.status, 'paused')
  assert.equal(a.statusLabel, 'Service Paused')
  assert.match(data.modeBadge.sublabel, /Service paused/)
  // Toggling while the service is paused is a PERSONAL pause, never a resume.
  await a.toggleAutomation()
  assert.deepEqual(calls.setPaused, [true])
})

await scenario('personal pause is independent of a running service', { globalPause: { status: 'running' }, personalPaused: true }, async (a) => {
  assert.equal(a.isActive, false)
  assert.equal(a.personalActive, false)
  assert.equal(a.isPaused, true)
  assert.equal(a.statusLabel, 'Paused')
  await a.toggleAutomation()
  assert.deepEqual(calls.setPaused, [false], 'resume is a personal action')
})

await scenario('personal pause while service paused stays personal', { globalPause: { status: 'paused' }, personalPaused: true }, async (a) => {
  assert.equal(a.isActive, false)
  assert.equal(a.statusLabel, 'Paused')
  assert.equal(a.service.status, 'paused')
  await a.toggleAutomation()
  assert.deepEqual(calls.setPaused, [false], 'the user resumes only their own setting; the service stays paused')
})

for (const [name, globalPause, status, labelText] of [
  ['loading', { status: 'loading' }, 'checking', 'Checking Service'],
  ['idle', { status: 'idle' }, 'not-applicable', 'Checking Service'],
  ['read failure', { status: 'error', message: 'rpc down' }, 'unavailable', 'Service Unavailable'],
]) {
  await scenario(`unknown service state (${name}) is never Active`, { globalPause }, async (a, data) => {
    assert.equal(a.isActive, false)
    assert.equal(a.personalActive, true)
    assert.equal(a.service.status, status)
    assert.equal(a.statusLabel, labelText)
    if (globalPause.status === 'error') assert.match(data.modeBadge.sublabel, /Service status unavailable/)
    assert.notEqual(a.service.status, 'available')
    a.service.retry()
    assert.equal(calls.refetchGlobalPause, 1, 'retry goes through the same read the hook polls')
  })
}

await scenario('not enrolled is never Active even with a running service', { globalPause: { status: 'running' }, enrolled: false }, (a) => {
  assert.equal(a.isActive, false)
  assert.equal(a.personalActive, false)
  assert.equal(a.statusLabel, 'Not Enrolled')
})

await scenario('refetch path includes the service read', { globalPause: { status: 'running' } }, (_a, data) => {
  data.savings.refetch()
  assert.equal(calls.refetch, 1)
  assert.equal(calls.refetchGlobalPause, 1)
})

console.log('PASS: service pause is read truthfully, unknown is never Active, and the personal switch stays personal')
