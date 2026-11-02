import {
  createPublicClient,
  http,
  toEventSelector,
  type Address,
  type Hash,
  type PublicClient,
  type LogTopic,
} from 'viem'
import { ACTIVE_CHAIN, ACTIVE_NETWORK, type ArcNetwork } from './chain'
import { MOVY_ABI } from './contract'
import { weiToCents } from './money'

export interface Purchase {
  /** `chainId:txHash:logIndex`, per `DATA-MODEL.md` indexing rules. */
  key: string
  chainId: number
  txHash: Hash
  logIndex: number
  blockNumber: bigint
  timestamp: number
  payer: Address
  merchant: Address
  purchaseWei: bigint
  roundupWei: bigint
  purchaseCents: bigint
  roundupCents: bigint
  totalCents: bigint
  status: 'confirmed' | 'pending' | 'failed'
  feeWei: bigint | null
  label: string
}

export interface Withdrawal {
  key: string
  chainId: number
  txHash: Hash
  logIndex: number
  blockNumber: bigint
  timestamp: number
  owner: Address
  amountWei: bigint
  amountCents: bigint
  status: 'confirmed' | 'pending' | 'failed'
  feeWei: bigint | null
}

export function publicClientFor(network: ArcNetwork): PublicClient {
  if (network !== ACTIVE_NETWORK) throw new Error('RPC reads cannot cross the selected MOVY network')
  return createPublicClient({ chain: ACTIVE_CHAIN, transport: http(ACTIVE_CHAIN.rpcUrls.default.http[0]) })
}

/**
 * Event topics, derived from the ABI rather than hand-copied hex, so a signature
 * change in the contract cannot leave a stale topic string behind. Indexed
 * parameters are part of the signature but the `indexed` keyword is not.
 */
function topicFor(eventName: string): `0x${string}` {
  const entry = MOVY_ABI.find((x) => x.type === 'event' && x.name === eventName)
  if (!entry || entry.type !== 'event') throw new Error(`no event ${eventName} in MOVY_ABI`)
  const signature = `${entry.name}(${entry.inputs.map((input) => input.type).join(',')})`
  return toEventSelector(signature)
}

export const PURCHASE_TOPIC = topicFor('PurchaseRounded')
export const WITHDRAW_TOPIC = topicFor('SavingsWithdrawn')

/**
 * Find the first block in which the contract had code.
 *
 * `DATA-MODEL.md` requires bounded block windows rather than scanning from
 * genesis. This binary search is O(log n) requests and the result is meant to be
 * pinned into `NEXT_PUBLIC_MOVY_DEPLOY_BLOCK_*` afterwards.
 */
export async function findDeploymentBlock(
  client: PublicClient,
  address: Address,
): Promise<bigint> {
  const head = await client.getBlockNumber()
  let lo = 0n
  let hi = head
  while (lo < hi) {
    const mid = (lo + hi) / 2n
    const code = await client.getCode({ address, blockNumber: mid })
    if (code && code !== '0x') hi = mid
    else lo = mid + 1n
  }
  return lo
}

/**
 * A single `eth_getLogs` window.
 *
 * This uses the *low-level* `client.request` rather than viem's `getLogs` on
 * purpose, so the raw `topics` filter can be applied by the node. The trade-off is
 * that the low-level path does **not** throw on a JSON-RPC error: it resolves with
 * the error object. Swallowing that produced `cannot read properties of undefined
 * (reading 'map')` when Arc's node rejected a range with "requested range too
 * large", hiding the one message worth showing. So the error is unwrapped here.
 */
async function getLogWindow(
  client: PublicClient,
  filter: { address: Address; fromBlock: bigint; toBlock: bigint; topics: LogTopic[] },
): Promise<RawLog[]> {
  const response = await client.request({
    method: 'eth_getLogs',
    params: [
      {
        address: filter.address,
        fromBlock: `0x${filter.fromBlock.toString(16)}` as `0x${string}`,
        toBlock: `0x${filter.toBlock.toString(16)}` as `0x${string}`,
        topics: filter.topics,
      },
    ],
  })

  const maybeError = response as { error?: { message?: string } }
  if (maybeError?.error) {
    throw new Error(maybeError.error.message ?? 'the node rejected the log query')
  }
  const data = response
  if (!Array.isArray(data)) {
    throw new Error('the node returned an unexpected response to the log query')
  }
  return data as RawLog[]
}

export interface RawLog {
  data: string
  blockNumber: string
  transactionHash: Hash
  logIndex: string
  topics: string[]
}

/**
 * Block-timestamp cache.
 *
 * `fetchPurchases` needs a timestamp per row, and an uncached `getBlock` per row
 * multiplies the request count. Activity rows are immutable once mined, so a
 * timestamp never needs refetching. Bounded so a long session cannot grow without
 * limit.
 */
const blockCache = new Map<string, number>()
const BLOCK_CACHE_LIMIT = 500

