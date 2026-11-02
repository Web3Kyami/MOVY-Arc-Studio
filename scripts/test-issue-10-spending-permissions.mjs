import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EnrollmentBackendSyncError } from '../src/lib/enrollment-activation.ts'
import {
  AllowanceReadError,
  AllowanceVerificationError,
  PermissionContextError,
  EnrollmentRevocationPreflightError,
  applyAllowanceTargetAndConfirm,
  formatUsdcAllowance,
  parseUsdcAllowanceTarget,
  resolveAllowanceReadState,
  revokeEnrollmentWithConfirmation,
  syncConfirmedAllowanceWithEnrollment,
} from '../src/lib/spending-permissions.ts'

const owner = '0x1111111111111111111111111111111111111111'
const otherOwner = '0x2222222222222222222222222222222222222222'
const spender = '0x3333333333333333333333333333333333333333'
const arcTestnet = 5_042_002
const hash = `0x${'a'.repeat(64)}`
const context = { isConnected: true, address: owner, chainId: arcTestnet }

assert.equal(parseUsdcAllowanceTarget('$25.00'), 25_000_000n)
assert.equal(parseUsdcAllowanceTarget('25.1'), 25_100_000n)
assert.equal(parseUsdcAllowanceTarget('0'), 0n)
for (const invalid of ['', '$', '-1.00', '1.001', '1e2', '1,000.00', '.25']) {
  assert.equal(parseUsdcAllowanceTarget(invalid), null, `${invalid || 'empty'} is not an exact cents amount`)
}
assert.equal(formatUsdcAllowance(25_000_001n), '$25.000001', 'allowance display preserves all six ERC-20 decimals')

assert.deepEqual(resolveAllowanceReadState({
  isDemoMode: false,
  isConnected: true,
  isWrongNetwork: false,
  isLoading: false,
  isError: true,
  allowance6: 50_000_000n,
  demoAllowance6: 22_090_000n,
}), { status: 'error' }, 'stale allowance data is not shown as current after an RPC error')
assert.deepEqual(resolveAllowanceReadState({
  isDemoMode: false,
  isConnected: true,
  isWrongNetwork: false,
  isLoading: false,
  isError: false,
  allowance6: null,
  demoAllowance6: 22_090_000n,
}), { status: 'loading' }, 'an unknown allowance is not a zero allowance')
assert.deepEqual(resolveAllowanceReadState({
  isDemoMode: false,
  isConnected: true,
  isWrongNetwork: true,
  isLoading: false,
  isError: false,
  allowance6: 50_000_000n,
  demoAllowance6: 22_090_000n,
}), { status: 'wrong-network' }, 'a stale Arc allowance is hidden while the wallet is on another network')
assert.deepEqual(resolveAllowanceReadState({
  isDemoMode: true,
  isConnected: true,
  isWrongNetwork: true,
  isLoading: true,
  isError: true,
  allowance6: 50_000_000n,
  demoAllowance6: 22_090_000n,
}), { status: 'preview', allowance6: 22_090_000n }, 'Preview displays its own simulated allowance and ignores live wallet reads')
assert.deepEqual(resolveAllowanceReadState({
  isDemoMode: false,
  isConnected: true,
  isWrongNetwork: false,
  isLoading: false,
  isError: false,
  allowance6: 0n,
  demoAllowance6: 22_090_000n,
}), { status: 'ready', allowance6: 0n }, 'a verified zero stays distinct from an unknown allowance')

const order = []
let currentAllowance6 = 50_000_000n
const setTargetResult = await applyAllowanceTargetAndConfirm({
  targetAllowance6: 25_000_000n,
  expectedOwner: owner,
  expectedChainId: arcTestnet,
  spender,
  getWalletContext: () => context,
  readAllowance: async (readOwner, readSpender) => {
    order.push(['read', readOwner, readSpender, currentAllowance6])
    assert.equal(readOwner, owner)
    assert.equal(readSpender, spender)
    return currentAllowance6
  },
  writeAllowance: async (target, writeOwner, writeSpender, chainId) => {
    order.push(['write', target, writeOwner, writeSpender, chainId])
    return hash
  },
  waitForReceipt: async (transactionHash) => {
    order.push(['receipt', transactionHash])
    currentAllowance6 = 25_000_000n
    return { status: 'success', from: owner }
  },
})
assert.deepEqual(order, [
  ['read', owner, spender, 50_000_000n],
  ['write', 25_000_000n, owner, spender, arcTestnet],
  ['receipt', hash],
  ['read', owner, spender, 25_000_000n],
], 'setting $25 from a $50 allowance writes an absolute $25 target and verifies it after the successful receipt')
assert.deepEqual(setTargetResult, {
  transactionHash: hash,
  owner,
  previousAllowance6: 50_000_000n,
  allowance6: 25_000_000n,
  walletContextChanged: false,
})

