'use client'

import { useAccount, usePublicClient, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { MOVY_AUTO_SAVER_ABI, ERC20_ABI } from '@/lib/abi/movy-auto-saver'
import { CANONICAL_ARC_USDC, ACTIVE_CHAIN_ID, ACTIVE_NETWORK_LABEL } from '@/lib/chain'
import { movyAutoSaverAddress } from '@/lib/contract'
import { shouldReadEnrollmentStatus } from '@/lib/enrollment-read-policy'
import { ACTIVE_NETWORK } from '@/lib/chain'
import { assertAutoSaverWriteAllowed, isUnsafeAutoSaverAddress } from '@/lib/auto-saver-write-safety'
import {
  EnrollmentBackendSyncError,
  isEnrollmentSyncReliable,
  isRevocationSyncReliable,
  syncEnrollmentWithRetry,
  waitForSuccessfulReceipt,
} from '@/lib/enrollment-activation'
import {
  applyAllowanceTargetAndConfirm,
  revokeEnrollmentWithConfirmation,
  syncConfirmedAllowanceWithEnrollment,
  type WalletContextSnapshot,
} from '@/lib/spending-permissions'
import { resolveGlobalPauseRead, type GlobalPauseRead } from '@/lib/global-pause'
import type { Address, Hash } from 'viem'

interface BackendEnrollmentRecord {
  chainId: number
  wallet: string
  status: 'active' | 'paused' | 'revoked'
  configEpoch: number
}

interface BackendEnrollmentStatus {
  enrollment: BackendEnrollmentRecord | null
  onchainConfig: unknown
}

interface PendingEnrollmentSync {
  transactionHash: Hash
  allowedStatuses: Array<'active' | 'paused' | 'revoked'>
  wallet: Address
  chainId: number
}

export interface AutoSaverConfig {
  destination: Address
  maxRoundup6: bigint
  dailyCap6: bigint
  configEpoch: number
  paused: boolean
  enrolled: boolean
}

export function useAutoSaver({ enabled = true }: { enabled?: boolean } = {}) {
  const { address, isConnected, chainId } = useAccount()
  const walletContextRef = useRef<WalletContextSnapshot>({ isConnected, address, chainId })
  useEffect(() => {
    walletContextRef.current = { isConnected, address, chainId }
  }, [isConnected, address, chainId])
  const publicClient = usePublicClient({ chainId: ACTIVE_CHAIN_ID })
  const queryClient = useQueryClient()
  const contractAddress = movyAutoSaverAddress(ACTIVE_NETWORK)
  const financialWritesBlocked = isUnsafeAutoSaverAddress(ACTIVE_NETWORK, contractAddress)
  const isCorrectChain = chainId === ACTIVE_CHAIN_ID // Deployment target is fixed at build time.

  // 1. Read onchain user configuration
  const {
    data: configData,
    isLoading: isConfigLoading,
    isError: isConfigError,
    error: configError,
    refetch: refetchConfig,
  } = useReadContract({
    address: contractAddress,
    abi: MOVY_AUTO_SAVER_ABI,
    functionName: 'getUserConfig',
    args: address ? [address] : undefined,
    query: {
      enabled: Boolean(enabled && isConnected && address && contractAddress && isCorrectChain),
      refetchInterval: 5000,
    },
  })

  // 2. Read onchain ERC-20 USDC allowance granted to MovyAutoSaver
  const {
    data: allowanceData,
    isLoading: isAllowanceLoading,
    isError: isAllowanceError,
    refetch: refetchAllowance,
  } = useReadContract({
    address: CANONICAL_ARC_USDC,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: address && contractAddress ? [address, contractAddress] : undefined,
    query: {
      enabled: Boolean(enabled && isConnected && address && contractAddress && isCorrectChain),
      refetchInterval: 5000,
    },
  })

  // 3. Read remaining daily allowance
  const {
    data: remainingDailyData,
    isLoading: isDailyLoading,
    refetch: refetchDaily,
  } = useReadContract({
    address: contractAddress,
    abi: MOVY_AUTO_SAVER_ABI,
    functionName: 'getRemainingDailyAllowance',
    args: address ? [address] : undefined,
    query: {
      enabled: Boolean(enabled && isConnected && address && contractAddress && isCorrectChain),
      refetchInterval: 5000,
    },
  })

  // 3b. Read the contract-wide emergency pause. This is the owner's switch, separate from
  // the user's personal pause, and it is read on the build's selected chain. It is only
  // applicable with a connected wallet on that chain, so a disconnect or network change
  // resolves to `idle` instead of carrying an earlier reading forward.
  const globalPauseApplicable = Boolean(enabled && isConnected && address && contractAddress && isCorrectChain)
  const {
    data: globalPausedData,
    isError: isGlobalPauseError,
    isStale: isGlobalPauseStale,
    refetch: refetchGlobalPauseRead,
  } = useReadContract({
    address: contractAddress,
    abi: MOVY_AUTO_SAVER_ABI,
    functionName: 'paused',
    chainId: ACTIVE_CHAIN_ID,
    query: {
      enabled: globalPauseApplicable,
      staleTime: 5000,
      refetchInterval: 5000,
    },
  })
  const globalPause: GlobalPauseRead = resolveGlobalPauseRead({
    applicable: globalPauseApplicable,
    contractConfigured: Boolean(contractAddress),
    isError: isGlobalPauseError,
    isStale: isGlobalPauseStale,
    data: globalPausedData,
  })
  const refetchGlobalPause = () => refetchGlobalPauseRead()

  // 4. Query backend sync status & stats
  const {
    data: serverStatus,
    refetch: refetchServerStatus,
    isLoading: isServerStatusLoading,
    isError: isServerStatusError,
    error: serverStatusError,
  } = useQuery<BackendEnrollmentStatus | null>({
    queryKey: ['autoSaverServer', address, chainId],
    queryFn: async () => {
      if (!address) return null
      const res = await fetch(`/api/enrollment?wallet=${address}&chainId=${chainId || ACTIVE_CHAIN_ID}`)
      if (!res.ok) throw new Error('Enrollment status is temporarily unavailable')
      return res.json()
    },
    enabled: shouldReadEnrollmentStatus({
      enabled,
      isConnected,
      hasAddress: Boolean(address),
      chainId,
      expectedChainId: ACTIVE_CHAIN_ID,
    }),
    refetchInterval: 5000,
  })

  // Write actions
  const { writeContractAsync } = useWriteContract()
  const [isPendingTx, setIsPendingTx] = useState(false)
  const [lastTxHash, setLastTxHash] = useState<`0x${string}` | null>(null)
  const [isBackendSyncPending, setIsBackendSyncPending] = useState(false)
  const [backendSyncError, setBackendSyncError] = useState<string | null>(null)
  const [confirmedBackendEnrollment, setConfirmedBackendEnrollment] = useState<BackendEnrollmentRecord | null>(null)
  const pendingBackendSync = useRef<PendingEnrollmentSync | null>(null)

  const { isLoading: isWaitingReceipt } = useWaitForTransactionReceipt({
    hash: lastTxHash ?? undefined,
    query: {
      enabled: Boolean(lastTxHash),
    },
  })

  const assertActiveChain = () => {
    if (!isCorrectChain) throw new Error(`Switch to ${ACTIVE_NETWORK_LABEL} (chain ${ACTIVE_CHAIN_ID}) before changing savings settings.`)
  }

  const submitAndConfirm = async (hash: Hash): Promise<Hash> => {
    setLastTxHash(hash)
    if (!publicClient) throw new Error(`${ACTIVE_NETWORK_LABEL} transaction receipt service is unavailable. Try again shortly.`)
    await waitForSuccessfulReceipt(hash, async (transactionHash) =>
      publicClient.waitForTransactionReceipt({ hash: transactionHash as Hash })
    )
    return hash
  }

  const syncBackend = async (pending: PendingEnrollmentSync): Promise<BackendEnrollmentRecord> => {
    if (pending.chainId !== ACTIVE_CHAIN_ID) {
      throw new EnrollmentBackendSyncError(`Only ${ACTIVE_NETWORK_LABEL} enrollment records can be synchronized.`, { retryable: false, transactionHash: pending.transactionHash })
    }
    setIsBackendSyncPending(true)
    setBackendSyncError(null)
    try {
      const enrollment = await syncEnrollmentWithRetry<BackendEnrollmentRecord>(() => fetch('/api/enrollment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chainId: pending.chainId, wallet: pending.wallet }),
      }), { allowedStatuses: pending.allowedStatuses })
      if (enrollment.chainId !== pending.chainId || enrollment.wallet.toLowerCase() !== pending.wallet.toLowerCase()) {
        throw new EnrollmentBackendSyncError('MOVY returned an enrollment record for a different wallet or network.', {
          retryable: false,
          transactionHash: pending.transactionHash,
        })
      }
      if (!contractAddress) {
        throw new EnrollmentBackendSyncError(`The ${ACTIVE_NETWORK_LABEL} AutoSaver contract is not configured.`, {
          retryable: false,
          transactionHash: pending.transactionHash,
        })
      }
      if (!publicClient) {
        throw new EnrollmentBackendSyncError(`MOVY cannot verify the ${ACTIVE_NETWORK_LABEL} enrollment until RPC access returns.`, {
          retryable: true,
          transactionHash: pending.transactionHash,
        })
      }
      const onchainConfig = await publicClient.readContract({
        address: contractAddress,
        abi: MOVY_AUTO_SAVER_ABI,
        functionName: 'getUserConfig',
        args: [pending.wallet],
      })
      const recordIsConfirmed = pending.allowedStatuses.includes('revoked')
        ? isRevocationSyncReliable(onchainConfig, enrollment, pending.wallet, pending.chainId)
        : isEnrollmentSyncReliable(onchainConfig, enrollment, pending.wallet, pending.chainId)
      if (!recordIsConfirmed) {
        throw new EnrollmentBackendSyncError(`MOVY has not verified the latest ${ACTIVE_NETWORK_LABEL} enrollment configuration yet.`, {
          retryable: true,
          status: 200,
          transactionHash: pending.transactionHash,
        })
      }
      pendingBackendSync.current = null
      setConfirmedBackendEnrollment(enrollment)
      setBackendSyncError(null)
      queryClient.setQueryData<BackendEnrollmentStatus>(['autoSaverServer', pending.wallet, pending.chainId], (current) =>
        current ? { ...current, enrollment } : current
      )
      await Promise.all([
        refetchServerStatus(),
        queryClient.invalidateQueries({ queryKey: ['autoSaverServer'] }),
      ])
      return enrollment
    } catch (error) {
      const syncError = error instanceof EnrollmentBackendSyncError
        ? new EnrollmentBackendSyncError(error.message, {
            retryable: error.retryable,
            status: error.status,
            transactionHash: pending.transactionHash,
          })
        : new EnrollmentBackendSyncError(`MOVY could not verify the confirmed ${ACTIVE_NETWORK_LABEL} transaction.`, {
            retryable: true,
            transactionHash: pending.transactionHash,
          })
      pendingBackendSync.current = pending
      setBackendSyncError(syncError.message)
      throw syncError
    } finally {
      setIsBackendSyncPending(false)
    }
  }

  const retryBackendSync = async () => {
    const pending = pendingBackendSync.current
    if (!pending) throw new EnrollmentBackendSyncError('There is no confirmed transaction waiting for backend synchronization.', { retryable: false })
    return syncBackend(pending)
  }

  const enroll = async (destination: Address, maxRoundup6: bigint, dailyCap6: bigint) => {
    assertActiveChain()
    assertAutoSaverWriteAllowed(ACTIVE_NETWORK, contractAddress, 'enroll')
    if (!isConnected || !address) throw new Error('Connect the wallet before enrolling in automatic savings.')
    if (!contractAddress) throw new Error('Contract not available')
    setIsPendingTx(true)
    try {
      const submittedHash = await writeContractAsync({
        address: contractAddress,
        abi: MOVY_AUTO_SAVER_ABI,
        functionName: 'enroll',
        account: address,
        args: [destination, maxRoundup6, dailyCap6],
      })
      const hash = await submitAndConfirm(submittedHash)
      await syncBackend({ transactionHash: hash, allowedStatuses: ['active', 'paused'], wallet: address, chainId: ACTIVE_CHAIN_ID })
      await refetchConfig()
      await queryClient.invalidateQueries({ queryKey: ['autoSaverServer'] })
      return hash
    } finally {
      setIsPendingTx(false)
    }
  }

  const setUsdcAllowance = async (targetAllowance6: bigint) => {
    assertActiveChain()
    assertAutoSaverWriteAllowed(ACTIVE_NETWORK, contractAddress, targetAllowance6 === 0n ? 'clear-allowance' : 'increase-allowance')
    if (!isConnected || !address) throw new Error('Connect the wallet before changing the USDC allowance.')
    if (!contractAddress) throw new Error('Contract not available')
    if (!publicClient) throw new Error(`${ACTIVE_NETWORK_LABEL} allowance verification is unavailable. Try again shortly.`)
    const owner = address
    const client = publicClient
    setIsPendingTx(true)
    try {
      const result = await applyAllowanceTargetAndConfirm({
        targetAllowance6,
        expectedOwner: owner,
        expectedChainId: ACTIVE_CHAIN_ID,
        spender: contractAddress,
        getWalletContext: () => walletContextRef.current,
        readAllowance: async (allowanceOwner, spender) => client.readContract({
          address: CANONICAL_ARC_USDC,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [allowanceOwner as Address, spender as Address],
        }),
        writeAllowance: async (target, allowanceOwner, spender, targetChainId) => {
          const submittedHash = await writeContractAsync({
            address: CANONICAL_ARC_USDC,
            abi: ERC20_ABI,
            functionName: 'approve',
            args: [spender as Address, target],
            account: allowanceOwner as Address,
            chainId: targetChainId as typeof ACTIVE_CHAIN_ID,
          })
          setLastTxHash(submittedHash)
          return submittedHash
        },
        waitForReceipt: async (transactionHash) => client.waitForTransactionReceipt({ hash: transactionHash as Hash }),
      })
      let allowanceResult: typeof result & { backendSyncPending: boolean; backendSyncError: string | null } = {
        ...result,
        backendSyncPending: false,
        backendSyncError: null,
      }
      if (!result.walletContextChanged && targetAllowance6 > 0n) {
        const refreshedConfig = await refetchConfig()
        const contextBeforeSync = walletContextRef.current
        const signingWalletStillActive = contextBeforeSync.isConnected &&
          contextBeforeSync.chainId === ACTIVE_CHAIN_ID &&
          contextBeforeSync.address?.toLowerCase() === owner.toLowerCase()
        if (signingWalletStillActive && (
          refreshedConfig.data?.enrolled ||
          isEnrollmentSyncReliable(userConfig, serverStatus?.enrollment, owner, ACTIVE_CHAIN_ID)
        )) {
          allowanceResult = await syncConfirmedAllowanceWithEnrollment(result, () =>
            syncBackend({ transactionHash: result.transactionHash as Hash, allowedStatuses: ['active', 'paused'], wallet: owner, chainId: ACTIVE_CHAIN_ID })
          )
        }
      }
      await refetchAllowance()
      const currentContext = walletContextRef.current
      return {
        ...allowanceResult,
        walletContextChanged: allowanceResult.walletContextChanged ||
          !currentContext.isConnected || currentContext.chainId !== ACTIVE_CHAIN_ID ||
          currentContext.address?.toLowerCase() !== owner.toLowerCase(),
      }
    } finally {
      setIsPendingTx(false)
    }
  }

  const updateConfig = async (destination: Address, maxRoundup6: bigint, dailyCap6: bigint) => {
    assertActiveChain()
    assertAutoSaverWriteAllowed(ACTIVE_NETWORK, contractAddress, 'update-config')
    if (!isConnected || !address) throw new Error('Connect the wallet before updating automatic savings.')
    if (!contractAddress) throw new Error('Contract not available')
    setIsPendingTx(true)
    try {
      const submittedHash = await writeContractAsync({
        address: contractAddress,
        abi: MOVY_AUTO_SAVER_ABI,
        functionName: 'updateConfig',
        args: [destination, maxRoundup6, dailyCap6],
      })
      const hash = await submitAndConfirm(submittedHash)
      await syncBackend({ transactionHash: hash, allowedStatuses: ['active', 'paused'], wallet: address, chainId: ACTIVE_CHAIN_ID })
      await refetchConfig()
      return hash
    } finally {
      setIsPendingTx(false)
    }
  }

  const setPaused = async (isPaused: boolean) => {
    assertActiveChain()
    assertAutoSaverWriteAllowed(ACTIVE_NETWORK, contractAddress, isPaused ? 'pause' : 'resume')
    if (!isConnected || !address) throw new Error('Connect the wallet before changing automatic savings status.')
    if (!contractAddress) throw new Error('Contract not available')
    setIsPendingTx(true)
    try {
      const submittedHash = await writeContractAsync({
        address: contractAddress,
        abi: MOVY_AUTO_SAVER_ABI,
        functionName: 'setPaused',
        args: [isPaused],
      })
      const hash = await submitAndConfirm(submittedHash)
      await syncBackend({ transactionHash: hash, allowedStatuses: ['active', 'paused'], wallet: address, chainId: ACTIVE_CHAIN_ID })
      await refetchConfig()
      return hash
    } finally {
      setIsPendingTx(false)
    }
  }

  const revoke = async (expectedConfigEpoch: number) => {
    assertActiveChain()
    assertAutoSaverWriteAllowed(ACTIVE_NETWORK, contractAddress, 'revoke')
    if (!isConnected || !address) throw new Error('Connect the wallet before revoking automatic enrollment.')
    if (!contractAddress) throw new Error('Contract not available')
    if (!publicClient) throw new Error(`${ACTIVE_NETWORK_LABEL} enrollment verification is unavailable. Try again shortly.`)
    if (!Number.isSafeInteger(expectedConfigEpoch) || expectedConfigEpoch < 0) {
      throw new Error(`The verified ${ACTIVE_NETWORK_LABEL} enrollment version is unavailable. Refresh and retry.`)
    }
    const owner = address
    const client = publicClient
    setIsPendingTx(true)
    try {
      const result = await revokeEnrollmentWithConfirmation({
        expectedOwner: owner,
        expectedChainId: ACTIVE_CHAIN_ID,
        expectedConfigEpoch,
        getWalletContext: () => walletContextRef.current,
        writeRevoke: async (revokeOwner, targetChainId) => {
          const submittedHash = await writeContractAsync({
            address: contractAddress,
            abi: MOVY_AUTO_SAVER_ABI,
            functionName: 'revoke',
            args: [],
            account: revokeOwner as Address,
            chainId: targetChainId as typeof ACTIVE_CHAIN_ID,
          })
          setLastTxHash(submittedHash)
          return submittedHash
        },
        waitForReceipt: async (transactionHash) => client.waitForTransactionReceipt({ hash: transactionHash as Hash }),
        readEnrollment: async (enrollmentOwner) => {
          const config = await client.readContract({
            address: contractAddress,
            abi: MOVY_AUTO_SAVER_ABI,
            functionName: 'getUserConfig',
            args: [enrollmentOwner as Address],
          })
          return { enrolled: config.enrolled, configEpoch: config.configEpoch }
        },
        syncEnrollment: async (transactionHash) => syncBackend({
          transactionHash: transactionHash as Hash,
          allowedStatuses: ['revoked'],
          wallet: owner,
          chainId: ACTIVE_CHAIN_ID,
        }),
      })
      await Promise.all([refetchConfig(), refetchAllowance()])
      await queryClient.invalidateQueries({ queryKey: ['autoSaverServer'] })
      return result
    } finally {
      setIsPendingTx(false)
    }
  }

  const userConfig: AutoSaverConfig | null = configData
    ? {
        destination: configData.destination as Address,
        maxRoundup6: configData.maxRoundup6,
        dailyCap6: configData.dailyCap6,
        configEpoch: configData.configEpoch,
        paused: configData.paused,
        enrolled: configData.enrolled,
      }
    : null

  const allowance = isCorrectChain && !isAllowanceLoading && !isAllowanceError && typeof allowanceData === 'bigint'
    ? allowanceData
    : null
  const remainingDaily = (remainingDailyData as bigint) ?? 0n

  const backendEnrollment = serverStatus !== undefined ? serverStatus?.enrollment : confirmedBackendEnrollment
  const isEnrolled = isEnrollmentSyncReliable(userConfig, backendEnrollment, address, ACTIVE_CHAIN_ID)
  const isPaused = isEnrolled && Boolean(userConfig?.paused)
  const isOnchainEnrolled = Boolean(
    contractAddress && isConnected && address && isCorrectChain && !isConfigError && userConfig?.enrolled,
  )
  const onchainEnrollmentStatusLoading = Boolean(
    contractAddress && isConnected && address && isCorrectChain && !isConfigError && (isConfigLoading || configData === undefined),
  )
  const onchainEnrollmentStatusError = !contractAddress
    ? `${ACTIVE_NETWORK_LABEL} AutoSaver contract is not configured.`
    : isConfigError
      ? configError instanceof Error ? configError.message : `${ACTIVE_NETWORK_LABEL} enrollment configuration could not be read.`
      : null
  const enrollmentStatusError = !contractAddress
    ? `${ACTIVE_NETWORK_LABEL} AutoSaver contract is not configured.`
    : isConfigError
      ? configError instanceof Error ? configError.message : `${ACTIVE_NETWORK_LABEL} enrollment configuration could not be read.`
      : isServerStatusError
        ? serverStatusError instanceof Error ? serverStatusError.message : 'Enrollment status is temporarily unavailable.'
        : null

  return {
    contractAddress,
    financialWritesBlocked,
    userConfig,
    allowance,
    isAllowanceLoading,
    isAllowanceError,
    remainingDaily,
    isEnrolled,
    isOnchainEnrolled,
    onchainEnrollmentStatusLoading,
    onchainEnrollmentStatusError,
    isOnchainTransactionPending: isPendingTx || isWaitingReceipt,
    backendEnrollmentStatusLoading: isServerStatusLoading,
    backendEnrollmentStatusError: isServerStatusError
      ? serverStatusError instanceof Error ? serverStatusError.message : 'Enrollment status is temporarily unavailable.'
      : null,
    isPaused,
    /** Contract-wide emergency pause. Unknown (`idle`, `loading`, `error`) is never "not paused". */
    globalPause,
    refetchGlobalPause,
    isLoading: isConfigLoading || isAllowanceLoading || isDailyLoading || isServerStatusLoading,
    enrollmentStatusLoading: isConfigLoading || isServerStatusLoading,
    enrollmentStatusError,
    isPending: isPendingTx || isWaitingReceipt || isBackendSyncPending,
    isBackendSyncPending,
    backendSyncError,
    serverStatus,
    enroll,
    setUsdcAllowance,
    updateConfig,
    setPaused,
    revoke,
    retryBackendSync,
    refetch: () => {
      refetchConfig()
      refetchAllowance()
      refetchDaily()
      refetchGlobalPause()
      refetchServerStatus()
    },
  }
}