async function blockTimestamp(client: PublicClient, blockNumber: bigint): Promise<number> {
  const key = `${await client.getChainId()}:${blockNumber}`
  const hit = blockCache.get(key)
  if (hit !== undefined) return hit
  const block = await client.getBlock({ blockNumber })
  const timestamp = Number(block.timestamp) * 1000
  if (blockCache.size >= BLOCK_CACHE_LIMIT) {
    const oldest = blockCache.keys().next().value
    if (oldest !== undefined) blockCache.delete(oldest)
  }
  blockCache.set(key, timestamp)
  return timestamp
}

/**
 * Read `PurchaseRounded` events for one payer inside a bounded window.
 *
 * Keyed by `chainId:txHash:logIndex`, filtered by the indexed payer topic, and
 * never inferred from generic `Transfer` logs â€” `DATA-MODEL.md` explicitly warns
 * that Arc's system emitter makes generic indexers double-count native moves.
 */
export async function fetchPurchases(
  client: PublicClient,
  opts: {
    address: Address
    payer: Address
    fromBlock: bigint
    toBlock?: bigint
    limit?: number
    extraPending?: Map<string, { status: Purchase['status']; feeWei: bigint | null }>
  },
): Promise<Purchase[]> {
  const { address, payer, fromBlock } = opts
  const toBlock = opts.toBlock ?? (await client.getBlockNumber())
  const limit = opts.limit ?? 50
  if (toBlock < fromBlock) return []

  const payerTopic = payer.toLowerCase().slice(2).padStart(64, '0')

  const raw = await getLogWindow(client, {
    address,
    fromBlock,
    toBlock,
    topics: [PURCHASE_TOPIC, `0x${payerTopic}`],
  })

  const rows = raw.map((log) => {
    // Two non-indexed words: purchaseWei, roundupWei.
    const purchaseWei = BigInt(`0x${log.data.slice(2, 66)}`)
    const roundupWei = BigInt(`0x${log.data.slice(66)}`)
    const merchant = `0x${log.topics[2].slice(26)}` as Address
    return {
      txHash: log.transactionHash as Hash,
      logIndex: Number(BigInt(log.logIndex)),
      blockNumber: BigInt(log.blockNumber),
      purchaseWei,
      roundupWei,
      merchant,
    }
  })

  const unique = new Map<string, (typeof rows)[number]>()
  for (const row of rows) {
    const chainId = await client.getChainId()
    unique.set(`${chainId}:${row.txHash}:${row.logIndex}`, row)
  }

  const chainId = await client.getChainId()
  const sorted = [...unique.values()].sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? b.logIndex - a.logIndex
      : a.blockNumber > b.blockNumber
        ? -1
        : 1,
  )

  const out: Purchase[] = []
  for (const row of sorted.slice(0, limit)) {
    const key = `${chainId}:${row.txHash}:${row.logIndex}`
    const timestamp = await blockTimestamp(client, row.blockNumber)
    const override = opts.extraPending?.get(row.txHash.toLowerCase())
    out.push({
      key,
      chainId,
      txHash: row.txHash,
      logIndex: row.logIndex,
      blockNumber: row.blockNumber,
      timestamp,
      payer,
      merchant: row.merchant,
      purchaseWei: row.purchaseWei,
      roundupWei: row.roundupWei,
      purchaseCents: weiToCents(row.purchaseWei),
      roundupCents: weiToCents(row.roundupWei),
      totalCents: weiToCents(row.purchaseWei + row.roundupWei),
      status: override?.status ?? 'confirmed',
      feeWei: override?.feeWei ?? null,
      label: 'Merchant',
    })
  }
  return out
}

/** Read `SavingsWithdrawn` events for one owner, used by the Savings contributions list. */
export async function fetchWithdrawals(
  client: PublicClient,
  opts: { address: Address; owner: Address; fromBlock: bigint; toBlock?: bigint; limit?: number },
): Promise<Withdrawal[]> {
  const { address, owner, fromBlock } = opts
  const toBlock = opts.toBlock ?? (await client.getBlockNumber())
  if (toBlock < fromBlock) return []

  const ownerTopic = owner.toLowerCase().slice(2).padStart(64, '0')
  const raw = await getLogWindow(client, {
    address,
    fromBlock,
    toBlock,
    topics: [WITHDRAW_TOPIC, `0x${ownerTopic}`],
  })

  const chainId = await client.getChainId()
  const rows = raw.map((log) => ({
    txHash: log.transactionHash as Hash,
    logIndex: Number(BigInt(log.logIndex)),
    blockNumber: BigInt(log.blockNumber),
    amountWei: BigInt(`0x${log.data.slice(2)}`),
  }))

  const seen = new Set<string>()
  const out: Withdrawal[] = []
  for (const row of rows.reverse().slice(0, opts.limit ?? 50)) {
    const key = `${chainId}:${row.txHash}:${row.logIndex}`
    if (seen.has(key)) continue
    seen.add(key)
    const timestamp = await blockTimestamp(client, row.blockNumber)
    out.push({
      key,
      chainId,
      txHash: row.txHash,
      logIndex: row.logIndex,
      blockNumber: row.blockNumber,
      timestamp,
      owner,
      amountWei: row.amountWei,
      amountCents: weiToCents(row.amountWei),
      status: 'confirmed',
      feeWei: null,
    })
  }
  return out
}
