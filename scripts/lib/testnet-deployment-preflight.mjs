import { encodeDeployData, isAddress } from 'viem'
import { loadFoundryKeystoreAccount } from '../../src/lib/server/foundry-keystore.mjs'
export { KEYSTORE_KDF_LIMITS, decryptFoundryKeystore } from '../../src/lib/server/foundry-keystore.mjs'

export const KNOWN_COMPROMISED_DEVELOPMENT_ADDRESSES = new Set([
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
])

export function validateFreshTestnetRoles(ownerAddress, relayerAddress) {
  if (!isAddress(ownerAddress ?? '')) throw new Error('MOVY_OWNER_ADDRESS must be a valid address')
  if (!isAddress(relayerAddress ?? '')) throw new Error('MOVY_RELAYER_ADDRESS must be a valid address')
  const owner = ownerAddress.toLowerCase()
  const relayer = relayerAddress.toLowerCase()
  if (/^0x0{40}$/.test(owner) || /^0x0{40}$/.test(relayer)) throw new Error('Owner and relayer addresses must be nonzero')
  if (owner === relayer) throw new Error('Owner and relayer identities must be separate')
  if (KNOWN_COMPROMISED_DEVELOPMENT_ADDRESSES.has(owner) || KNOWN_COMPROMISED_DEVELOPMENT_ADDRESSES.has(relayer)) {
    throw new Error('Fresh deployment cannot use the known compromised development identity')
  }
  return { owner: ownerAddress, relayer: relayerAddress }
}

/**
 * Hard ceiling on the one fresh Testnet deployment transaction: the owner-approved
 * 0.15 native USDC (Arc native USDC has 18 decimals). It is enforced here, in the shared
 * helper, so no caller can raise it by configuration.
 */
export const MAX_TESTNET_DEPLOYMENT_TX_FEE_WEI = 150_000_000_000_000_000n

export function assertDeploymentTxFeeCap(maxTxFee) {
  const budget = BigInt(maxTxFee)
  if (budget > MAX_TESTNET_DEPLOYMENT_TX_FEE_WEI) {
    throw new Error('Deployment transaction fee budget exceeds the approved maximum of 150000000000000000 wei (0.15 native USDC)')
  }
  return budget
}

export function validateDeploymentFeeBudget(gasEstimate, maxFeePerGas, maxTxFee) {
  const gas = BigInt(gasEstimate)
  const fee = BigInt(maxFeePerGas)
  const budget = BigInt(maxTxFee)
  if (gas <= 0n || fee <= 0n || budget <= 0n) throw new Error('Deployment gas and fee budgets must be positive')
  assertDeploymentTxFeeCap(budget)
  const maximumCost = gas * fee
  if (maximumCost > budget) throw new Error('Deployment gas estimate exceeds the approved transaction fee budget')
  return { gas, maximumCost }
}

/**
 * Builds the contract-creation request used to estimate deployment gas: the exact
 * constructor bytecode with the ABI-encoded constructor arguments as `data`, no `to`
 * and no function name. (`estimateContractGas` cannot do this; it requires a function.)
 */
export function buildDeploymentGasEstimateRequest({ account, abi, bytecode, args }) {
  if (!isAddress(account ?? '')) throw new Error('Deployment gas estimate requires a valid owner address')
  if (!Array.isArray(abi) || !abi.some((item) => item?.type === 'constructor')) {
    throw new Error('Deployment ABI has no constructor')
  }
  if (typeof bytecode !== 'string' || !/^0x[0-9a-fA-F]+$/.test(bytecode) || bytecode.length % 2 !== 0) {
    throw new Error('Deployment bytecode must be non-empty even-length hex')
  }
  if (bytecode.includes('__$')) throw new Error('Deployment bytecode contains unlinked library placeholders')
  return { account, data: encodeDeployData({ abi, bytecode, args }) }
}

export async function estimateDeploymentGas(publicClient, deployment) {
  const gas = await publicClient.estimateGas(buildDeploymentGasEstimateRequest(deployment))
  return BigInt(gas)
}

export function loadDeployerAccountFromKeystore({ keystorePath, passwordFilePath }) {
  return loadFoundryKeystoreAccount({ keystorePath, passwordFilePath })
}
