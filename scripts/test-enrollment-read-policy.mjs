import assert from 'node:assert/strict'
import { shouldReadEnrollmentStatus } from '../src/lib/enrollment-read-policy.ts'

const expectedChainId = 5_042_002
const base = { enabled: true, isConnected: true, hasAddress: true, chainId: expectedChainId, expectedChainId }
assert.equal(shouldReadEnrollmentStatus(base), true, 'connected Arc Testnet wallet may read its enrollment')
assert.equal(shouldReadEnrollmentStatus({ ...base, enabled: false }), false, 'disabled data surfaces do not read enrollment')
assert.equal(shouldReadEnrollmentStatus({ ...base, isConnected: false }), false, 'disconnected wallets do not read enrollment')
assert.equal(shouldReadEnrollmentStatus({ ...base, hasAddress: false }), false, 'wallet identity is required')
assert.equal(shouldReadEnrollmentStatus({ ...base, chainId: 1 }), false, 'wrong-network wallets do not request unsupported enrollment')
assert.equal(shouldReadEnrollmentStatus({ ...base, chainId: undefined }), false, 'unknown networks do not request enrollment')
console.log('Enrollment status reads fail closed for disconnected, unknown, and wrong-network wallets')
