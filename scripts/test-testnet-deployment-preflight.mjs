import assert from 'node:assert/strict'
import { createCipheriv, pbkdf2Sync, randomBytes, scryptSync } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeAbiParameters, keccak256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  KEYSTORE_KDF_LIMITS,
  MAX_TESTNET_DEPLOYMENT_TX_FEE_WEI,
  assertDeploymentTxFeeCap,
  buildDeploymentGasEstimateRequest,
  decryptFoundryKeystore,
  estimateDeploymentGas,
  loadDeployerAccountFromKeystore,
  validateDeploymentFeeBudget,
  validateFreshTestnetRoles,
} from './lib/testnet-deployment-preflight.mjs'

const freshOwner = '0x1111111111111111111111111111111111111111'
const freshRelayer = '0x2222222222222222222222222222222222222222'
assert.deepEqual(validateFreshTestnetRoles(freshOwner, freshRelayer), { owner: freshOwner, relayer: freshRelayer })
assert.throws(() => validateFreshTestnetRoles(freshOwner, freshOwner), /separate/)
assert.throws(() => validateFreshTestnetRoles('0x0000000000000000000000000000000000000000', freshRelayer), /nonzero/)
assert.throws(() => validateFreshTestnetRoles('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', freshRelayer), /compromised/)
assert.throws(() => validateFreshTestnetRoles(freshOwner, 'not-an-address'), /valid address/)
assert.deepEqual(validateDeploymentFeeBudget(100n, 25n, 2_500n), { gas: 100n, maximumCost: 2_500n })
assert.throws(() => validateDeploymentFeeBudget(101n, 25n, 2_500n), /exceeds/)

// --- Hard deployment fee cap (0.15 native USDC = 150000000000000000 wei) ----------------
const feeCap = 150_000_000_000_000_000n
assert.equal(MAX_TESTNET_DEPLOYMENT_TX_FEE_WEI, feeCap)
assert.equal(assertDeploymentTxFeeCap(feeCap), feeCap, 'the documented maximum itself is allowed')
assert.equal(assertDeploymentTxFeeCap('100000000000000000'), 100_000_000_000_000_000n, 'valid lower budgets are preserved')
assert.throws(() => assertDeploymentTxFeeCap(feeCap + 1n), /exceeds the approved maximum of 150000000000000000 wei/)
assert.throws(() => assertDeploymentTxFeeCap(10n ** 30n), /exceeds the approved maximum/)
// The shared budget helper cannot be bypassed, even when gas * fee is far below the oversized budget.
assert.deepEqual(validateDeploymentFeeBudget(6_000_000n, 25_000_000_000n, feeCap), { gas: 6_000_000n, maximumCost: 150_000_000_000_000_000n })
assert.deepEqual(validateDeploymentFeeBudget(4_000_000n, 25_000_000_000n, 100_000_000_000_000_000n), { gas: 4_000_000n, maximumCost: 100_000_000_000_000_000n })
assert.throws(() => validateDeploymentFeeBudget(1n, 1n, feeCap + 1n), /exceeds the approved maximum/)
assert.throws(() => validateDeploymentFeeBudget(1n, 1n, '999999999999999999999'), /exceeds the approved maximum/)

