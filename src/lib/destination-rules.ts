/**
 * MOVY savings destination validation for the selected Arc network.
 * Mainnet and Testnet deployment addresses are supplied by their isolated build
 * configuration; no Testnet contract address is embedded in application logic.
 */
import { ACTIVE_CHAIN, ACTIVE_NETWORK } from './chain'
import { demoStore, movyAutoSaverAddress } from './contract'

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const
export const CANONICAL_ARC_USDC = '0x3600000000000000000000000000000000000000' as const
export const SYSTEM_USDC_EMITTER = '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE' as const

export interface DestinationValidationResult {
  valid: boolean
  error: string | null
  code:
    | 'OK'
    | 'REQUIRED'
    | 'INVALID_FORMAT'
    | 'ZERO_ADDRESS'
    | 'SELF_LOOP'
    | 'INCOMPATIBLE_LEGACY_CONTRACT'
    | 'INCOMPATIBLE_TOKEN_CONTRACT'
    | 'INCOMPATIBLE_AUTOSAVER_CONTRACT'
    | 'INCOMPATIBLE_MERCHANT_ADDRESS'
    | 'INCOMPATIBLE_SYSTEM_ADDRESS'
}

export function isLegacyCheckoutContract(address: string, legacyCheckout?: string): boolean {
  if (!address || typeof address !== 'string' || !legacyCheckout) return false
  return address.trim().toLowerCase() === legacyCheckout.trim().toLowerCase()
}

export function validateSavingsDestination({
  destination,
  walletAddress,
  restrictedAddresses,
}: {
  destination: string | undefined | null
  walletAddress?: string | null
  restrictedAddresses?: { legacyCheckout?: string; autoSaver?: string; merchant?: string }
}): DestinationValidationResult {
  if (!destination || typeof destination !== 'string' || !destination.trim()) {
    return { valid: false, error: 'Please enter a separate personal savings destination address.', code: 'REQUIRED' }
  }
  const clean = destination.trim()
  if (!/^0x[a-fA-F0-9]{40}$/.test(clean)) {
    return { valid: false, error: 'Invalid address format. Please enter a valid 42-character 0x address.', code: 'INVALID_FORMAT' }
  }
  const lower = clean.toLowerCase()
  if (lower === ZERO_ADDRESS) {
    return { valid: false, error: 'The zero address (0x0) cannot be used as a savings destination.', code: 'ZERO_ADDRESS' }
  }
  if (walletAddress && lower === walletAddress.trim().toLowerCase()) {
    return {
      valid: false,
      error: 'Savings destination cannot match your connected spending wallet. Please provide a separate personal savings wallet you control.',
      code: 'SELF_LOOP',
    }
  }
  const legacyCheckout = restrictedAddresses?.legacyCheckout ?? (ACTIVE_NETWORK === 'mainnet'
    ? process.env.NEXT_PUBLIC_MOVY_LEGACY_CHECKOUT_MAINNET
    : process.env.NEXT_PUBLIC_MOVY_LEGACY_CHECKOUT_TESTNET)
  if (isLegacyCheckoutContract(lower, legacyCheckout)) {
    return {
      valid: false,
      error: 'Incompatible contract: the legacy MOVY checkout does not support ERC-20 savings transfers.',
      code: 'INCOMPATIBLE_LEGACY_CONTRACT',
    }
  }
  if (lower === CANONICAL_ARC_USDC.toLowerCase()) {
    return { valid: false, error: 'Cannot use the Arc USDC token contract address as a savings destination.', code: 'INCOMPATIBLE_TOKEN_CONTRACT' }
  }
  const autoSaver = restrictedAddresses?.autoSaver ?? movyAutoSaverAddress(ACTIVE_NETWORK)
  if (autoSaver && lower === autoSaver.toLowerCase()) {
    return { valid: false, error: 'Cannot use the MOVY AutoSaver contract as a savings destination.', code: 'INCOMPATIBLE_AUTOSAVER_CONTRACT' }
  }
  const merchant = restrictedAddresses?.merchant ?? demoStore(ACTIVE_NETWORK)
  if (merchant && lower === merchant.toLowerCase()) {
    return { valid: false, error: 'Cannot use the demo merchant address as a savings destination.', code: 'INCOMPATIBLE_MERCHANT_ADDRESS' }
  }
  if (lower === SYSTEM_USDC_EMITTER.toLowerCase()) {
    return { valid: false, error: 'Cannot use the Arc system address as a savings destination.', code: 'INCOMPATIBLE_SYSTEM_ADDRESS' }
  }
  return { valid: true, error: null, code: 'OK' }
}