const pendingAllowanceSync = await syncConfirmedAllowanceWithEnrollment(setTargetResult, async () => {
  throw new EnrollmentBackendSyncError('MOVY enrollment sync is temporarily unavailable.', { retryable: true, transactionHash: hash })
})
assert.deepEqual(pendingAllowanceSync, {
  ...setTargetResult,
  backendSyncPending: true,
  backendSyncError: 'MOVY enrollment sync is temporarily unavailable.',
}, 'a confirmed allowance remains confirmed when a separate enrollment sync fails, with a retryable partial state')
assert.deepEqual(await syncConfirmedAllowanceWithEnrollment(setTargetResult, async () => {}), {
  ...setTargetResult,
  backendSyncPending: false,
  backendSyncError: null,
})

let resetAllowance6 = 50_000_000n
const resetResult = await applyAllowanceTargetAndConfirm({
  targetAllowance6: 0n,
  expectedOwner: owner,
  expectedChainId: arcTestnet,
  spender,
  getWalletContext: () => context,
  readAllowance: async () => resetAllowance6,
  writeAllowance: async (target) => {
    assert.equal(target, 0n, 'reset writes approve(spender, 0)')
    return hash
  },
  waitForReceipt: async () => {
    resetAllowance6 = 0n
    return { status: 'success', from: owner }
  },
})
assert.equal(resetResult.allowance6, 0n, 'a reset is successful only after the onchain allowance reads zero')

let preflightWrites = 0
await assert.rejects(
  () => applyAllowanceTargetAndConfirm({
    targetAllowance6: 25_000_000n,
    expectedOwner: owner,
    expectedChainId: arcTestnet,
    spender,
    getWalletContext: () => context,
    readAllowance: async () => { throw new Error('RPC unavailable') },
    writeAllowance: async () => { preflightWrites++; return hash },
    waitForReceipt: async () => ({ status: 'success', from: owner }),
  }),
  (error) => error instanceof AllowanceReadError && error.stage === 'before',
  'a failed allowance read blocks the wallet write',
)
assert.equal(preflightWrites, 0)

await assert.rejects(
  () => applyAllowanceTargetAndConfirm({
    targetAllowance6: 25_000_000n,
    expectedOwner: owner,
    expectedChainId: arcTestnet,
    spender,
    getWalletContext: () => ({ ...context, chainId: 5_042 }),
    readAllowance: async () => 50_000_000n,
    writeAllowance: async () => { preflightWrites++; return hash },
    waitForReceipt: async () => ({ status: 'success', from: owner }),
  }),
  (error) => error instanceof PermissionContextError,
  'wrong-network wallet state fails before signing',
)
assert.equal(preflightWrites, 0)

let accountSnapshot = context
let switchWriteCount = 0
const switchedResult = await applyAllowanceTargetAndConfirm({
  targetAllowance6: 25_000_000n,
  expectedOwner: owner,
  expectedChainId: arcTestnet,
  spender,
  getWalletContext: () => accountSnapshot,
  readAllowance: async (readOwner) => {
    assert.equal(readOwner, owner, 'verification stays scoped to the account that initiated the action')
    return switchWriteCount === 0 ? 50_000_000n : 25_000_000n
  },
  writeAllowance: async () => { switchWriteCount++; return hash },
  waitForReceipt: async () => {
    accountSnapshot = { isConnected: true, address: otherOwner, chainId: arcTestnet }
    return { status: 'success', from: owner }
  },
})
assert.equal(switchedResult.walletContextChanged, true, 'account changes while pending are surfaced in the result')
assert.equal(switchedResult.owner, owner)

let networkSnapshot = context
let networkAllowance6 = 50_000_000n
const switchedNetworkResult = await applyAllowanceTargetAndConfirm({
  targetAllowance6: 25_000_000n,
  expectedOwner: owner,
  expectedChainId: arcTestnet,
  spender,
  getWalletContext: () => networkSnapshot,
  readAllowance: async () => networkAllowance6,
  writeAllowance: async () => hash,
  waitForReceipt: async () => {
    networkAllowance6 = 25_000_000n
    networkSnapshot = { ...context, chainId: 5_042_001 }
    return { status: 'success', from: owner }
  },
})
assert.equal(switchedNetworkResult.walletContextChanged, true, 'a network switch while pending is surfaced after the original wallet transaction is verified')

