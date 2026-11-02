import { createDecipheriv, pbkdf2Sync, scryptSync, timingSafeEqual } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { keccak256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

/**
 * Upper bounds on keystore KDF work, checked before synchronous derivation so a hostile
 * or corrupt keystore cannot stall or exhaust the process.
 */
export const KEYSTORE_KDF_LIMITS = Object.freeze({
  scryptMinN: 1 << 10,
  scryptMaxN: 1 << 20,
  scryptMaxR: 32,
  scryptMaxP: 16,
  scryptMaxMemoryBytes: 512 * 1024 * 1024,
  scryptMaxWork: 1 << 25,
  pbkdf2MaxIterations: 2_000_000,
  maxSaltBytes: 64,
  maxPasswordChars: 1024,
})

const isBoundedInteger = (value, min, max) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max

/** Decrypts a Foundry/Web3 Secret Storage v3 keystore in memory. */
export function decryptFoundryKeystore(keystoreJson, password, deps = {}) {
  const deriveScrypt = deps.scryptSync ?? scryptSync
  const derivePbkdf2 = deps.pbkdf2Sync ?? pbkdf2Sync
  const limits = KEYSTORE_KDF_LIMITS
  const fail = () => { throw new Error('Keystore could not be decrypted with the supplied password file') }
  if (typeof password !== 'string' || password.length === 0 || password.length > limits.maxPasswordChars) return fail()
  let keystore
  try { keystore = typeof keystoreJson === 'string' ? JSON.parse(keystoreJson) : keystoreJson } catch { return fail() }
  const crypto = keystore?.crypto ?? keystore?.Crypto
  if (keystore?.version !== 3 || !crypto || crypto.cipher !== 'aes-128-ctr') return fail()
  const hex = (value) => typeof value === 'string' && /^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0
    ? Buffer.from(value, 'hex')
    : null
  const ciphertext = hex(crypto.ciphertext)
  const iv = hex(crypto.cipherparams?.iv)
  const salt = hex(crypto.kdfparams?.salt)
  const mac = hex(crypto.mac)
  if (!ciphertext || ciphertext.length !== 32 || !iv || iv.length !== 16 || !salt || salt.length === 0 || salt.length > limits.maxSaltBytes || !mac) return fail()
  const params = crypto.kdfparams
  const dklen = params.dklen
  if (!isBoundedInteger(dklen, 32, 64)) return fail()
  let derive
  if (crypto.kdf === 'scrypt') {
    const { n, r, p } = params
    if (!isBoundedInteger(n, limits.scryptMinN, limits.scryptMaxN) || (n & (n - 1)) !== 0) return fail()
    if (!isBoundedInteger(r, 1, limits.scryptMaxR) || !isBoundedInteger(p, 1, limits.scryptMaxP)) return fail()
    if (128 * n * r > limits.scryptMaxMemoryBytes || n * r * p > limits.scryptMaxWork) return fail()
    derive = () => deriveScrypt(password, salt, dklen, { N: n, r, p, maxmem: 256 * n * r + 64 * 1024 * 1024 })
  } else if (crypto.kdf === 'pbkdf2' && params.prf === 'hmac-sha256' && isBoundedInteger(params.c, 1, limits.pbkdf2MaxIterations)) {
    derive = () => derivePbkdf2(password, salt, params.c, dklen, 'sha256')
  } else {
    return fail()
  }
  let derived
  try { derived = derive() } catch { return fail() }
  const expectedMac = Buffer.from(keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext])).slice(2), 'hex')
  if (expectedMac.length !== mac.length || !timingSafeEqual(expectedMac, mac)) return fail()
  const decipher = createDecipheriv('aes-128-ctr', derived.subarray(0, 16), iv)
  const key = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  if (key.length !== 32) return fail()
  return `0x${key.toString('hex')}`
}

function readPrivateFile(path, label) {
  if (typeof path !== 'string' || !path.trim()) throw new Error(`${label} path is not configured`)
  let stat
  try { stat = lstatSync(path) } catch { throw new Error(`${label} was not found`) }
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`)
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label} must not be readable by group or others (use mode 0600)`)
  if (stat.size > 1_048_576) throw new Error(`${label} is too large`)
  return readFileSync(path, 'utf8')
}

/** Loads an account from an encrypted keystore and a separate, mode-0600 password file. */
export function loadFoundryKeystoreAccount({ keystorePath, passwordFilePath }) {
  const keystoreJson = readPrivateFile(keystorePath, 'Relayer keystore')
  const password = readPrivateFile(passwordFilePath, 'Relayer password file').replace(/[\r\n]+$/, '')
  if (!password) throw new Error('Relayer password file is empty')
  return privateKeyToAccount(decryptFoundryKeystore(keystoreJson, password))
}
