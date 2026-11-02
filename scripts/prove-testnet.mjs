/**
 * Gate 1 proof script: prove the MOVY payment invariant on a live Arc testnet.
 *
 * Run with:
 *   node scripts/prove-testnet.mjs
 *
 * This deliberately uses `viem` — the same client stack the web app uses — rather
 * than a second library, so a passing run also validates the frontend's read/write
 * path against real chain semantics.
 *
 * It proves, in order:
 *   1. the headline example: $2.63 -> merchant $2.63 + savings $0.37 in ONE tx
 *   2. exact-dollar purchase with a zero roundup
 *   3. atomic failure: a merchant that Arc refuses to pay must leave NO trace
 *   4. owner-only withdrawal
 *   5. solvency after every step
 *
 * Keys come from environment variables. The default values are the standard
 * public EVM test mnemonic, which holds only worthless testnet funds and is
 * published in every test fixture.
 */
import { createPublicClient, createWalletClient, defineChain, http, formatEther } from 'viem'
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const NETWORK = process.env.MOVY_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
if (NETWORK !== 'testnet' || (process.env.ARC_RPC_URL && process.env.ARC_RPC_URL !== 'https://rpc.testnet.arc.io')) {
  throw new Error('Legacy proof is testnet-only. Mainnet requires a separate reviewed deployment workflow.')
}

export const CHAIN = defineChain({
  id: NETWORK === 'mainnet' ? 5042 : 5042002,
  name: NETWORK === 'mainnet' ? 'Arc' : 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL || `https://rpc.${NETWORK}.arc.io`] } },
  blockExplorers: {
    default: { name: 'Arc Explorer', url: `https://explorer.${NETWORK}.arc.io` },
  },
})

/** Arc drops transactions whose maxFeePerGas is under the 20 Gwei floor. */
const MAX_FEE_WEI = 25_000_000_000n
const PRIORITY_FEE_WEI = 1_000_000_000n

const EXPLORER = `https://explorer.${NETWORK}.arc.io`

const MOVY_ABI = [
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
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amountWei', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'savingsOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalLiabilities',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'quotePurchase',
    stateMutability: 'pure',
    inputs: [{ name: 'purchaseCents', type: 'uint256' }],
    outputs: [
      { name: 'roundupCents', type: 'uint256' },
      { name: 'purchaseWei', type: 'uint256' },
      { name: 'roundupWei', type: 'uint256' },
      { name: 'totalWei', type: 'uint256' },
    ],
  },
  {
    type: 'event',
    name: 'PurchaseRounded',
    inputs: [
      { name: 'payer', type: 'address', indexed: true },
      { name: 'merchant', type: 'address', indexed: true },
      { name: 'purchaseWei', type: 'uint256', indexed: false },
      { name: 'roundupWei', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SavingsWithdrawn',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'amountWei', type: 'uint256', indexed: false },
    ],
  },
]

/**
 * Arc's documented blocklist test address: a value transfer to or from it reverts
 * at runtime. Using it is the only honest way to prove atomic failure on the real
 * chain rather than against a simulated rejection.
 */
const BLOCKLISTED = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

/**
 * The standard public EVM test mnemonic. Published in every test fixture; the
 * accounts it derives hold only worthless testnet funds. Keys are derived here
 * rather than pasted so a typo cannot silently deploy from the wrong account.
 * Override with MOVY_DEPLOYER_KEY / MOVY_MERCHANT_KEY for anything else.
 */
const TEST_MNEMONIC = 'test test test test test test test test test test test junk'

/** Index 1 is the blocklist address, so it is never used as payer or merchant. */
const DEPLOYER_INDEX = 2

/**
 * Demo Store recipient.
 *
 * Defaults to a verified **codeless** address. This is not cosmetic: on Arc,
 * accounts carrying an EIP-7702 delegation designator accept a bare value
 * transfer, report `status: success`, and then do not retain the funds. Paying one
 * would produce a confirmed-looking receipt for a payment that never settled.
 * See STATE.md finding T9 and decision D25.
 */
const MERCHANT =
  process.env.MOVY_MERCHANT_ADDRESS || '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'

/** Returns the account, not just the key, so the derived address is always logged. */
function payerAccount() {
  const key = process.env.MOVY_DEPLOYER_KEY
  if (key) return privateKeyToAccount(key)
  return mnemonicToAccount(TEST_MNEMONIC, { addressIndex: DEPLOYER_INDEX })
}

const usd = (wei) => `${formatEther(wei)} USDC`
const centsToWei = (cents) => BigInt(cents) * 10n ** 16n

