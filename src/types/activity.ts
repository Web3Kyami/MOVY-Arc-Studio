export interface WalletActivityItem {
  paymentKey: string
  txHash: string
  logIndex: number
  blockNumber: number
  recipient: string
  amount6: string
  roundup6: string
  isEligible: boolean
  exclusionReason?: string
  roundupStatus: 'saved' | 'pending' | 'skipped' | 'failed' | 'whole_dollar'
  skipReason?: string
  relayerTxHash?: string
  createdAt: string
}