export interface BytecodeVerificationResult {
  valid: boolean
  isContract: boolean | null
  isEoa: boolean | null
  error: string | null
  warning: string | null
  code: 'OK' | 'INCOMPATIBLE_CONTRACT' | 'BYTECODE_CHECK_FAILED' | 'INVALID_FORMAT'
  bytecodeBytes?: number
}

/**
 * Asynchronously inspects the address bytecode on the selected Arc network via JSON-RPC eth_getCode.
 * 
 * Safety Rationale:
 * - Rejects arbitrary smart contracts that may not support ERC-20 USDC reception or user withdrawals.
 * - Confirms whether the address is an Externally Owned Account (EOA).
 * - CRITICAL BOUNDARY: Empty bytecode proves the address is an external account,
 *   but CANNOT cryptographically prove that the user holds the private keys!
 */
export async function verifyDestinationBytecodeOnchain({
  destination,
  rpcUrl = ACTIVE_CHAIN.rpcUrls.default.http[0],
}: {
  destination: string
  rpcUrl?: string
}): Promise<BytecodeVerificationResult> {
  const clean = destination?.trim()
  if (!clean || !/^0x[a-fA-F0-9]{40}$/.test(clean)) {
    return {
      valid: false,
      isContract: null,
      isEoa: null,
      error: 'Invalid address format. Expected a 42-character 0x hex address.',
      warning: null,
      code: 'INVALID_FORMAT',
    }
  }

  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_getCode',
        params: [clean, 'latest'],
        id: 1,
      }),
    })

    if (!res.ok) {
      return {
        valid: false,
        isContract: null,
        isEoa: null,
        error: `RPC error (HTTP ${res.status}): Cannot verify address on Arc.`,
        warning: null,
        code: 'BYTECODE_CHECK_FAILED',
      }
    }

    const json = (await res.json()) as { result?: string; error?: { message?: string } }
    if (json.error) {
      return {
        valid: false,
        isContract: null,
        isEoa: null,
        error: `Arc RPC returned error: ${json.error.message || 'unknown'}. Cannot verify bytecode.`,
        warning: null,
        code: 'BYTECODE_CHECK_FAILED',
      }
    }

    const codeHex = json.result || '0x'
    const isContract = Boolean(codeHex && codeHex !== '0x' && codeHex !== '0x0')
    const bytecodeBytes = isContract ? (codeHex.length - 2) / 2 : 0

    if (isContract) {
      return {
        valid: false,
        isContract: true,
        isEoa: false,
        bytecodeBytes,
        error:
          'Incompatible destination: This address is a smart contract on Arc. Automated savings requires a personal external savings wallet (EOA) to ensure you control the keys and can withdraw funds.',
        warning: null,
        code: 'INCOMPATIBLE_CONTRACT',
      }
    }

    return {
      valid: true,
      isContract: false,
      isEoa: true,
      bytecodeBytes: 0,
      error: null,
      warning:
        'Verified as external account (EOA). Note: Empty bytecode confirms this is an external account, but does not prove you own the private keys. Ensure you hold the keys to this address.',
      code: 'OK',
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      valid: false,
      isContract: null,
      isEoa: null,
      error: `Network error verifying address bytecode: ${msg}. Arc address verification required before activation.`,
      warning: null,
      code: 'BYTECODE_CHECK_FAILED',
    }
  }
}