// --- Deployment gas estimation: argument construction -------------------------------
const usdc = '0x3600000000000000000000000000000000000000'
const constructorAbi = [
  { type: 'constructor', stateMutability: 'nonpayable', inputs: [{ name: 'usdcAddress', type: 'address' }, { name: 'relayerAddress', type: 'address' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
]
const creationBytecode = '0x6080604052348015600e575f5ffd5b50'
const request = buildDeploymentGasEstimateRequest({ account: freshOwner, abi: constructorAbi, bytecode: creationBytecode, args: [usdc, freshRelayer] })
assert.deepEqual(Object.keys(request).sort(), ['account', 'data'], 'contract creation has no `to` and no function name')
assert.equal(request.account, freshOwner)
assert.equal(
  request.data,
  `${creationBytecode}${encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [usdc, freshRelayer]).slice(2)}`,
  'data is the exact creation bytecode followed by the ABI-encoded constructor arguments',
)
assert.throws(() => buildDeploymentGasEstimateRequest({ account: freshOwner, abi: [], bytecode: creationBytecode, args: [] }), /no constructor/)
assert.throws(() => buildDeploymentGasEstimateRequest({ account: freshOwner, abi: constructorAbi, bytecode: '0x', args: [usdc, freshRelayer] }), /non-empty even-length hex/)
assert.throws(() => buildDeploymentGasEstimateRequest({ account: freshOwner, abi: constructorAbi, bytecode: '0x60__$abc$__80', args: [usdc, freshRelayer] }), /even-length hex|unlinked/)
assert.throws(() => buildDeploymentGasEstimateRequest({ account: freshOwner, abi: constructorAbi, bytecode: `${creationBytecode}__$deadbeef$__00`, args: [usdc, freshRelayer] }), /unlinked|hex/)
assert.throws(() => buildDeploymentGasEstimateRequest({ account: 'nope', abi: constructorAbi, bytecode: creationBytecode, args: [usdc, freshRelayer] }), /valid owner address/)
assert.throws(() => buildDeploymentGasEstimateRequest({ account: freshOwner, abi: constructorAbi, bytecode: creationBytecode, args: [usdc] }), /./, 'a missing constructor argument is rejected by the ABI encoder')

let captured = null
const recordingClient = {
  estimateGas: async (received) => { captured = received; return 1_234_567n },
  estimateContractGas: async () => { throw new Error('estimateContractGas cannot estimate a contract creation') },
}
assert.equal(await estimateDeploymentGas(recordingClient, { account: freshOwner, abi: constructorAbi, bytecode: creationBytecode, args: [usdc, freshRelayer] }), 1_234_567n)
assert.deepEqual(captured, request, 'the client receives exactly the constructed creation request')

// --- Encrypted Foundry keystore + password file --------------------------------------
function encryptKeystore(privateKey, password, kdf) {
  const salt = randomBytes(32)
  const iv = randomBytes(16)
  const kdfparams = kdf === 'scrypt'
    ? { dklen: 32, n: 1024, r: 8, p: 1, salt: salt.toString('hex') }
    : { dklen: 32, c: 2048, prf: 'hmac-sha256', salt: salt.toString('hex') }
  const derived = kdf === 'scrypt'
    ? scryptSync(password, salt, 32, { N: 1024, r: 8, p: 1 })
    : pbkdf2Sync(password, salt, 2048, 32, 'sha256')
  const cipher = createCipheriv('aes-128-ctr', derived.subarray(0, 16), iv)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(privateKey.slice(2), 'hex')), cipher.final()])
  const mac = keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext])).slice(2)
  return {
    version: 3,
    crypto: { cipher: 'aes-128-ctr', cipherparams: { iv: iv.toString('hex') }, ciphertext: ciphertext.toString('hex'), kdf, kdfparams, mac },
  }
}
const throwawayKey = `0x${randomBytes(32).toString('hex')}`
const throwawayPassword = `pw-${randomBytes(12).toString('hex')}`
for (const kdf of ['scrypt', 'pbkdf2']) {
  const keystore = encryptKeystore(throwawayKey, throwawayPassword, kdf)
  assert.equal(decryptFoundryKeystore(keystore, throwawayPassword), throwawayKey, `${kdf} keystore round trip`)
  assert.equal(decryptFoundryKeystore(JSON.stringify(keystore), throwawayPassword), throwawayKey)
  let wrongPasswordMessage = ''
  try { decryptFoundryKeystore(keystore, `${throwawayPassword}x`) } catch (error) { wrongPasswordMessage = error.message }
  assert.match(wrongPasswordMessage, /could not be decrypted/)
  assert.ok(!wrongPasswordMessage.includes(throwawayPassword) && !wrongPasswordMessage.includes(throwawayKey.slice(2, 12)), 'errors never echo the password or key')
  const tampered = structuredClone(keystore)
  tampered.crypto.ciphertext = `${tampered.crypto.ciphertext.slice(0, -2)}${tampered.crypto.ciphertext.endsWith('00') ? '01' : '00'}`
  assert.throws(() => decryptFoundryKeystore(tampered, throwawayPassword), /could not be decrypted/)
}
// Published Web3 Secret Storage v3 test vector (public, non-secret; pbkdf2): independent of the round trips above.
assert.equal(
  decryptFoundryKeystore({
    version: 3,
    crypto: {
      cipher: 'aes-128-ctr',
      cipherparams: { iv: '6087dab2f9fdbbfaddc31a909735c1e6' },
      ciphertext: '5318b4d5bcd28de64ee5559e671353e16f075ecae9f99c7a79a38af5f869aa46',
      kdf: 'pbkdf2',
      kdfparams: { c: 262144, dklen: 32, prf: 'hmac-sha256', salt: 'ae3cd4e7013836a3df6bd7241b12db061dbe2c6785853cce422d148a624ce0bd' },
      mac: '517ead924a9d0dc3124507e3393d175ce3ff7c1e96529c6c555ce9e51205e9b2',
    },
  }, 'testpassword'),
  '0x7a28b5ba57c53603b0b07b56bba752f7784bf506fa95edc395f5cf6c7514fe9d',
)
assert.throws(() => decryptFoundryKeystore('{not json', 'x'), /could not be decrypted/)
assert.throws(() => decryptFoundryKeystore({ version: 2, crypto: {} }, 'x'), /could not be decrypted/)

