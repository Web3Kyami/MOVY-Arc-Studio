import assert from 'node:assert/strict'
import { isReadOnlyRpcMethod, READ_ONLY_RPC_METHODS } from './verify/connected-rpc-policy.mjs'

for (const method of READ_ONLY_RPC_METHODS) assert.equal(isReadOnlyRpcMethod(method), true)
assert.equal(isReadOnlyRpcMethod('eth_blockNumber'), true, 'wallet clients need the current read-only block height')
for (const method of [
  'eth_sendTransaction', 'eth_sendRawTransaction', 'eth_sign', 'personal_sign',
  'eth_signTypedData_v4', 'wallet_sendCalls', 'wallet_sendTransaction', 'wallet_unknown',
  'debug_traceTransaction', 'unknown_method',
]) assert.equal(isReadOnlyRpcMethod(method), false, `${method} must not be forwarded to the RPC`)
console.log('Connected verification RPC method allowlist regressions passed')