let switchedBeforeWrite = false
await assert.rejects(
  () => applyAllowanceTargetAndConfirm({
    targetAllowance6: 25_000_000n,
    expectedOwner: owner,
    expectedChainId: arcTestnet,
    spender,
    getWalletContext: () => {
      if (switchedBeforeWrite) return { ...context, address: otherOwner }
      switchedBeforeWrite = true
      return context
    },
    readAllowance: async () => 50_000_000n,
    writeAllowance: async () => { preflightWrites++; return hash },
    waitForReceipt: async () => ({ status: 'success', from: owner }),
  }),
  (error) => error instanceof PermissionContextError,
  'an account switch during the preflight read prevents signing from the stale account',
)
assert.equal(preflightWrites, 0)

let postReceiptReads = 0
await assert.rejects(
  () => applyAllowanceTargetAndConfirm({
    targetAllowance6: 0n,
    expectedOwner: owner,
    expectedChainId: arcTestnet,
    spender,
    getWalletContext: () => context,
    readAllowance: async () => {
      postReceiptReads++
      if (postReceiptReads === 1) return 50_000_000n
      throw new Error('RPC unavailable after receipt')
    },
    writeAllowance: async () => hash,
    waitForReceipt: async () => ({ status: 'success', from: owner }),
  }),
  (error) => error instanceof AllowanceReadError && error.stage === 'after' && error.transactionHash === hash,
  'a confirmed reset is not called cleared when the final allowance read fails',
)

await assert.rejects(
  () => applyAllowanceTargetAndConfirm({
    targetAllowance6: 0n,
    expectedOwner: owner,
    expectedChainId: arcTestnet,
    spender,
    getWalletContext: () => context,
    readAllowance: async () => {
      if (currentAllowance6 === 50_000_000n) return currentAllowance6
      return 5_000_000n
    },
    writeAllowance: async () => hash,
    waitForReceipt: async () => ({ status: 'success', from: owner }),
  }),
  (error) => error instanceof AllowanceVerificationError && error.expectedAllowance6 === 0n && error.actualAllowance6 === 5_000_000n,
  'a receipt is not enough to claim the allowance matches the requested target',
)

await assert.rejects(
  () => applyAllowanceTargetAndConfirm({
    targetAllowance6: 25_000_000n,
    expectedOwner: owner,
    expectedChainId: arcTestnet,
    spender,
    getWalletContext: () => context,
    readAllowance: async () => 50_000_000n,
    writeAllowance: async () => hash,
    waitForReceipt: async () => ({ status: 'reverted', from: owner }),
  }),
  /reverted.*not confirmed/i,
  'a reverted approval never succeeds',
)

await assert.rejects(
  () => applyAllowanceTargetAndConfirm({
    targetAllowance6: 25_000_000n,
    expectedOwner: owner,
    expectedChainId: arcTestnet,
    spender,
    getWalletContext: () => context,
    readAllowance: async () => 50_000_000n,
    writeAllowance: async () => { throw new Error('User rejected request') },
    waitForReceipt: async () => ({ status: 'success', from: owner }),
  }),
  /rejected/i,
  'wallet rejection is not treated as approval success',
)

await assert.rejects(
  () => applyAllowanceTargetAndConfirm({
    targetAllowance6: 25_000_000n,
    expectedOwner: owner,
    expectedChainId: arcTestnet,
    spender,
    getWalletContext: () => context,
    readAllowance: async () => 50_000_000n,
    writeAllowance: async () => hash,
    waitForReceipt: async () => ({ status: 'success', from: otherOwner }),
  }),
  /different wallet/i,
  'a receipt from another wallet is not accepted for the connected owner',
)

let tokenApprovalWrites = 0
let enrollmentRevoked = false
let revokeReadCount = 0
const revokeResult = await revokeEnrollmentWithConfirmation({
  expectedOwner: owner,
  expectedChainId: arcTestnet,
  expectedConfigEpoch: 4,
  getWalletContext: () => context,
  writeRevoke: async (revokeOwner, chainId) => {
    assert.equal(revokeOwner, owner)
    assert.equal(chainId, arcTestnet)
    return hash
  },
  waitForReceipt: async () => ({ status: 'success', from: owner }),
  readEnrollment: async (readOwner) => {
    assert.equal(readOwner, owner)
    revokeReadCount++
    return revokeReadCount === 1
      ? { enrolled: true, configEpoch: 4 }
      : { enrolled: false, configEpoch: 5 }
  },
  syncEnrollment: async () => { enrollmentRevoked = true },
})
assert.deepEqual(revokeResult, {
  transactionHash: hash,
  owner,
  enrollmentRevoked: true,
  backendSynced: true,
  tokenAllowanceChanged: false,
  walletContextChanged: false,
})
assert.equal(enrollmentRevoked, true)
assert.equal(tokenApprovalWrites, 0, 'enrollment revoke never sends the separate ERC-20 approve(0) action')

