export const READ_ONLY_RPC_METHODS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBalance',
  'eth_getCode',
  'eth_call',
  'eth_getLogs',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getTransactionCount',
  'eth_gasPrice',
  'eth_feeHistory',
  'eth_estimateGas',
  'net_version',
])

export function isReadOnlyRpcMethod(method) {
  return READ_ONLY_RPC_METHODS.has(method)
}
