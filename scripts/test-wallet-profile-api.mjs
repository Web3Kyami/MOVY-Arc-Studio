import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { privateKeyToAccount } from 'viem/accounts'
import { profileMessage } from '../src/lib/profile-contract.ts'

process.env.MOVY_PRODUCT_ORIGINS = 'https://product.movy.test'
process.env.MOVY_DEMO_ORIGINS = 'https://demo.movy.test'
process.env.MOVY_DEMO_ENTRY_ORIGIN = 'https://demo.movy.test'
const route = await import('../src/app/api/profile/route.ts')
const { getDb, getDatabaseHealth } = await import('../src/lib/server/db.ts')
assert.match(process.env.MOVY_DB_SCHEMA ?? '', /^movy_test_/, 'Use the isolated local schema runner')
assert.equal((await getDatabaseHealth()).ready, true)
await getDb().query('ALTER TABLE wallet_profile_challenges RENAME TO unavailable_profile_challenges')
try {
  assert.equal((await getDatabaseHealth()).ready, false, 'Missing profile tables must fail readiness')
} finally {
  await getDb().query('ALTER TABLE unavailable_profile_challenges RENAME TO wallet_profile_challenges')
}
const account = privateKeyToAccount(`0x${'01'.padStart(64, '0')}`)
const other = privateKeyToAccount(`0x${'02'.padStart(64, '0')}`)
const wallet = account.address.toLowerCase()
const profile = { name: 'Alex', avatar: 'sage', photo: null }
const origin = 'https://product.movy.test'
const request = (method, data, suffix = '') => new Request(`${origin}/api/profile${suffix}`, {
  method, headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
  ...(data ? { body: JSON.stringify(data) } : {}),
})
const challenge = await route.POST(request('POST', { wallet }))
assert.equal(challenge.status, 200)
const { nonce } = await challenge.json()
const digest = createHash('sha256').update(JSON.stringify(profile)).digest('hex')
const message = profileMessage(wallet, nonce, digest)
const signature = await account.signMessage({ message })
const wrongSignature = await other.signMessage({ message })
assert.equal((await route.PUT(request('PUT', { wallet, nonce, signature: wrongSignature, profile }))).status, 401)
assert.equal((await route.PUT(request('PUT', { wallet, nonce, signature, profile: { ...profile, name: 'Tampered' } }))).status, 401)
assert.equal((await route.PUT(request('PUT', { wallet, nonce, signature, profile }))).status, 200)
assert.equal((await route.PUT(request('PUT', { wallet, nonce, signature, profile }))).status, 401)
const read = await route.GET(request('GET', null, `?wallet=${wallet}`))
assert.equal(read.status, 200)
assert.deepEqual((await read.json()).profile, profile)
const concurrent = await Promise.all(Array.from({ length: 5 }, () => route.POST(request('POST', { wallet }))))
assert.equal(concurrent.filter((response) => response.status === 200).length, 3)
assert.equal(concurrent.filter((response) => response.status === 429).length, 2)

console.log('PASS: signed profile write, read-back, tampering, wrong signer and replay against isolated PostgreSQL')
