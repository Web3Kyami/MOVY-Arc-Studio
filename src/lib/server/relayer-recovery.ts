export interface RelayerReceiptLike {
  status: string
}

export type SubmissionRecoveryResult = 'pending' | 'confirmed' | 'failed'

export type ReceiptResolution =
  | { status: 'pending'; reason: string }
  | { status: 'confirmed' }
  | { status: 'failed'; reason: string }

export async function submitAndPersistRelayerTransaction<Hash extends string, Receipt extends RelayerReceiptLike>(options: {
  markSubmitting: () => void | Promise<void>
  broadcast: () => Promise<Hash>
  persistHash: (hash: Hash) => void | Promise<void>
  waitForReceipt: (hash: Hash) => Promise<Receipt>
}): Promise<{ hash: Hash; receipt: Receipt }> {
  await options.markSubmitting()
  const hash = await options.broadcast()
  await options.persistHash(hash)
  const receipt = await options.waitForReceipt(hash)
  return { hash, receipt }
}

export async function reconcileSubmittedRelayerTransaction<Hash extends string, Receipt extends RelayerReceiptLike>(options: {
  hash: Hash
  getReceipt: (hash: Hash) => Promise<Receipt | null>
  resolveReceipt: (receipt: Receipt, hash: Hash) => Promise<ReceiptResolution>
  persistFinalStatus: (resolution: Exclude<ReceiptResolution, { status: 'pending' }>, hash: Hash) => void | Promise<void>
}): Promise<SubmissionRecoveryResult> {
  let receipt: Receipt | null
  try {
    receipt = await options.getReceipt(options.hash)
  } catch {
    // Missing receipts, RPC timeouts, and temporary provider failures are all
    // treated as pending. Never turn uncertainty into another broadcast.
    return 'pending'
  }
  if (!receipt) return 'pending'

  const resolution = await options.resolveReceipt(receipt, options.hash)
  if (resolution.status === 'pending') return 'pending'
  await options.persistFinalStatus(resolution, options.hash)
  return resolution.status
}