// --- Keystore KDF work is bounded BEFORE any synchronous derivation ------------------------
const spies = () => {
  const calls = { scrypt: [], pbkdf2: [] }
  return {
    calls,
    deps: {
      scryptSync: (...args) => { calls.scrypt.push(args); return Buffer.alloc(32) },
      pbkdf2Sync: (...args) => { calls.pbkdf2.push(args); return Buffer.alloc(32) },
    },
  }
}
const shaped = (kdf, kdfparams, overrides = {}) => ({
  version: 3,
  crypto: {
    cipher: 'aes-128-ctr',
    cipherparams: { iv: '00'.repeat(16) },
    ciphertext: '11'.repeat(32),
    kdf,
    kdfparams: { dklen: 32, salt: '22'.repeat(32), ...kdfparams },
    mac: '33'.repeat(32),
    ...overrides,
  },
})
const scryptShaped = (n, r, p, extra = {}) => shaped('scrypt', { n, r, p, ...extra })
const pbkdf2Shaped = (c, extra = {}) => shaped('pbkdf2', { c, prf: 'hmac-sha256', ...extra })
const probePassword = `probe-${randomBytes(8).toString('hex')}`
const rejectedWithoutDerivation = [
  ['scrypt N above the maximum', scryptShaped(2 ** 21, 8, 1)],
  ['scrypt N of 2^30', scryptShaped(2 ** 30, 8, 1)],
  ['scrypt N of 2^53', scryptShaped(2 ** 53, 1, 1)],
  ['scrypt N below the minimum', scryptShaped(512, 8, 1)],
  ['scrypt N not a power of two', scryptShaped(262_145, 8, 1)],
  ['scrypt N fractional', scryptShaped(8192.5, 8, 1)],
  ['scrypt N a string', scryptShaped('8192', 8, 1)],
  ['scrypt N negative', scryptShaped(-8192, 8, 1)],
  ['scrypt N null', scryptShaped(null, 8, 1)],
  ['scrypt r zero', scryptShaped(8192, 0, 1)],
  ['scrypt r above the maximum', scryptShaped(8192, 33, 1)],
  ['scrypt r fractional', scryptShaped(8192, 8.5, 1)],
  ['scrypt p zero', scryptShaped(8192, 8, 0)],
  ['scrypt p above the maximum', scryptShaped(8192, 8, 17)],
  ['scrypt p of 2^53', scryptShaped(8192, 8, 2 ** 53)],
  ['scrypt memory above 512 MiB', scryptShaped(2 ** 20, 8, 1)],
  ['scrypt total work above the cap', scryptShaped(2 ** 18, 16, 16)],
  ['pbkdf2 iterations above the maximum', pbkdf2Shaped(2_000_001)],
  ['pbkdf2 iterations of 2^53-1', pbkdf2Shaped(Number.MAX_SAFE_INTEGER)],
  ['pbkdf2 iterations zero', pbkdf2Shaped(0)],
  ['pbkdf2 iterations negative', pbkdf2Shaped(-1)],
  ['pbkdf2 iterations fractional', pbkdf2Shaped(262_144.5)],
  ['pbkdf2 iterations a string', pbkdf2Shaped('262144')],
  ['pbkdf2 with another prf', pbkdf2Shaped(262_144, { prf: 'hmac-sha512' })],
  ['dklen too small', scryptShaped(8192, 8, 1, { dklen: 16 })],
  ['dklen too large', pbkdf2Shaped(262_144, { dklen: 4096 })],
  ['dklen fractional', pbkdf2Shaped(262_144, { dklen: 32.5 })],
  ['oversized salt', scryptShaped(8192, 8, 1, { salt: '44'.repeat(65) })],
  ['ciphertext of the wrong length', scryptShaped(8192, 8, 1), { ciphertext: '11'.repeat(33) }],
  ['unknown kdf', shaped('argon2', { n: 8192, r: 8, p: 1 })],
]
for (const [label, keystore, cryptoOverride] of rejectedWithoutDerivation) {
  const probe = spies()
  const candidate = structuredClone(keystore)
  if (cryptoOverride) Object.assign(candidate.crypto, cryptoOverride)
  let message = ''
  try { decryptFoundryKeystore(candidate, probePassword, probe.deps) } catch (error) { message = error.message }
  assert.equal(message, 'Keystore could not be decrypted with the supplied password file', `${label}: generic failure`)
  assert.ok(!message.includes(probePassword), `${label}: password stays out of errors`)
  assert.equal(probe.calls.scrypt.length + probe.calls.pbkdf2.length, 0, `${label}: derivation must not be attempted`)
}
{
  const probe = spies()
  assert.throws(() => decryptFoundryKeystore(scryptShaped(8192, 8, 1), 'x'.repeat(KEYSTORE_KDF_LIMITS.maxPasswordChars + 1), probe.deps), /could not be decrypted/)
  assert.throws(() => decryptFoundryKeystore(scryptShaped(8192, 8, 1), '', probe.deps), /could not be decrypted/)
  assert.equal(probe.calls.scrypt.length, 0)
}
// Ordinary keystores stay supported: derivation IS attempted with exactly the declared parameters.
for (const [label, keystore, expectedScrypt] of [
  ['Foundry/eth-keystore default scrypt', scryptShaped(8192, 8, 1), { N: 8192, r: 8, p: 1 }],
  ['geth standard scrypt', scryptShaped(262_144, 8, 1), { N: 262_144, r: 8, p: 1 }],
  ['geth light scrypt', scryptShaped(4096, 8, 6), { N: 4096, r: 8, p: 6 }],
  ['published-vector scrypt shape', scryptShaped(262_144, 1, 8), { N: 262_144, r: 1, p: 8 }],
  ['maximum permitted scrypt', scryptShaped(2 ** 19, 8, 1), { N: 2 ** 19, r: 8, p: 1 }],
]) {
  const probe = spies()
  assert.throws(() => decryptFoundryKeystore(keystore, probePassword, probe.deps), /could not be decrypted/, `${label}: the fake derivation fails the MAC`)
  assert.equal(probe.calls.scrypt.length, 1, `${label}: derivation attempted once`)
  const [, , dklen, options] = probe.calls.scrypt[0]
  assert.equal(dklen, 32)
  assert.deepEqual({ N: options.N, r: options.r, p: options.p }, expectedScrypt)
  assert.ok(options.maxmem >= 128 * options.N * options.r, `${label}: memory limit covers the derivation`)
}
for (const c of [1, 262_144, 2_000_000]) {
  const probe = spies()
  assert.throws(() => decryptFoundryKeystore(pbkdf2Shaped(c), probePassword, probe.deps), /could not be decrypted/)
  assert.equal(probe.calls.pbkdf2.length, 1)
  assert.equal(probe.calls.pbkdf2[0][3], 32)
  assert.equal(probe.calls.pbkdf2[0][2], c)
}

