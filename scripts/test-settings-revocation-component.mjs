import assert from 'node:assert/strict'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { EnrollmentRevocationControl } from '../src/components/movy/views/enrollment-revocation-control.tsx'
import { revokeEnrollmentWithConfirmation } from '../src/lib/spending-permissions.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
}

const owner = '0x1111111111111111111111111111111111111111'
const otherOwner = '0x2222222222222222222222222222222222222222'
const arcTestnet = 5_042_002
const mockTransactionHash = `0x${'b'.repeat(64)}`
const connectedWallet = {
  isConnected: true,
  address: owner,
  chainId: arcTestnet,
  isWrongNetwork: false,
}
const verifiedEnrollment = {
  isOnchainEnrolled: true,
  configEpoch: 4,
  isOnchainLoading: false,
  onchainError: null,
  isPending: false,
}
const backendAvailable = { isLoading: false, error: null, isPending: false }

let renderer
let setupCount = 0

function setup(overrides = {}) {
  const calls = { connected: 0, messages: [] }
  const props = {
    wallet: connectedWallet,
    enrollment: verifiedEnrollment,
    backendStatus: backendAvailable,
    buttonContent: 'Revoke',
    buttonClassName: 'revoke-button',
    onConnectedRevoke: async (expectedConfigEpoch) => {
      calls.connected++
      calls.expectedConfigEpoch = expectedConfigEpoch
      return { backendSynced: true, walletContextChanged: false }
    },
    onMessage: (message) => calls.messages.push(message),
    ...overrides,
  }
  const key = setupCount++
  const renderComponent = () => React.createElement(EnrollmentRevocationControl, { ...props, key })
  act(() => {
    if (renderer) renderer.update(renderComponent())
    else renderer = create(renderComponent())
  })
  return {
    calls,
    props,
    renderer,
    trigger: () => renderer.root.findByProps({ 'aria-label': 'Revoke Automatic Enrollment' }),
    confirm: () => renderer.root.findByProps({ 'data-testid': 'confirm-enrollment-revoke' }),
    update: async (nextProps) => {
      Object.assign(props, nextProps)
      await act(async () => {
        renderer.update(renderComponent())
      })
    },
    open: async () => {
      await act(async () => { renderer.root.findByProps({ 'aria-label': 'Revoke Automatic Enrollment' }).props.onClick() })
    },
    submit: async () => {
      await act(async () => { renderer.root.findByProps({ 'data-testid': 'confirm-enrollment-revoke' }).props.onClick() })
    },
    unmount: () => act(() => renderer.update(null)),
  }
}

for (const [label, wallet] of [
  ['disconnected wallet', { ...connectedWallet, isConnected: false, address: undefined }],
  ['wrong network', { ...connectedWallet, chainId: 5_042, isWrongNetwork: true }],
  ['Arc Testnet chain ID mismatch', { ...connectedWallet, chainId: 5_042, isWrongNetwork: false }],
]) {
  const blocked = setup({ wallet })
  assert.equal(blocked.trigger().props.disabled, true, `${label} cannot start connected-mode revocation`)
  const blockerMessage = blocked.renderer.root.findByProps({ role: 'status' }).children.join('')
  assert.match(blockerMessage, label === 'disconnected wallet' ? /Connect your wallet/ : /Switch to Arc Testnet/)
  assert.equal(blocked.calls.connected, 0, `${label} cannot submit an onchain write`)
  assert.equal(blocked.calls.messages.length, 0, `${label} does not receive a success message`)
  blocked.unmount()
}

for (const [label, enrollment] of [
  ['unverified enrollment', { ...verifiedEnrollment, isOnchainEnrolled: false }],
  ['missing config epoch', { ...verifiedEnrollment, configEpoch: null }],
  ['loading onchain enrollment status', { ...verifiedEnrollment, isOnchainLoading: true }],
  ['onchain enrollment read error', { ...verifiedEnrollment, onchainError: 'RPC unavailable' }],
  ['pending savings transaction', { ...verifiedEnrollment, isPending: true }],
]) {
  const blocked = setup({ enrollment })
  assert.equal(blocked.trigger().props.disabled, true, `${label} blocks the revoke trigger`)
  assert.equal(blocked.calls.connected, 0)
  blocked.unmount()
}

for (const [label, nextProps] of [
  ['wallet disconnected', { wallet: { ...connectedWallet, isConnected: false, address: undefined } }],
  ['network changed', { wallet: { ...connectedWallet, chainId: 5_042, isWrongNetwork: true } }],
  ['wallet account changed', { wallet: { ...connectedWallet, address: otherOwner } }],
  ['verified enrollment revoked elsewhere', { enrollment: { ...verifiedEnrollment, isOnchainEnrolled: false } }],
  ['enrollment config changed', { enrollment: { ...verifiedEnrollment, configEpoch: 5 } }],
]) {
  const changed = setup()
  await changed.open()
  await changed.update(nextProps)
  assert.equal(changed.confirm().props.disabled, true, `${label} disables the open confirmation`)
  await changed.submit()
  assert.equal(changed.calls.connected, 0, `${label} causes no onchain write`)
  assert.match(changed.calls.messages.at(-1), /changed/i, `${label} explains that authorization changed`)
  changed.unmount()
}