const partialRevokeResult = await revokeEnrollmentWithConfirmation({
  expectedOwner: owner,
  expectedChainId: arcTestnet,
  expectedConfigEpoch: 4,
  getWalletContext: () => context,
  writeRevoke: async () => hash,
  waitForReceipt: async () => ({ status: 'success', from: owner }),
  readEnrollment: (() => {
    let readCount = 0
    return async () => ++readCount === 1
      ? { enrolled: true, configEpoch: 4 }
      : { enrolled: false, configEpoch: 5 }
  })(),
  syncEnrollment: async () => { throw new Error('temporary backend timeout') },
})
assert.deepEqual(partialRevokeResult, {
  transactionHash: hash,
  owner,
  enrollmentRevoked: true,
  backendSynced: false,
  tokenAllowanceChanged: false,
  walletContextChanged: false,
}, 'a backend sync failure does not hide confirmed enrollment revocation or imply an allowance reset')

let rpcFailurePreflightReads = 0
let rpcFailureWriteCount = 0
let rpcFailureSyncCount = 0
const receiptRpcFailure = await revokeEnrollmentWithConfirmation({
  expectedOwner: owner,
  expectedChainId: arcTestnet,
  expectedConfigEpoch: 4,
  getWalletContext: () => context,
  writeRevoke: async (revokeOwner, chainId) => {
    rpcFailureWriteCount++
    assert.equal(revokeOwner, owner)
    assert.equal(chainId, arcTestnet)
    return hash
  },
  waitForReceipt: async (submittedHash) => {
    assert.equal(submittedHash, hash)
    throw new Error('temporary Arc Testnet receipt RPC failure')
  },
  readEnrollment: async (readOwner) => {
    assert.equal(readOwner, owner)
    rpcFailurePreflightReads++
    return { enrolled: true, configEpoch: 4 }
  },
  syncEnrollment: async () => { rpcFailureSyncCount++ },
}).then(
  () => { throw new Error('receipt RPC failure must leave revocation outcome unconfirmed') },
  (error) => error,
)
assert.equal(receiptRpcFailure.name, 'EnrollmentRevocationConfirmationError')
assert.equal(receiptRpcFailure.transactionHash, hash, 'receipt RPC failure retains the submitted transaction hash')
assert.match(receiptRpcFailure.message, /enrollment outcome.*could not be confirmed/i)
assert.match(receiptRpcFailure.message, /verify.*on.?chain.*before retrying/i)
assert.doesNotMatch(receiptRpcFailure.message, /allowance/i, 'enrollment receipt failure is not described as an allowance failure')
assert.equal(rpcFailurePreflightReads, 1, 'the active enrollment is verified before submission')
assert.equal(rpcFailureWriteCount, 1, 'receipt failure occurs only after revoke submission')
assert.equal(rpcFailureSyncCount, 0, 'backend is not synchronized while onchain revocation remains unconfirmed')

await assert.rejects(
  () => revokeEnrollmentWithConfirmation({
    expectedOwner: owner,
    expectedChainId: arcTestnet,
    expectedConfigEpoch: 4,
    getWalletContext: () => context,
    writeRevoke: async () => hash,
    waitForReceipt: async () => ({ status: 'success', from: owner }),
    readEnrollment: (() => {
      let readCount = 0
      return async () => {
        if (++readCount === 1) return { enrolled: true, configEpoch: 4 }
        throw new Error('Arc RPC unavailable')
      }
    })(),
    syncEnrollment: async () => {},
  }),
  /enrollment.*could not be verified/i,
  'an unreadable post-receipt enrollment state is not labeled revoked',
)

let preflightWriteCount = 0
await assert.rejects(
  () => revokeEnrollmentWithConfirmation({
    expectedOwner: owner,
    expectedChainId: arcTestnet,
    expectedConfigEpoch: 4,
    getWalletContext: () => context,
    writeRevoke: async () => { preflightWriteCount++; return hash },
    waitForReceipt: async () => ({ status: 'success', from: owner }),
    readEnrollment: async () => { throw new Error('Arc RPC unavailable') },
    syncEnrollment: async () => {},
  }),
  (error) => error instanceof EnrollmentRevocationPreflightError,
  'an unavailable onchain preflight blocks revocation before wallet signing',
)
assert.equal(preflightWriteCount, 0)

