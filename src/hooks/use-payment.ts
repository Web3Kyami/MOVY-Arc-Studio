'use client'

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import type { Address, Hash } from 'viem'
import { useQueryClient } from '@tanstack/react-query'
import { useWallet } from './use-wallet'
import { MOVY_ABI } from '@/lib/contract'
import { arcRpcUrl } from './use-wallet'
import { NO_FEE, quoteWithdrawFee, type FeeQuoteResult } from '@/lib/fees'
import { shouldQuoteWithdrawalFee } from '@/lib/withdrawal-fee-policy'
import { submitVaultWithdrawal } from '@/lib/savings-accounting'
import { useSavings } from './use-savings'
import { ACTIVE_NETWORK, ACTIVE_NETWORK_LABEL } from '@/lib/chain'
import { getArcFeePolicy } from '@/lib/fee-policy'

export type TxPhase =
  | 'idle'
  | 'editing'
  | 'review'
  | 'awaitingSignature'
  | 'submitted'
  | 'confirmed'
  | 'failed'

export interface FeeQuote {
  state: 'pending' | 'ready' | 'error'
  gas: bigint
  maxFeePerGas: bigint
  /** Worst-case fee: gas * maxFeePerGas. This is what the wallet may charge. */
  worstCaseWei: bigint
  /** worstCase + 25% margin, used to gate the Pay button. */
  reserveWei: bigint
  isLoading: boolean
  error: string | null
}

function toFeeQuote(result: FeeQuoteResult | undefined): FeeQuote {
  if (!result) return { ...NO_FEE, isLoading: true }
  return {
    state: result.state,
    gas: result.gas,
    maxFeePerGas: result.maxFeePerGas,
    worstCaseWei: result.worstCaseWei,
    reserveWei: result.reserveWei,
    isLoading: result.state === 'pending',
    error: result.error,
  }
}

/** EIP-1559 tip. Arc accepts 0, but a small tip shortens inclusion time. */
const PRIORITY_FEE_WEI = getArcFeePolicy(ACTIVE_NETWORK).priorityFeePerGasWei

export interface PendingTx {
  chainId: number
  sender: Address
  hash: Hash
  kind: 'pay' | 'withdraw'
  submittedAt: number
  purchaseCents: string
  merchant?: Address
  label?: string
}

const PENDING_KEY = 'movy.pending.v1'

function readPending(): PendingTx[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.sessionStorage.getItem(PENDING_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as PendingTx[]) : []
  } catch {
    return []
  }
}

function writePending(items: PendingTx[]) {
  if (typeof window === 'undefined') return
  try {
    if (items.length === 0) window.sessionStorage.removeItem(PENDING_KEY)
    else window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(items))
  } catch {
    /* ignore */
  }
}