const connected = setup()
await connected.open()
await connected.submit()
assert.equal(connected.calls.connected, 1, 'verified Arc Testnet revocation calls the connected action once')
assert.equal(connected.calls.expectedConfigEpoch, 4, 'revocation rechecks the configuration epoch captured by the confirmation')
assert.match(connected.calls.messages.at(-1), /^Automatic enrollment revoked/)
connected.unmount()

let backendOutageRevokeCalls = 0
let backendOutageExpectedEpoch
let backendOutageReadCount = 0
const backendOutage = setup({
  backendStatus: { isLoading: false, error: 'Enrollment endpoint returned HTTP 503', isPending: false },
  onConnectedRevoke: async (expectedConfigEpoch) => {
    backendOutageRevokeCalls++
    backendOutageExpectedEpoch = expectedConfigEpoch
    return revokeEnrollmentWithConfirmation({
      expectedOwner: owner,
      expectedChainId: arcTestnet,
      expectedConfigEpoch,
      getWalletContext: () => connectedWallet,
      writeRevoke: async (signingOwner, chainId) => {
        assert.equal(signingOwner, owner)
        assert.equal(chainId, arcTestnet)
        return mockTransactionHash
      },
      waitForReceipt: async () => ({ status: 'success', from: owner }),
      readEnrollment: async () => ++backendOutageReadCount === 1
        ? { enrolled: true, configEpoch: 4 }
        : { enrolled: false, configEpoch: 5 },
      syncEnrollment: async () => { throw new Error('POST /api/enrollment failed with HTTP 503') },
    })
  },
})
assert.equal(backendOutage.trigger().props.disabled, false, 'backend 503 does not block verified onchain revocation')
assert.match(backendOutage.renderer.root.findByProps({ role: 'status' }).children.join(''), /sync is unavailable/i)
await backendOutage.open()
await backendOutage.submit()
assert.equal(backendOutageRevokeCalls, 1, 'the onchain revoke still executes during a backend outage')
assert.equal(backendOutageExpectedEpoch, 4)
assert.match(backendOutage.calls.messages.at(-1), /sync is pending/i)
assert.match(backendOutage.calls.messages.at(-1), /USDC token allowance was not changed/i)
assert.doesNotMatch(backendOutage.calls.messages.at(-1), /allowance (?:was )?cleared/i)
backendOutage.unmount()

const backendLoading = setup({
  backendStatus: { isLoading: true, error: null, isPending: false },
})
assert.equal(backendLoading.trigger().props.disabled, false, 'backend status loading does not block verified onchain revocation')
assert.match(backendLoading.renderer.root.findByProps({ role: 'status' }).children.join(''), /sync status is loading/i)
backendLoading.unmount()

const backendPending = setup({
  backendStatus: { isLoading: false, error: null, isPending: true },
})
assert.equal(backendPending.trigger().props.disabled, false, 'pending backend synchronization does not block a new verified onchain revoke')
assert.match(backendPending.renderer.root.findByProps({ role: 'status' }).children.join(''), /synchronization is pending/i)
backendPending.unmount()

let failedPreflightWriteCount = 0
const onchainPreflightFailure = setup({
  onConnectedRevoke: async (expectedConfigEpoch) => revokeEnrollmentWithConfirmation({
    expectedOwner: owner,
    expectedChainId: arcTestnet,
    expectedConfigEpoch,
    getWalletContext: () => connectedWallet,
    writeRevoke: async () => { failedPreflightWriteCount++; return mockTransactionHash },
    waitForReceipt: async () => ({ status: 'success', from: owner }),
    readEnrollment: async () => { throw new Error('Arc Testnet RPC unavailable') },
    syncEnrollment: async () => {},
  }),
})
await onchainPreflightFailure.open()
await onchainPreflightFailure.submit()
assert.equal(failedPreflightWriteCount, 0, 'an onchain enrollment read failure stops before wallet signing')
assert.match(onchainPreflightFailure.calls.messages.at(-1), /could not verify.*No transaction was submitted/i)
assert.doesNotMatch(onchainPreflightFailure.calls.messages.at(-1), /revoked|sync is pending/i)
onchainPreflightFailure.unmount()

let revertedWriteCount = 0
const onchainReceiptFailure = setup({
  onConnectedRevoke: async (expectedConfigEpoch) => {
    let readCount = 0
    return revokeEnrollmentWithConfirmation({
      expectedOwner: owner,
      expectedChainId: arcTestnet,
      expectedConfigEpoch,
      getWalletContext: () => connectedWallet,
      writeRevoke: async () => { revertedWriteCount++; return mockTransactionHash },
      waitForReceipt: async () => ({ status: 'reverted', from: owner }),
      readEnrollment: async () => ++readCount === 1
        ? { enrolled: true, configEpoch: 4 }
        : { enrolled: false, configEpoch: 5 },
      syncEnrollment: async () => {},
    })
  },
})
await onchainReceiptFailure.open()
await onchainReceiptFailure.submit()
assert.equal(revertedWriteCount, 1, 'the mocked wallet submitted the request but the receipt failed')
assert.match(onchainReceiptFailure.calls.messages.at(-1), /transaction reverted and was not confirmed/i)
assert.doesNotMatch(onchainReceiptFailure.calls.messages.at(-1), /revoked|sync is pending/i)
onchainReceiptFailure.unmount()

console.log('Settings revocation regressions passed: wallet and network guards, backend outages, onchain preflight failures, reverted receipts, and synchronization states')