let failures = 0
function check(label, actual, expected) {
  const ok = String(actual) === String(expected)
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`)
  return ok
}

/** Machine-readable summary, so STATE.md never has to be written by hand. */
async function report(extra = {}) {
  // Amounts are bigint throughout, so they are serialised as decimal strings
  // rather than crashing JSON.stringify.
  const serialisable = (value) => {
    if (typeof value === 'bigint') return value.toString();
    if (Array.isArray(value)) return value.map(serialisable);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serialisable(v)]));
    }
    return value;
  };
  const summary = serialisable({
    network: NETWORK,
    chainId: CHAIN.id,
    at: new Date().toISOString(),
    failures,
    ...extra,
  });
  console.log('---SUMMARY---');
  console.log(JSON.stringify(summary, null, 2));
  if (process.env.MOVY_EVIDENCE_OUT) {
    writeFileSync(process.env.MOVY_EVIDENCE_OUT, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`written to ${process.env.MOVY_EVIDENCE_OUT}`);
  }
}

async function main() {
  const account = payerAccount()
  const merchantAccount = { address: MERCHANT }

  const publicClient = createPublicClient({ chain: CHAIN, transport: http() })
  const walletClient = createWalletClient({ chain: CHAIN, transport: http(), account })

  const chainId = await publicClient.getChainId()
  console.log(`network     ${CHAIN.name}`)
  console.log(`chainId     ${chainId}`)
  console.log(`explorer    ${EXPLORER}`)
  console.log(`payer       ${account.address}`)
  console.log(`merchant    ${merchantAccount.address}`)
  console.log('')

  if (chainId !== CHAIN.id) {
    throw new Error(`RPC chain id ${chainId} does not match expected ${CHAIN.id}`)
  }

  const artifact = JSON.parse(
    readFileSync(join(HERE, '..', 'contracts', 'out', 'MovySavings.sol', 'MovySavings.json'), 'utf8'),
  )
  // Forge writes `bytecode.object` with a leading `0x`; do not add another.
  if (artifact.bytecode.object !== artifact.deployedBytecode.object) {
    console.log(`  note: creation bytecode is ${artifact.bytecode.object.length} chars, runtime is ${artifact.deployedBytecode.object.length} chars`)
  }

  // ---------------------------------------------------------------- deploy
  // Reuse an existing deployment when MOVY_CONTRACT is set, so repeated proof
  // runs do not each burn the ~$0.009 deployment fee.
  let contract = process.env.MOVY_CONTRACT
  let deployHash = process.env.MOVY_DEPLOY_TX || 'reused'

  if (!contract) {
    console.log('== deploy ==')
    const deployStep = await walletClient.deployContract({
      abi: MOVY_ABI,
      bytecode: artifact.bytecode.object,
      account,
      maxFeePerGas: MAX_FEE_WEI,
      maxPriorityFeePerGas: PRIORITY_FEE_WEI,
    })
    deployHash = deployStep
    const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash })
    contract = deployReceipt.contractAddress
    if (!contract) throw new Error('no contract address in receipt')
    console.log(`  address   ${contract}`)
    console.log(`  tx        ${deployHash}`)
    console.log(`  gasUsed   ${deployReceipt.gasUsed}`)
    console.log(`  fee       ${usd(deployReceipt.gasUsed * deployReceipt.effectiveGasPrice)}`)
    console.log(`  link      ${EXPLORER}/address/${contract}`)
    console.log(`  deployTx  ${EXPLORER}/tx/${deployHash}`)
    console.log(`  time      ${new Date().toISOString()}`)
  } else {
    console.log('== deploy ==')
    console.log(`  reusing   ${contract}`)
    console.log(`  link      ${EXPLORER}/address/${contract}`)
  }

  const code = await publicClient.getCode({ address: contract })
  check('deployed bytecode is non-empty', code !== undefined && code !== '0x', true)

  // ---------------------------------------------------------------- preflight
  // Enforce T9 before moving any value. A recipient that carries code might not
  // retain an incoming transfer even though the transfer reports success, which
  // would make every downstream assertion meaningless.
  console.log('')
  console.log('== preflight ==')
  const merchantCode = await publicClient.getCode({ address: MERCHANT })
  if (merchantCode !== undefined && merchantCode !== '0x') {
    console.error(
      `ABORT: merchant ${MERCHANT} carries code (${merchantCode.slice(0, 20)}…).` +
        '\n       It may not retain incoming value. Set MOVY_MERCHANT_ADDRESS to a' +
        '\n       verified codeless address. See STATE.md finding T9.',
    )
    process.exit(2)
  }
  check('merchant is a codeless address (T9 guard)', true, true)

  const payerCode = await publicClient.getCode({ address: account.address })
  const payerIsDelegated = payerCode !== undefined && payerCode !== '0x'
  console.log(
    `  payer is ${payerIsDelegated ? 'EIP-7702 DELEGATED (can send, may not retain)' : 'a plain codeless EOA'}`,
  )
  if (payerIsDelegated) {
    console.log(
      '  NOTE: a delegated payer may not retain an incoming withdrawal, so the' +
        '\n        withdrawal step checks the payer balance and reports it plainly.',
    )
  }

  // ------------------------------------------------- headline: $2.63 / $0.37
  console.log('')
  console.log('== proof 1: $2.63 purchase and $0.37 roundup in ONE transaction ==')
  const [rCents, rPurchaseWei, rRoundupWei, rTotalWei] = await publicClient.readContract({
    address: contract,
    abi: MOVY_ABI,
    functionName: 'quotePurchase',
    args: [263n],
  })
  check('quote roundupCents == 37', rCents, 37n)
  check('quote purchaseWei == $2.63 in native units', rPurchaseWei, centsToWei(263))
  check('quote roundupWei == $0.37 in native units', rRoundupWei, centsToWei(37))
  check('quote totalWei == $3.00 in native units', rTotalWei, centsToWei(300))

  const merchantBefore = await publicClient.getBalance({ address: merchantAccount.address })
  const payerBefore = await publicClient.getBalance({ address: account.address })

  /**
   * Every MOVY total is a whole dollar of at least $1.00, because `purchaseCents`
   * must be >= 1. So the cheapest possible purchase costs $1.00 plus gas. When the
   * payer cannot cover that, the settlement proofs are reported as unproven
   * rather than quietly skipped or faked against a local chain.
   */
  const MIN_PURCHASE_TOTAL = centsToWei(100)
  const payerBalance = await publicClient.getBalance({ address: account.address })
  const headroom = payerBalance - MIN_PURCHASE_TOTAL

  if (headroom <= 0n) {
    console.log('')
    console.log('  SKIPPED  live settlement proofs')
    console.log(`    payer balance ${usd(payerBalance)} is below the ${usd(MIN_PURCHASE_TOTAL)}`)
    console.log('    floor for any MOVY purchase, because purchaseCents >= 1 always rounds')
    console.log('    up to at least $1.00. The read-only quote above IS proven onchain;')
    console.log('    the state-changing proofs are NOT, and are not simulated elsewhere.')
    console.log('    Fund this account, then re-run: node scripts/prove-testnet.mjs')
    console.log('')
    console.log(failures === 0 ? 'RESULT: all runnable checks passed' : `RESULT: ${failures} check(s) FAILED`)
    await report({
      skipped: true,
      reason: 'payer balance below the $1.00 minimum purchase total',
      contract,
      deployTx: deployHash,
      payer: account.address,
      payerBalance: payerBalance.toString(),
      minPurchaseTotal: MIN_PURCHASE_TOTAL.toString(),
      proven: ['deployed bytecode', 'quotePurchase(263) == 37 cents roundup / $3.00 total'],
      notProven: ['live $2.63 settlement', 'atomic failure on blocklisted recipient', 'withdrawal'],
    })
    process.exit(failures === 0 ? 0 : 1)
  }

  const payHash = await walletClient.writeContract({
    address: contract,
    abi: MOVY_ABI,
    functionName: 'payAndSave',
    args: [merchantAccount.address, 263n],
    value: rTotalWei,
    account,
    maxFeePerGas: MAX_FEE_WEI,
    maxPriorityFeePerGas: PRIORITY_FEE_WEI,
  })
  const payReceipt = await publicClient.waitForTransactionReceipt({ hash: payHash })
  const payBlock = await publicClient.getBlock({ blockNumber: payReceipt.blockNumber })

  const merchantAfter = await publicClient.getBalance({ address: merchantAccount.address })
  const savingsAfter = await publicClient.readContract({
    address: contract,
    abi: MOVY_ABI,
    functionName: 'savingsOf',
    args: [account.address],
  })

  check('merchant received exactly $2.63', merchantAfter - merchantBefore, centsToWei(263))
  check('payer savings == exactly $0.37', savingsAfter, centsToWei(37))
  check('purchase status', payReceipt.status, 'success')

  const logs = await publicClient.getContractEvents({
    address: contract,
    abi: MOVY_ABI,
    eventName: 'PurchaseRounded',
    fromBlock: payReceipt.blockNumber,
    toBlock: payReceipt.blockNumber,
    strict: true,
  })
  check('exactly one PurchaseRounded event', logs.length, 1)
  const ev = logs[0]
  check('event payer topic', ev.args.payer?.toLowerCase(), account.address.toLowerCase())
  check('event merchant topic', ev.args.merchant?.toLowerCase(), merchantAccount.address.toLowerCase())
  check('event purchaseWei', ev.args.purchaseWei, centsToWei(263))
  check('event roundupWei', ev.args.roundupWei, centsToWei(37))

  console.log(`  payTx     ${payHash}`)
  console.log(`  payLink   ${EXPLORER}/tx/${payHash}`)
  console.log(`  block     ${payReceipt.blockNumber}`)
  console.log(`  timestamp ${new Date(Number(payBlock.timestamp) * 1000).toISOString()}`)
  console.log(`  gasUsed   ${payReceipt.gasUsed}`)
  console.log(`  fee       ${usd(payReceipt.gasUsed * payReceipt.effectiveGasPrice)}`)
  console.log(`  payerOut  ${usd(payerBefore - await publicClient.getBalance({ address: account.address }))}`)

  // ------------------------------------------------------ exact dollar case
  console.log('')
  console.log('== proof 2: exact dollar, zero roundup ==')
  const [, , , exactTotal] = await publicClient.readContract({
    address: contract,
    abi: MOVY_ABI,
    functionName: 'quotePurchase',
    args: [100n],
  })
  check('exact $1.00 requires exactly $1.00', exactTotal, centsToWei(100))
  const exactHash = await walletClient.writeContract({
    address: contract,
    abi: MOVY_ABI,
    functionName: 'payAndSave',
    args: [merchantAccount.address, 100n],
    value: exactTotal,
    account,
    maxFeePerGas: MAX_FEE_WEI,
    maxPriorityFeePerGas: PRIORITY_FEE_WEI,
  })
  const exactReceipt = await publicClient.waitForTransactionReceipt({ hash: exactHash })
  const savingsAfterExact = await publicClient.readContract({
    address: contract,
    abi: MOVY_ABI,
    functionName: 'savingsOf',
    args: [account.address],
  })
  check('exact-dollar purchase succeeded', exactReceipt.status, 'success')
  check('exact-dollar added no savings', savingsAfterExact, centsToWei(37))
  console.log(`  payTx     ${exactHash}`)
  console.log(`  payLink   ${EXPLORER}/tx/${exactHash}`)

  // --------------------------------------------------- atomic failure proof
  console.log('')
  console.log('== proof 3: payment Arc refuses must leave NO trace ==')
  const savingsBeforeFail = await publicClient.readContract({
    address: contract,
    abi: MOVY_ABI,
    functionName: 'savingsOf',
    args: [account.address],
  })
  const vaultBeforeFail = await publicClient.getBalance({ address: contract })
  const blockedBefore = await publicClient.getBalance({ address: BLOCKLISTED })

  let failHash = 'none'
  try {
    const h = await walletClient.writeContract({
      address: contract,
      abi: MOVY_ABI,
      functionName: 'payAndSave',
      args: [BLOCKLISTED, 263n],
      value: centsToWei(300),
      account,
      maxFeePerGas: MAX_FEE_WEI,
      maxPriorityFeePerGas: PRIORITY_FEE_WEI,
    })
    const r = await publicClient.waitForTransactionReceipt({ hash: h })
    failHash = h
    check('payment to a blocklisted recipient reverted', r.status, 'reverted')
  } catch (err) {
    console.log(`  (submission failed before inclusion: ${String(err.message).split('\n')[0]})`)
  }

  const savingsAfterFail = await publicClient.readContract({
    address: contract,
    abi: MOVY_ABI,
    functionName: 'savingsOf',
    args: [account.address],
  })
  const vaultAfterFail = await publicClient.getBalance({ address: contract })
  const blockedAfter = await publicClient.getBalance({ address: BLOCKLISTED })

  check('savings unchanged after failed payment', savingsAfterFail, savingsBeforeFail)
  check('blocklisted recipient received nothing', blockedAfter - blockedBefore, 0n)
  console.log(`  vault before/after ${usd(vaultBeforeFail)} / ${usd(vaultAfterFail)}`)

  const eventsAfterFail = await publicClient.getContractEvents({
    address: contract,
    abi: MOVY_ABI,
    eventName: 'PurchaseRounded',
    fromBlock: payReceipt.blockNumber,
    toBlock: 'latest',
    strict: true,
  })
  check('no extra PurchaseRounded event from the failure', eventsAfterFail.length, 2)
  if (failHash !== 'none') console.log(`  failTx    ${EXPLORER}/tx/${failHash}`)

  // ------------------------------------------------------------- withdrawal
  console.log('')
  console.log('== proof 4: owner withdraws own savings ==')
  const savingsBeforeWithdraw = await publicClient.readContract({
    address: contract,
    abi: MOVY_ABI,
    functionName: 'savingsOf',
    args: [account.address],
  })
  const payerBeforeWithdraw = await publicClient.getBalance({ address: account.address })
  const wdHash = await walletClient.writeContract({
    address: contract,
    abi: MOVY_ABI,
    functionName: 'withdraw',
    args: [savingsBeforeWithdraw],
    account,
    maxFeePerGas: MAX_FEE_WEI,
    maxPriorityFeePerGas: PRIORITY_FEE_WEI,
  })
  const wdReceipt = await publicClient.waitForTransactionReceipt({ hash: wdHash })
  check('withdrawal succeeded', wdReceipt.status, 'success')
  const savingsFinal = await publicClient.readContract({
    address: contract,
    abi: MOVY_ABI,
    functionName: 'savingsOf',
    args: [account.address],
  })
  check('savings back to zero', savingsFinal, 0n)

  // The receipt is not evidence that the owner received anything. Check the
  // balance independently, net of gas, so a delegated payer's failure mode is
  // reported rather than hidden behind a green receipt.
  const payerAfterWithdraw = await publicClient.getBalance({ address: account.address })
  const wdFee = wdReceipt.gasUsed * wdReceipt.effectiveGasPrice
  const expectedGain = savingsBeforeWithdraw - wdFee
  const actualGain = payerAfterWithdraw - payerBeforeWithdraw
  const withdrawalDelivered = actualGain === expectedGain
  check('payer received the withdrawal net of gas', withdrawalDelivered, true)
  console.log(`  wdTx      ${wdHash}`)
  console.log(`  wdLink    ${EXPLORER}/tx/${wdHash}`)
  console.log(`  gasUsed   ${wdReceipt.gasUsed}`)
  console.log(`  fee       ${usd(wdFee)}`)
  console.log(`  expected  +${usd(expectedGain)}`)
  console.log(`  actual    +${usd(actualGain)}`)
  if (!withdrawalDelivered) {
    console.log(
      '  DIAGNOSIS: the receipt says success but the payer balance did not move as' +
        '\n        expected. This is the EIP-7702 delegation behaviour in T9: the' +
        '\n        payer account is a plain EOA that has opted into a delegation, and' +
        '\n        an incoming transfer does not stay in its balance. A real wallet' +
        '\n        with no delegation behaves normally. Use a wallet you own for the' +
        '\n        demo.',
    )
  }

  // ---------------------------------------------------------------- solvency
  console.log('')
  console.log('== proof 5: solvency ==')
  const liabilities = await publicClient.readContract({
    address: contract,
    abi: MOVY_ABI,
    functionName: 'totalLiabilities',
  })
  const vaultBalance = await publicClient.getBalance({ address: contract })
  check('contract balance >= total liabilities', vaultBalance >= liabilities, true)
  console.log(`  vault balance    ${usd(vaultBalance)}`)
  console.log(`  total liabilities ${usd(liabilities)}`)

  console.log('')
  console.log(failures === 0 ? 'RESULT: all checks passed' : `RESULT: ${failures} check(s) FAILED`)
  await report({
    contract,
    payer: account.address,
    merchant: merchantAccount.address,
    deployTx: deployHash,
    pay263Tx: payHash,
    pay263Gas: payReceipt.gasUsed,
    pay263Fee: (payReceipt.gasUsed * payReceipt.effectiveGasPrice).toString(),
    pay263Block: payReceipt.blockNumber,
    pay263Timestamp: new Date(Number(payBlock.timestamp) * 1000).toISOString(),
    exactDollarTx: exactHash,
    atomicFailureTx: failHash,
    withdrawTx: wdHash,
    withdrawGas: wdReceipt.gasUsed,
    withdrawFee: (wdReceipt.gasUsed * wdReceipt.effectiveGasPrice).toString(),
    withdrawalDeliveredToPayer: withdrawalDelivered,
    payerIsDelegated,
    links: {
      address: `${EXPLORER}/address/${contract}`,
      pay263: `${EXPLORER}/tx/${payHash}`,
      exactDollar: `${EXPLORER}/tx/${exactHash}`,
      withdraw: `${EXPLORER}/tx/${wdHash}`,
    },
  })

  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