// The deploy script rejects an oversized budget BEFORE any RPC request (a loopback listener counts requests).
{
  const requests = []
  const server = createServer((req, res) => { requests.push(req.url); res.statusCode = 500; res.end('{}') })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const rpc = `http://127.0.0.1:${server.address().port}`
  const script = fileURLToPath(new URL('./deploy-auto-saver-testnet.mjs', import.meta.url))
  const run = (txFee) => promisify(execFile)(process.execPath, [script], {
    env: {
      PATH: process.env.PATH,
      ARC_TESTNET_RPC_URL: rpc,
      MOVY_OWNER_ADDRESS: freshOwner,
      MOVY_RELAYER_ADDRESS: freshRelayer,
      MOVY_DEPLOY_MAX_FEE_PER_GAS_WEI: '25000000000',
      MOVY_DEPLOY_MAX_TX_FEE_WEI: txFee,
    },
    timeout: 20_000,
  }).then(() => ({ code: 0, stderr: '' }), (error) => ({ code: error.code, stderr: String(error.stderr ?? '') }))
  try {
    const over = await run((feeCap + 1n).toString())
    assert.equal(over.code, 1)
    assert.match(over.stderr, /exceeds the approved maximum of 150000000000000000 wei/)
    assert.equal(requests.length, 0, 'no RPC request is made for an over-cap budget')
    const huge = await run('1000000000000000000000')
    assert.match(huge.stderr, /exceeds the approved maximum/)
    assert.equal(requests.length, 0)
    const atCap = await run(feeCap.toString())
    assert.doesNotMatch(atCap.stderr, /exceeds the approved maximum/, 'a budget at the documented maximum is not rejected by the cap')
  } finally {
    server.close()
  }
}

