import { createPublicClient, createWalletClient, defineChain, http } from 'viem'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  assertDeploymentTxFeeCap,
  estimateDeploymentGas,
  loadDeployerAccountFromKeystore,
  validateDeploymentFeeBudget,
  validateFreshTestnetRoles,
} from './lib/testnet-deployment-preflight.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CHAIN_ID = 5042002
const USDC_ADDRESS = '0x3600000000000000000000000000000000000000'
const KNOWN_COMPROMISED_CONTRACT = '0xd4a54e8315331a3ecd7e27a0bc4ff007a932332d'
const HARD_MAX_FEE_PER_GAS_WEI = 25_000_000_000n
const CHAIN_TESTNET = defineChain({
  id: CHAIN_ID,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_TESTNET_RPC_URL || 'https://rpc.testnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.testnet.arc.io' } },
})
const ERC20_READ_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
]

function positiveIntegerEnv(name) {
  const value = process.env[name]
  if (!value || !/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} must be a positive integer in wei`)
  return BigInt(value)
}

async function main() {
  const args = new Set(process.argv.slice(2))
  const allowedArgs = new Set(['--broadcast', '--i-understand-this-broadcasts'])
  if ([...args].some((arg) => !allowedArgs.has(arg))) throw new Error('Unknown deployment option')
  const broadcastRequested = args.has('--broadcast')
  if (broadcastRequested && !args.has('--i-understand-this-broadcasts')) {
    throw new Error('Broadcast mode requires --i-understand-this-broadcasts')
  }

  const roles = validateFreshTestnetRoles(process.env.MOVY_OWNER_ADDRESS, process.env.MOVY_RELAYER_ADDRESS)
  const maxFeePerGas = positiveIntegerEnv('MOVY_DEPLOY_MAX_FEE_PER_GAS_WEI')
  // Hard cap on the approved fee budget, enforced before any RPC request is made.
  const maxTxFee = assertDeploymentTxFeeCap(positiveIntegerEnv('MOVY_DEPLOY_MAX_TX_FEE_WEI'))
  if (maxFeePerGas < 1_000_000_000n || maxFeePerGas > HARD_MAX_FEE_PER_GAS_WEI) {
    throw new Error('Deployment fee per gas must be from 1 to 25 Gwei')
  }

  const artifactPath = join(ROOT, 'contracts', 'out', 'MovyAutoSaver.sol', 'MovyAutoSaver.json')
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'))
  const abi = artifact.abi
  const bytecode = artifact.bytecode.object
  const publicClient = createPublicClient({
    chain: CHAIN_TESTNET,
    transport: http(process.env.ARC_TESTNET_RPC_URL || 'https://rpc.testnet.arc.io', { retryCount: 2, timeout: 15_000 }),
  })

  const rpcChainId = await publicClient.getChainId()
  if (rpcChainId !== CHAIN_ID) throw new Error('Configured RPC is not Arc Testnet (5042002)')
  const usdcCode = await publicClient.getCode({ address: USDC_ADDRESS })
  if (!usdcCode || usdcCode === '0x') throw new Error('Canonical Arc Testnet USDC has no deployed code')
  const usdcDecimals = await publicClient.readContract({ address: USDC_ADDRESS, abi: ERC20_READ_ABI, functionName: 'decimals' })
  if (usdcDecimals !== 6) throw new Error('Canonical Arc Testnet USDC decimals are not six')

  // Contract creation: estimate the real constructor bytecode plus encoded arguments.
  const gasEstimate = await estimateDeploymentGas(publicClient, {
    account: roles.owner,
    abi,
    bytecode,
    args: [USDC_ADDRESS, roles.relayer],
  })
  const budget = validateDeploymentFeeBudget(gasEstimate, maxFeePerGas, maxTxFee)
  const gasLimit = (budget.gas * 120n + 99n) / 100n
  const maximumGasCost = gasLimit * maxFeePerGas
  if (maximumGasCost > maxTxFee) throw new Error('20% deployment gas buffer exceeds the approved transaction fee budget')

  const preflight = {
    network: 'Arc Testnet',
    chainId: rpcChainId,
    owner: roles.owner,
    relayer: roles.relayer,
    usdc: USDC_ADDRESS,
    usdcDecimals,
    compromisedDeploymentExcluded: KNOWN_COMPROMISED_CONTRACT,
    estimatedGas: gasEstimate.toString(),
    gasLimitWith20PercentBuffer: gasLimit.toString(),
    maxFeePerGasWei: maxFeePerGas.toString(),
    maximumDeploymentFeeWei: maximumGasCost.toString(),
    approvedDeploymentFeeBudgetWei: maxTxFee.toString(),
    broadcast: broadcastRequested,
  }

  if (!broadcastRequested) {
    console.log(JSON.stringify({ mode: 'read-only-preflight', ...preflight }, null, 2))
    return
  }

  if (process.env.MOVY_TESTNET_DEPLOY_APPROVED !== 'YES') {
    throw new Error('Set MOVY_TESTNET_DEPLOY_APPROVED=YES only after explicit owner approval')
  }
  const manifestPath = join(ROOT, 'contracts', 'deployed-testnet-fresh.json')
  if (existsSync(manifestPath)) throw new Error('Fresh deployment manifest already exists; refusing to overwrite it')
  // The signer is an encrypted Foundry keystore plus a password FILE. Only the two file
  // paths are configured; no raw key or password is read from env, arguments, or output.
  const account = loadDeployerAccountFromKeystore({
    keystorePath: process.env.MOVY_DEPLOYER_KEYSTORE || process.env.ETH_KEYSTORE,
    passwordFilePath: process.env.MOVY_DEPLOYER_PASSWORD_FILE || process.env.ETH_PASSWORD_FILE,
  })
  if (account.address.toLowerCase() !== roles.owner.toLowerCase()) {
    throw new Error('Deployment signer does not match the separately configured owner address')
  }
  const balance = await publicClient.getBalance({ address: account.address })
  if (balance < maximumGasCost) throw new Error('Owner address balance is below the approved maximum deployment fee')

  const walletClient = createWalletClient({
    account,
    chain: CHAIN_TESTNET,
    transport: http(process.env.ARC_TESTNET_RPC_URL || 'https://rpc.testnet.arc.io', { retryCount: 0, timeout: 15_000 }),
  })
  const hash = await walletClient.deployContract({
    abi,
    bytecode,
    args: [USDC_ADDRESS, roles.relayer],
    gas: gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas: 1_000_000_000n,
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Fresh Testnet deployment did not confirm successfully')

  const deploymentInfo = {
    network: 'testnet',
    chainId: CHAIN_ID,
    contractAddress: receipt.contractAddress,
    deployBlock: Number(receipt.blockNumber),
    deployTxHash: hash,
    owner: roles.owner,
    deployer: account.address,
    relayer: roles.relayer,
    usdcAddress: USDC_ADDRESS,
    deployedAt: new Date().toISOString(),
  }
  writeFileSync(manifestPath, JSON.stringify(deploymentInfo, null, 2), { flag: 'wx' })
  console.log(JSON.stringify({ ...preflight, deployment: deploymentInfo, manifest: 'contracts/deployed-testnet-fresh.json' }, null, 2))
}

main().catch((error) => {
  console.error('Testnet deployment preflight failed:', error instanceof Error ? error.message : 'unknown error')
  process.exitCode = 1
})