await assert.rejects(
  () => revokeEnrollmentWithConfirmation({
    expectedOwner: owner,
    expectedChainId: arcTestnet,
    expectedConfigEpoch: 4,
    getWalletContext: () => context,
    writeRevoke: async () => { preflightWriteCount++; return hash },
    waitForReceipt: async () => ({ status: 'success', from: owner }),
    readEnrollment: async () => ({ enrolled: true, configEpoch: 5 }),
    syncEnrollment: async () => {},
  }),
  (error) => error instanceof EnrollmentRevocationPreflightError && /changed/i.test(error.message),
  'a configuration epoch change before signing blocks the revoke transaction',
)
assert.equal(preflightWriteCount, 0)

await assert.rejects(
  () => revokeEnrollmentWithConfirmation({
    expectedOwner: owner,
    expectedChainId: arcTestnet,
    expectedConfigEpoch: 4,
    getWalletContext: () => context,
    writeRevoke: async () => { preflightWriteCount++; return hash },
    waitForReceipt: async () => ({ status: 'success', from: owner }),
    readEnrollment: async () => ({ enrolled: false, configEpoch: 4 }),
    syncEnrollment: async () => {},
  }),
  (error) => error instanceof EnrollmentRevocationPreflightError && /no active/i.test(error.message),
  'an already-revoked onchain enrollment is not submitted again',
)
assert.equal(preflightWriteCount, 0)

let revocationContext = context
await assert.rejects(
  () => revokeEnrollmentWithConfirmation({
    expectedOwner: owner,
    expectedChainId: arcTestnet,
    expectedConfigEpoch: 4,
    getWalletContext: () => revocationContext,
    writeRevoke: async () => { preflightWriteCount++; return hash },
    waitForReceipt: async () => ({ status: 'success', from: owner }),
    readEnrollment: async () => {
      revocationContext = { ...context, address: otherOwner }
      return { enrolled: true, configEpoch: 4 }
    },
    syncEnrollment: async () => {},
  }),
  (error) => error instanceof PermissionContextError,
  'a wallet change while the fresh onchain read runs blocks signing for the new owner',
)
assert.equal(preflightWriteCount, 0)

const settingsView = readFileSync(new URL('../src/components/movy/views/settings-view.tsx', import.meta.url), 'utf8')
const revocationControl = readFileSync(new URL('../src/components/movy/views/enrollment-revocation-control.tsx', import.meta.url), 'utf8')
const onboardingFlow = readFileSync(new URL('../src/components/movy/onboarding/onboarding-flow.tsx', import.meta.url), 'utf8')
const saverHook = readFileSync(new URL('../src/hooks/use-auto-saver.ts', import.meta.url), 'utf8')
assert.match(settingsView, /Set Total USDC Allowance/i)
assert.match(settingsView, /replaces your current token allowance/i)
assert.match(settingsView, /autoSaver\.setUsdcAllowance\(0n\)/)
assert.match(settingsView, /isOnchainEnrolled: autoSaver\.isOnchainEnrolled/)
assert.match(settingsView, /isOnchainLoading: autoSaver\.onchainEnrollmentStatusLoading/)
assert.match(settingsView, /backendStatus: revocationBackendStatus/)
assert.match(settingsView, /onConnectedRevoke: \(expectedConfigEpoch: number\) => autoSaver\.revoke\(expectedConfigEpoch\)/)
assert.doesNotMatch(settingsView, /isPreviewMode|onPreviewRevoke|handlePreviewRevoke/,
  'Settings no longer wires a same-origin Demo revocation path')
assert.match(settingsView, /\{!isDemoMode && <>[\s\S]*?EnrollmentRevocationControl/,
  'wallet and security controls are outside the isolated Demo settings branch')
assert.match(revocationControl, /USDC token allowance was not changed/)
assert.doesNotMatch(settingsView, /Clears your savings authorization/)
assert.doesNotMatch(settingsView, /Savings permission increased by/)
assert.match(onboardingFlow, /setUsdcAllowance\(selectedPermission6\)/)
assert.doesNotMatch(onboardingFlow, /Math\.round\(selectedPermission/)
assert.match(onboardingFlow, /Total USDC Allowance Target/)
assert.doesNotMatch(onboardingFlow, /setIsDemoMode|isDemoMode|handleSelectPreviewMode|Continue in Demo|profile\.demoAddress/,
  'connected onboarding has no in-app Demo mode or Demo address path')
assert.match(saverHook, /useEffect\(\(\) => \{\s*walletContextRef\.current = \{ isConnected, address, chainId \}/, 'wallet and network switches are tracked between renders')

console.log('Spending allowance semantics, receipt confirmation, revocation separation, and isolated Demo tests passed')
