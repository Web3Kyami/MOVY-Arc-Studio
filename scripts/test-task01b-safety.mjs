import assert from 'node:assert/strict'
import {
  CANONICAL_ARC_USDC,
  SYSTEM_USDC_EMITTER,
  ZERO_ADDRESS,
  validateSavingsDestination,
  verifyDestinationBytecodeOnchain,
} from '../src/lib/destination-rules.ts'
import { ACTIVE_CHAIN } from '../src/lib/chain.ts'

const wallet = '0xa718575086d7e01d1df36d3c01c0f0a5ef30e521'
const validDestination = '0x7777777777777777777777777777777777777777'
const restrictedAddresses = {
  legacyCheckout: '0x1111111111111111111111111111111111111111',
  autoSaver: '0x2222222222222222222222222222222222222222',
  merchant: '0x3333333333333333333333333333333333333333',
}

const invalidCases = [
  ['', 'REQUIRED'],
  ['not-an-address', 'INVALID_FORMAT'],
  [ZERO_ADDRESS, 'ZERO_ADDRESS'],
  [wallet.toUpperCase().replace('0X', '0x'), 'SELF_LOOP'],
  [restrictedAddresses.legacyCheckout, 'INCOMPATIBLE_LEGACY_CONTRACT'],
  [CANONICAL_ARC_USDC, 'INCOMPATIBLE_TOKEN_CONTRACT'],
  [restrictedAddresses.autoSaver, 'INCOMPATIBLE_AUTOSAVER_CONTRACT'],
  [restrictedAddresses.merchant, 'INCOMPATIBLE_MERCHANT_ADDRESS'],
  [SYSTEM_USDC_EMITTER, 'INCOMPATIBLE_SYSTEM_ADDRESS'],
]

for (const [destination, code] of invalidCases) {
  const result = validateSavingsDestination({ destination, walletAddress: wallet, restrictedAddresses })
  assert.equal(result.valid, false, `${destination || 'empty destination'} is rejected`)
  assert.equal(result.code, code)
}

assert.deepEqual(validateSavingsDestination({ destination: validDestination, walletAddress: wallet, restrictedAddresses }), {
  valid: true,
  error: null,
  code: 'OK',
})

const originalFetch = globalThis.fetch
const rpcRequests = []
let mockedBytecode = '0x'
try {
  globalThis.fetch = async (url, init) => {
    const request = JSON.parse(init.body)
    rpcRequests.push({ url, ...request })
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: mockedBytecode }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const eoa = await verifyDestinationBytecodeOnchain({ destination: validDestination })
  assert.equal(eoa.valid, true)
  assert.equal(eoa.isContract, false)
  assert.equal(eoa.isEoa, true)
  assert.match(eoa.warning, /does not prove you own the private keys/i)

  mockedBytecode = '0x6001600055'
  const contract = await verifyDestinationBytecodeOnchain({ destination: validDestination })
  assert.equal(contract.valid, false)
  assert.equal(contract.isContract, true)
  assert.equal(contract.isEoa, false)
  assert.equal(contract.bytecodeBytes, 5)
  assert.equal(contract.code, 'INCOMPATIBLE_CONTRACT')

  assert.deepEqual(rpcRequests.map(({ method }) => method), ['eth_getCode', 'eth_getCode'])
  assert.ok(rpcRequests.every(({ url, params }) => url === ACTIVE_CHAIN.rpcUrls.default.http[0] && params[1] === 'latest'))

  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'mock unavailable' } }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  })
  const unavailable = await verifyDestinationBytecodeOnchain({ destination: validDestination })
  assert.equal(unavailable.valid, false)
  assert.equal(unavailable.isContract, null)
  assert.equal(unavailable.code, 'BYTECODE_CHECK_FAILED')

  const malformed = await verifyDestinationBytecodeOnchain({ destination: '0x12' })
  assert.equal(malformed.code, 'INVALID_FORMAT')
  assert.equal(rpcRequests.length, 2, 'Malformed addresses never reach the RPC')
} finally {
  globalThis.fetch = originalFetch
}

console.log('Destination validation and mocked Arc bytecode safety regressions passed; no network or database access was used')
