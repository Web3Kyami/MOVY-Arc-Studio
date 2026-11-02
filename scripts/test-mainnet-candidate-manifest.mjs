import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateMainnetManifest } from './verify/network-build-guard.mjs'

/**
 * The candidate file records observed Mainnet facts for owner review. It must never be
 * able to satisfy the build guard, and the real manifest must not exist until the owner
 * verifies it. Offline: no network call.
 */
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const candidate = JSON.parse(read('../config/networks/arc-mainnet.candidate.json'))

assert.throws(() => validateMainnetManifest(candidate), /owner-verified/)
assert.notEqual(candidate.status, 'owner-verified')
assert.equal(candidate.verification.ownerApproved, false)
assert.equal(candidate.contracts.autoSaver.roles.verified, false)
assert.ok(candidate.verification.evidenceUrls.length >= 2, 'retain the two observed provider sources without converting evidence into approval')

// Even if status were forced, the remaining unverified items still block the guard.
const forced = structuredClone(candidate)
forced.status = 'owner-verified'
// The candidate still carries the historical on-chain AutoSaver hash, which the source lock rejects first.
assert.throws(() => validateMainnetManifest(forced), /AutoSaver runtimeCodeHash does not match the release source lock/)
const lock = JSON.parse(read('../config/networks/arc-mainnet.source-lock.json'))
assert.equal(candidate.contracts.autoSaver.runtimeCodeHash === lock.contracts.autoSaver.runtimeCodeHash, false)
assert.equal(candidate.contracts.savingsVault.runtimeCodeHash, lock.contracts.savingsVault.runtimeCodeHash)
forced.contracts.autoSaver.runtimeCodeHash = lock.contracts.autoSaver.runtimeCodeHash
assert.throws(() => validateMainnetManifest(forced), /independently verified/)
forced.contracts.autoSaver.roles.verified = true
assert.throws(() => validateMainnetManifest(forced), /explicit owner approval/)
forced.verification.ownerApproved = true
assert.throws(() => validateMainnetManifest(forced), /needs an approver/)

// Observed facts stay consistent with the approved fee policy and the env template.
assert.equal(candidate.chainId, 5042)
assert.equal(candidate.feePolicy.minBaseFeePerGasWei, '20000000000')
assert.equal(candidate.feePolicy.maxFeePerGasWei, '30000000000')
assert.equal(candidate.feePolicy.priorityFeePerGasWei, '1000000000')
assert.equal(candidate.feePolicy.maxTransactionFeeWei, '50000000000000000')
const template = read('../config/networks/arc-mainnet.env.template')
const release = JSON.parse(read('../config/networks/arc-mainnet.json'))
assert.equal(candidate.sourceVerification.autoSaver.matchesCurrentSource, false)
assert.notEqual(release.contracts.autoSaver.address.toLowerCase(), candidate.contracts.autoSaver.address.toLowerCase())
assert.equal(release.contracts.autoSaver.runtimeCodeHash, lock.contracts.autoSaver.runtimeCodeHash)
assert.ok(template.includes(`NEXT_PUBLIC_MOVY_AUTO_SAVER_MAINNET=${release.contracts.autoSaver.address}`), 'select the new verified release rather than the historical candidate')
assert.ok(template.includes(`NEXT_PUBLIC_MOVY_ADDRESS_MAINNET=${candidate.contracts.savingsVault.address}`))
assert.ok(template.includes(`NEXT_PUBLIC_MOVY_AUTO_SAVER_DEPLOY_BLOCK_MAINNET=${release.contracts.autoSaver.deployBlock}`))
assert.ok(template.includes(`NEXT_PUBLIC_MOVY_DEPLOY_BLOCK_MAINNET=${candidate.contracts.savingsVault.deployBlock}`))

console.log('PASS: observed candidate evidence cannot approve a release or select an incompatible AutoSaver')