export function useWithdraw({ enabled = true }: { enabled?: boolean } = {}) {
  const wallet = useWallet()
  const savings = useSavings()
  const queryClient = useQueryClient()
  const [phase, setPhase] = useState<TxPhase>('idle')
  const [hash, setHash] = useState<Hash | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const contract = wallet.contract
  const canWrite = wallet.isConnected && !wallet.isWrongNetwork && contract !== undefined
  const legacyVaultWei = savings.legacyVault.status === 'ready' ? savings.legacyVault.value : 0n

  const withdrawFeeQuery = useQuery({
    queryKey: ['withdraw-fee', wallet.network, contract, wallet.address],
    enabled: shouldQuoteWithdrawalFee({
      enabled,
      canWrite,
      hasAddress: wallet.address !== undefined,
      legacyVaultStatus: savings.legacyVault.status,
      legacyVaultWei,
    }),
    staleTime: 15_000,
    retry: 1,
    queryFn: async () => {
      if (!contract || !wallet.address) return NO_FEE
      return quoteWithdrawFee({
        rpcUrl: arcRpcUrl(wallet.network),
        contract,
        from: wallet.address,
      })
    },
  })

  const write = useWriteContract()
  const receipt = useWaitForTransactionReceipt({ hash: hash ?? undefined })

  const feeQuote: FeeQuote = useMemo(
    () => toFeeQuote(withdrawFeeQuery.data),
    [withdrawFeeQuery.data],
  )

  useEffect(() => {
    if (phase === 'submitted' && receipt.data) void queryClient.invalidateQueries()
  }, [phase, receipt.data, queryClient])

  const effectivePhase: TxPhase =
    phase === 'submitted' && receipt.data
      ? receipt.data.status === 'success'
        ? 'confirmed'
        : 'failed'
      : phase

  const submit = useCallback(
    async (amountWei: bigint) => {
      if (phase === 'awaitingSignature' || phase === 'submitted') return false
      setErrorMessage(null)
      setHash(null)
      if (amountWei <= 0n) {
        setErrorMessage('Enter a withdrawal amount greater than zero.')
        setPhase('failed')
        return false
      }
      if (!wallet.isConnected || !canWrite || contract === undefined) {
        setErrorMessage(wallet.isWrongNetwork
          ? `Switch to ${ACTIVE_NETWORK_LABEL} before withdrawing.`
          : `Connect a wallet on ${ACTIVE_NETWORK_LABEL} before withdrawing.`)
        setPhase('failed')
        return false
      }
      if (feeQuote.state !== 'ready') {
        setErrorMessage(feeQuote.error || `Unable to verify the ${ACTIVE_NETWORK_LABEL} withdrawal fee.`)
        setPhase('failed')
        return false
      }
      if (wallet.isBalanceLoading) {
        setErrorMessage('Checking your spending-wallet balance for the network fee. No withdrawal was submitted.')
        setPhase('failed')
        return false
      }
      if (wallet.isBalanceError) {
        setErrorMessage('Unable to verify your spending-wallet balance for the network fee. No withdrawal was submitted.')
        setPhase('failed')
        return false
      }
      if (wallet.nativeWei < feeQuote.reserveWei) {
        setErrorMessage('Your spending wallet does not have enough USDC to cover the withdrawal network fee.')
        setPhase('failed')
        return false
      }
      try {
        const guardedSubmission = await submitVaultWithdrawal(
          amountWei,
          savings.refetchLegacyVault,
          (verifiedAmountWei) => {
            setPhase('awaitingSignature')
            return write.writeContractAsync({
              address: contract,
              abi: MOVY_ABI,
              functionName: 'withdraw',
              args: [verifiedAmountWei],
              chainId: wallet.expectedChain.id,
              account: wallet.address,
              // Apply the same selected-network fee policy to withdrawals.
              maxFeePerGas: feeQuote.maxFeePerGas,
              maxPriorityFeePerGas: PRIORITY_FEE_WEI,
            })
          },
        )

        if (!guardedSubmission.ok) {
          setErrorMessage(
            guardedSubmission.reason === 'invalid-amount'
              ? 'Enter a withdrawal amount greater than zero.'
              : guardedSubmission.reason === 'exceeds-balance'
                ? 'The amount is above the latest verified MOVY vault balance. No transaction was submitted.'
                : `The MOVY vault balance could not be verified on ${ACTIVE_NETWORK_LABEL}. No transaction was submitted.`,
          )
          setPhase('failed')
          return false
        }

        const result = guardedSubmission.result
        setHash(result)
        setPhase('submitted')
        writePending([
          ...readPending(),
          {
            chainId: wallet.expectedChain.id,
            sender: wallet.address!,
            hash: result,
            kind: 'withdraw',
            submittedAt: Date.now(),
            purchaseCents: '0',
          },
        ])
        return true
      } catch (e) {
        setErrorMessage(describeWriteError(e))
        setPhase('failed')
        return false
      }
    },
    [canWrite, contract, write, wallet, feeQuote, phase, savings.refetchLegacyVault],
  )

  const feePaidWei = useMemo(() => {
    if (!receipt.data) return null
    return receipt.data.gasUsed * (receipt.data.effectiveGasPrice ?? 0n)
  }, [receipt.data])

  const refreshReceipt = receipt.refetch

  return {
    feeQuote,
    phase: effectivePhase,
    setPhase,
    hash,
    receipt: receipt.data ?? null,
    feePaidWei,
    errorMessage,
    submit,
    reset: () => {
      setPhase('idle')
      setHash(null)
      setErrorMessage(null)
    },
    isConfirming: receipt.isLoading,
    isReceiptError: receipt.isError && !receipt.data,
    isReceiptLoading: receipt.isFetching,
    refreshReceipt,
  }
}

/**
 * Submitted-but-unconfirmed transactions, read from session storage.
 *
 * `useSyncExternalStore` is the correct primitive here: session storage is an
 * external store, and copying it into `useState` inside an effect would both
 * trip the React compiler rules and render a stale empty list on the first pass.
 * The snapshot is cached because `getSnapshot` must return a stable reference
 * between store notifications.
 */
let pendingCache: PendingTx[] | null = null
const EMPTY_PENDING: PendingTx[] = []

function subscribeToPending(onChange: () => void) {
  window.addEventListener('storage', onChange)
  return () => window.removeEventListener('storage', onChange)
}

function getPendingSnapshot(): PendingTx[] {
  if (pendingCache === null) pendingCache = readPending()
  return pendingCache
}

/** Call after mutating storage so subscribers re-read. */
export function invalidatePending() {
  pendingCache = null
  window.dispatchEvent(new Event('storage'))
}

export function usePendingTransactions() {
  const items = useSyncExternalStore(subscribeToPending, getPendingSnapshot, () => EMPTY_PENDING)

  const clear = useCallback((hash: Hash) => {
    writePending(readPending().filter((p) => p.hash !== hash))
    invalidatePending()
  }, [])

  return { items, clear }
}

function describeWriteError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  if (/user rejected|user denied|rejected the request/i.test(message)) {
    return 'You rejected the request in your wallet. Nothing was paid.'
  }
  if (/insufficient funds/i.test(message)) {
    return 'This wallet does not have enough USDC for the total plus the network fee.'
  }
  if (/underpriced/i.test(message)) {
    return 'The network fee is below the verified minimum for this release. Try again.'
  }
  return message.split('\n')[0]
}

export { readPending, writePending, describeWriteError }
