import assert from 'node:assert/strict'
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keccak256 } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { getRelayerAccount } from '../src/lib/server/relayer.ts'

const directory = mkdtempSync(join(tmpdir(), 'movy-relayer-keystore-'))
const keystorePath = join(directory, 'relayer.json')
const passwordPath = join(directory, 'relayer.password')
const testKey = generatePrivateKey()
const password = randomBytes(24).toString('hex')
const salt = randomBytes(32)
const iv = randomBytes(16)
const params = { dklen: 32, n: 1024, r: 8, p: 1, salt: salt.toString('hex') }
const derived = scryptSync(password, salt, 32, { N: params.n, r: params.r, p: params.p })
const cipher = createCipheriv('aes-128-ctr', derived.subarray(0, 16), iv)
const ciphertext = Buffer.concat([cipher.update(Buffer.from(testKey.slice(2), 'hex')), cipher.final()])
const keystore = {
  version: 3,
  crypto: {
    cipher: 'aes-128-ctr',
    cipherparams: { iv: iv.toString('hex') },
    ciphertext: ciphertext.toString('hex'),
    kdf: 'scrypt',
    kdfparams: params,
    mac: keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext])).slice(2),
  },
}
writeFileSync(keystorePath, JSON.stringify(keystore), { mode: 0o600 })
writeFileSync(passwordPath, password, { mode: 0o600 })

const envKeys = ['RELAYER_PRIVATE_KEY', 'MOVY_RELAYER_KEYSTORE', 'MOVY_RELAYER_PASSWORD_FILE']
const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
try {
  delete process.env.RELAYER_PRIVATE_KEY
  process.env.MOVY_RELAYER_KEYSTORE = keystorePath
  process.env.MOVY_RELAYER_PASSWORD_FILE = passwordPath

  assert.equal(
    getRelayerAccount()?.address,
    privateKeyToAccount(testKey).address,
    'encrypted Foundry keystore paths should configure the relayer without a raw key environment variable',
  )
  assert.equal(getRelayerAccount(null), null, 'an explicit null signer still disables signer lookup')

  process.env.RELAYER_PRIVATE_KEY = 'invalid'
  assert.equal(getRelayerAccount(), null, 'an invalid explicit raw key must fail closed instead of falling back')
  delete process.env.RELAYER_PRIVATE_KEY

  chmodSync(passwordPath, 0o644)
  assert.equal(getRelayerAccount()?.address, undefined, 'group-readable password files must be rejected')
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(directory, { recursive: true, force: true })
}

console.log('PASS: relayer accepts a protected encrypted keystore path and rejects unsafe configuration')