const keystoreDir = mkdtempSync(join(tmpdir(), 'movy-keystore-test-'))
try {
  const keystorePath = join(keystoreDir, 'deployer.json')
  const passwordPath = join(keystoreDir, 'password.txt')
  writeFileSync(keystorePath, JSON.stringify(encryptKeystore(throwawayKey, throwawayPassword, 'scrypt')))
  chmodSync(keystorePath, 0o600)
  writeFileSync(passwordPath, `${throwawayPassword}\n`, { mode: 0o600 })
  chmodSync(passwordPath, 0o600)
  const account = loadDeployerAccountFromKeystore({ keystorePath, passwordFilePath: passwordPath })
  assert.equal(account.address, privateKeyToAccount(throwawayKey).address, 'password-file trailing newline is ignored')

  chmodSync(passwordPath, 0o644)
  assert.throws(() => loadDeployerAccountFromKeystore({ keystorePath, passwordFilePath: passwordPath }), /must not be readable by group or others/)
  chmodSync(passwordPath, 0o600)
  chmodSync(keystorePath, 0o644)
  assert.throws(() => loadDeployerAccountFromKeystore({ keystorePath, passwordFilePath: passwordPath }), /must not be readable by group or others/)
  chmodSync(keystorePath, 0o600)
  writeFileSync(passwordPath, '\n', { mode: 0o600 })
  assert.throws(() => loadDeployerAccountFromKeystore({ keystorePath, passwordFilePath: passwordPath }), /empty/)
  writeFileSync(passwordPath, `${throwawayPassword}-wrong`, { mode: 0o600 })
  assert.throws(() => loadDeployerAccountFromKeystore({ keystorePath, passwordFilePath: passwordPath }), /could not be decrypted/)
  assert.throws(() => loadDeployerAccountFromKeystore({ keystorePath: join(keystoreDir, 'missing.json'), passwordFilePath: passwordPath }), /not found/)
  mkdirSync(join(keystoreDir, 'dir'))
  assert.throws(() => loadDeployerAccountFromKeystore({ keystorePath: join(keystoreDir, 'dir'), passwordFilePath: passwordPath }), /regular file/)
  assert.throws(() => loadDeployerAccountFromKeystore({ keystorePath: undefined, passwordFilePath: passwordPath }), /not configured/)
} finally {
  rmSync(keystoreDir, { recursive: true, force: true })
}

const deploySource = readFileSync(new URL('./deploy-auto-saver-testnet.mjs', import.meta.url), 'utf8')
assert.match(deploySource, /--broadcast/)
assert.match(deploySource, /--i-understand-this-broadcasts/)
assert.match(deploySource, /MOVY_TESTNET_DEPLOY_APPROVED !== 'YES'/)
assert.match(deploySource, /deployed-testnet-fresh\.json/)
assert.doesNotMatch(deploySource, /deployed-testnet\.json['"]\s*,\s*JSON\.stringify/)
// Gas estimation is a contract-creation estimate, never a function-less contract call.
assert.match(deploySource, /estimateDeploymentGas\(publicClient/)
assert.doesNotMatch(deploySource, /estimateContractGas/)
// No raw key or password enters through env, arguments, logs, or output.
assert.doesNotMatch(deploySource, /MOVY_DEPLOYER_KEY\b|privateKeyToAccount|ETH_PASSWORD\b|MOVY_DEPLOYER_PASSWORD\b|--password|--private-key/)
assert.match(deploySource, /MOVY_DEPLOYER_KEYSTORE/)
assert.match(deploySource, /MOVY_DEPLOYER_PASSWORD_FILE/)
assert.doesNotMatch(deploySource, /console\.(log|error|warn|info)\([^)]*(account\.|password|keystore)/i)
// Existing broadcast and fee gates are retained.
assert.match(deploySource, /MOVY_TESTNET_DEPLOY_APPROVED/)
assert.match(deploySource, /HARD_MAX_FEE_PER_GAS_WEI = 25_000_000_000n/)
assert.match(deploySource, /20% deployment gas buffer exceeds/)
assert.match(deploySource, /assertDeploymentTxFeeCap\(positiveIntegerEnv\('MOVY_DEPLOY_MAX_TX_FEE_WEI'\)\)/)
assert.ok(deploySource.indexOf('assertDeploymentTxFeeCap(positiveIntegerEnv') < deploySource.indexOf('createPublicClient({'), 'the fee cap is enforced before any client is created')
assert.match(deploySource, /refusing to overwrite/)

console.log('Fresh deployment role and fee preflight checks passed (offline; no Testnet writes)')
