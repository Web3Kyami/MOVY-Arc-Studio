import { encodeFunctionData, type Address, type Hex } from 'viem'
import { ACTIVE_NETWORK } from './chain'
import { getArcFeePolicy } from './fee-policy'

/**
 * Fee quoting over plain JSON-RPC.
 *
 * This deliberately does not use `useSimulateContract` or `useEstimateFeesPerGas`.
 * Both were observed to stay `pending` indefinitely in the running app without
 * ever issuing a request, which left Pay disabled with no diagnosable cause:
 * `getCode` via the wagmi public client and the contract simulation both hung,
 * while `useBalance` and `useReadContract` on the same transport worked. Whatever
 * the cause, a payment screen cannot depend on a hook that may never settle, so
 * the two calls that gate the button are made directly, each with its own timeout
 * and an explicit result type.
 *
 * Every state is distinguishable, so the UI can say *which* step failed instead of
 * showing one generic "try again".
 */

export type FeeState = 'pending' | 'ready' | 'error'

export interface FeeQuoteResult {
  state: FeeState
  gas: bigint
  maxFeePerGas: bigint
  /** Worst case: gas * maxFeePerGas. This is what a wallet may actually charge. */
  worstCaseWei: bigint
  /** Worst case plus a 25% margin, used to decide whether Pay can be enabled. */
  reserveWei: bigint
  error: string | null
}

export const NO_FEE: FeeQuoteResult = {
  state: 'pending',
  gas: 0n,
  maxFeePerGas: 0n,
  worstCaseWei: 0n,
  reserveWei: 0n,
  error: null,
}

const MARGIN_BPS = 2_500n
const BPS = 10_000n
const TIMEOUT_MS = 12_000
const FEE_POLICY = getArcFeePolicy(ACTIVE_NETWORK)

type RpcResult = { result?: string; error?: { message?: string } }

async function rpc<T = string>(
  url: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`)
  const body = (await response.json()) as RpcResult
  if (body.error) throw new Error(`${method}: ${body.error.message ?? 'node error'}`)
  if (body.result === undefined) throw new Error(`${method}: empty result`)
  return body.result as T
}

/**
 * Estimate the fee for one `payAndSave` call.
 *
 * @param totalWei The exact `msg.value` the contract requires, so the estimate
 *   reflects the real call rather than a bare transfer.
 */
export async function quotePayFee(opts: {
  rpcUrl: string
  contract: Address
  merchant: Address
  purchaseCents: bigint
  totalWei: bigint
  from: Address
}): Promise<FeeQuoteResult> {
  let data: Hex
  try {
    data = encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'payAndSave',
          stateMutability: 'payable',
          inputs: [
            { name: 'merchant', type: 'address' },
            { name: 'purchaseCents', type: 'uint256' },
          ],
          outputs: [],
        },
      ],
      functionName: 'payAndSave',
      args: [opts.merchant, opts.purchaseCents],
    })
  } catch (e) {
    return { ...NO_FEE, state: 'error', error: `could not encode the call: ${String(e).slice(0, 120)}` }
  }

  let gas: bigint
  let maxFeePerGas: bigint
  try {
    const [gasHex, priceHex] = await Promise.all([
      rpc(opts.rpcUrl, 'eth_estimateGas', [
        { from: opts.from, to: opts.contract, data, value: `0x${opts.totalWei.toString(16)}` },
      ]),
      rpc(opts.rpcUrl, 'eth_gasPrice', []),
    ])
    gas = BigInt(gasHex)
    const suggested = BigInt(priceHex)
    maxFeePerGas = suggested < FEE_POLICY.minBaseFeePerGasWei
      ? FEE_POLICY.minBaseFeePerGasWei
      : suggested
    if (maxFeePerGas > FEE_POLICY.maxFeePerGasWei) {
      throw new Error('Current network fee exceeds this release’s verified fee limit')
    }
  } catch (e) {
    return { ...NO_FEE, state: 'error', error: String((e as Error).message).slice(0, 160) }
  }

  if (gas === 0n) {
    return { ...NO_FEE, state: 'error', error: 'the node returned a zero gas estimate' }
  }

  const worstCaseWei = gas * maxFeePerGas
  if (FEE_POLICY.maxTransactionFeeWei !== null && worstCaseWei > FEE_POLICY.maxTransactionFeeWei) {
    return { ...NO_FEE, state: 'error', error: 'Estimated transaction fee exceeds this release’s verified transaction limit' }
  }
  return {
    state: 'ready',
    gas,
    maxFeePerGas,
    worstCaseWei,
    reserveWei: (worstCaseWei * (BPS + MARGIN_BPS)) / BPS,
    error: null,
  }
}

/** Fee for a `withdraw` call, which is not payable. */
export async function quoteWithdrawFee(opts: {
  rpcUrl: string
  contract: Address
  from: Address
}): Promise<FeeQuoteResult> {
  let data: Hex
  try {
    data = encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'withdraw',
          stateMutability: 'nonpayable',
          inputs: [{ name: 'amountWei', type: 'uint256' }],
          outputs: [],
        },
      ],
      functionName: 'withdraw',
      args: [1n],
    })
  } catch (e) {
    return { ...NO_FEE, state: 'error', error: `could not encode the call: ${String(e).slice(0, 120)}` }
  }

  try {
    const [gasHex, priceHex] = await Promise.all([
      rpc(opts.rpcUrl, 'eth_estimateGas', [{ from: opts.from, to: opts.contract, data }]),
      rpc(opts.rpcUrl, 'eth_gasPrice', []),
    ])
    const gas = BigInt(gasHex)
    const suggested = BigInt(priceHex)
    const maxFeePerGas = suggested < FEE_POLICY.minBaseFeePerGasWei
      ? FEE_POLICY.minBaseFeePerGasWei
      : suggested
    if (maxFeePerGas > FEE_POLICY.maxFeePerGasWei) {
      throw new Error('Current network fee exceeds this release’s verified fee limit')
    }
    const worstCaseWei = gas * maxFeePerGas
    if (FEE_POLICY.maxTransactionFeeWei !== null && worstCaseWei > FEE_POLICY.maxTransactionFeeWei) {
      throw new Error('Estimated transaction fee exceeds this release’s verified transaction limit')
    }
    return {
      state: 'ready',
      gas,
      maxFeePerGas,
      worstCaseWei,
      reserveWei: (worstCaseWei * (BPS + MARGIN_BPS)) / BPS,
      error: null,
    }
  } catch (e) {
    return { ...NO_FEE, state: 'error', error: String((e as Error).message).slice(0, 160) }
  }
}
