import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { privateKeyToAccount } from 'viem/accounts'
import { verifyMessage } from 'viem'
import { validProfile, profileMessage } from '../src/lib/profile-contract.ts'

const account = privateKeyToAccount(`0x${'01'.padStart(64, '0')}`)
const profile = { name: 'Alex', avatar: 'sage', photo: null }
const nonce = 'ab'.repeat(32)
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const message = profileMessage(account.address, nonce, hash(profile))
const signature = await account.signMessage({ message })
assert.equal(await verifyMessage({ address: account.address, message, signature }), true)
assert.equal(await verifyMessage({ address: account.address, message: profileMessage(account.address, nonce, hash({ ...profile, name: 'Someone else' })), signature }), false)
assert.equal(await verifyMessage({ address: account.address, message: profileMessage(account.address, 'cd'.repeat(32), hash(profile)), signature }), false)
assert.equal(validProfile(profile), true)
assert.equal(validProfile({ ...profile, photo: 'https://example.com/image.jpg' }), false)
assert.equal(validProfile({ ...profile, name: ' '.repeat(61) }), false)
assert.equal(validProfile({ ...profile, avatar: 'unknown' }), false)
console.log('PASS: profile validation and signature binding')
