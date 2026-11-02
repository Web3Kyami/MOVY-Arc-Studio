/**
 * MOVY money module.
 *
 * `AGENT-INSTRUCTIONS.md` forbids floating point for money, and
 * `AGENT-INSTRUCTIONS.md` also forbids mixing Arc's 18-decimal native USDC with
 * the 6-decimal ERC-20 interface. Everything in this file therefore works in
 * exactly two integer representations and never converts through `number`:
 *
 *   - **cents** — integer cents (263n = $2.63). The product and UI unit.
 *   - **nativeWei** — Arc native USDC, 18 decimals (263n cents = 263n * 10^16).
 *     This is the onchain unit for `msg.value` and for gas. It is NOT the ERC-20
 *     USDC unit, which is 6 decimals. Never pass a value from this module to
 *     `IERC20` at 0x3600000000000000000000000000000000000000.
 *
 * There are no `number` parameters and no `parseFloat`/`Number`/`toFixed` on any
 * money path. Formatting uses `Intl.NumberFormat` on a string built by string
 * surgery, because `Intl` takes a `number` and would reintroduce the float.
 */

/** Native 18-decimal units in one cent. 10^18 / 10^2 = 10^16. */
export const CENTS_UNIT = 10n ** 16n

/** Native 18-decimal units in one US dollar. */
export const DOLLAR_WEI = 10n ** 18n

/** Cents in one US dollar. */
export const CENTS_PER_DOLLAR = 100n

/** Gas token is USDC, denominated in native 18-decimal units. */
export const GAS_DECIMALS = 18n

/** Cents. `263n` -> `263n`. Guards the upper bound the contract enforces. */
export const MAX_PURCHASE_CENTS = 1_000_000n

/**
 * Roundup in cents: the change needed to reach the next whole dollar.
 * An exact dollar rounds up to itself, i.e. $0.00.
 */
export function roundupCents(purchaseCents: bigint): bigint {
  if (purchaseCents < 0n) throw new RangeError("purchaseCents must be non-negative")
  return (CENTS_PER_DOLLAR - (purchaseCents % CENTS_PER_DOLLAR)) % CENTS_PER_DOLLAR
}

/** What the payer signs for: purchase plus roundup, always a whole dollar. */
export function totalCents(purchaseCents: bigint): bigint {
  return purchaseCents + roundupCents(purchaseCents)
}

/** Convert integer cents to Arc native 18-decimal units. */
export function centsToWei(cents: bigint): bigint {
  return cents * CENTS_UNIT
}

/**
 * Convert Arc native 18-decimal units to integer cents, rounding down.
 * Lossy on purpose: anything finer than a cent is not spendable.
 */
export function weiToCents(wei: bigint): bigint {
  return wei / CENTS_UNIT
}

/**
 * Parse a user-typed dollar amount into integer cents.
 *
 * Accepts at most two decimal places, rejects anything else, and never uses a
 * float. Returns `null` rather than throwing so callers can bind the error to a
 * form field.
 *
 *   "2.63"  -> 263n
 *   "2"     -> 200n
 *   "0.07"  -> 7n
 *   "2.631" -> null   (three decimals)
 *   "2.6.3" -> null
 *   ""      -> null
 */
export function parseCents(input: string): bigint | null {
  const trimmed = input.trim().replace(/^\$/, "")
  if (trimmed === '') return null
  if (!/^\d+(\.\d{0,2})?$/.test(trimmed)) return null

  const [whole = '0', frac = ''] = trimmed.split('.')
  const fracPadded = (frac + '00').slice(0, 2)
  const cents = BigInt(whole) * CENTS_PER_DOLLAR + BigInt(fracPadded)
  if (cents <= 0n) return null
  if (cents > MAX_PURCHASE_CENTS) return null
  return cents
}

/** Re-render integer cents as a bare edit string, e.g. `263n` -> `"2.63"`. */
export function centsToInput(cents: bigint): string {
  const negative = cents < 0n
  const abs = negative ? -cents : cents
  const whole = abs / CENTS_PER_DOLLAR
  const frac = abs % CENTS_PER_DOLLAR
  return `${negative ? '-' : ''}${whole}.${frac.toString().padStart(2, '0')}`
}

/**
 * Build a grouped dollar string from integer cents using string surgery only.
 *
 * `Intl.NumberFormat` needs a `number`, and routing money through one is exactly
 * the failure this module exists to prevent. We group the whole-dollar part by
 * hand and append the two decimal digits.
 */
function groupWhole(whole: string): string {
  let out = ''
  for (let i = 0; i < whole.length; i++) {
    const remaining = whole.length - i
    out += whole[i]
    if (remaining > 1 && (remaining - 1) % 3 === 0) out += ','
  }
  return out
}

/**
 * Format integer cents as a US dollar string with two decimals.
 * `formatCents(263n)` -> `"$2.63"`
 */
export function formatCents(cents: bigint, withCents = true): string {
  const negative = cents < 0n
  const abs = negative ? -cents : cents
  const whole = groupWhole((abs / CENTS_PER_DOLLAR).toString())
  if (!withCents) return `${negative ? '-' : ''}$${whole}`
  const frac = (abs % CENTS_PER_DOLLAR).toString().padStart(2, '0')
  return `${negative ? '-' : ''}$${whole}.${frac}`
}

/**
 * Format an amount of native 18-decimal USDC as a dollar string with
 * `decimals` fractional digits, without floats.
 *
 * Gas fees need more than two decimals: a sub-cent fee must be visible rather
 * than rounded to "$0.00", so the UI can show the real cost of a roundup.
 */
export function formatNative(wei: bigint, decimals = 2): string {
  const negative = wei < 0n
  const abs = negative ? -wei : wei
  const whole = groupWhole((abs / DOLLAR_WEI).toString())
  if (decimals <= 0) return `${negative ? '-' : ''}$${whole}`

  // 10^(18-decimals) is the scale for the fractional part.
  const scale = 10n ** (18n - BigInt(decimals))
  const frac = ((abs % DOLLAR_WEI) / scale)
    .toString()
    .padStart(decimals, '0')
  return `${negative ? '-' : ''}$${whole}.${frac}`
}

/** Gas fees: never round a real cost to `$0.00`. Always show at least 5 decimals. */
export const FEE_DECIMALS = 5

export function formatFee(wei: bigint): string {
  if (wei === 0n) return '$0.00'
  const decimals = wei < DOLLAR_WEI / 100n ? FEE_DECIMALS : 2
  return formatNative(wei, decimals)
}

/**
 * Breakdown row for the payment review. Always returns the same shape so the
 * review sheet and the receipt cannot drift apart.
 */
export interface PaymentBreakdown {
  purchaseCents: bigint
  roundupCents: bigint
  totalCents: bigint
  purchaseWei: bigint
  roundupWei: bigint
  totalWei: bigint
  isExactDollar: boolean
}

export function breakdown(purchaseCents: bigint): PaymentBreakdown {
  const round = roundupCents(purchaseCents)
  const total = purchaseCents + round
  return {
    purchaseCents,
    roundupCents: round,
    totalCents: total,
    purchaseWei: centsToWei(purchaseCents),
    roundupWei: centsToWei(round),
    totalWei: centsToWei(total),
    isExactDollar: round === 0n,
  }
}

/** Percentage of `whole` that `part` represents, for progress-free copy only. */
export function percent(part: bigint, whole: bigint): bigint {
  if (whole === 0n) return 0n
  return (part * 100n) / whole
}

/*//////////////////////////////////////////////////////////////
                 ERC-20 6-DECIMAL INTEGER HELPERS
//////////////////////////////////////////////////////////////*/

export const UNITS_6_PER_DOLLAR = 1_000_000n
export const UNITS_6_PER_CENT = 10_000n

/**
 * Calculate spare-change roundup in 6-decimal units.
 * Exactly matches onchain contract calculation.
 * Whole-dollar payments return 0n.
 */
export function calculateRoundup6(paymentAmount6: bigint): bigint {
  if (paymentAmount6 < 0n) throw new RangeError('paymentAmount6 must be non-negative')
  const rem = paymentAmount6 % UNITS_6_PER_DOLLAR
  if (rem === 0n) return 0n
  return UNITS_6_PER_DOLLAR - rem
}

export function centsToUsdc6(cents: bigint): bigint {
  return cents * UNITS_6_PER_CENT
}

export function usdc6ToCents(units6: bigint): bigint {
  return units6 / UNITS_6_PER_CENT
}

export function formatUsdc6(units6: bigint, minDecimals = 2): string {
  const negative = units6 < 0n
  const abs = negative ? -units6 : units6
  const whole = abs / UNITS_6_PER_DOLLAR
  const rem = abs % UNITS_6_PER_DOLLAR
  const fracFull = rem.toString().padStart(6, '0')
  const frac = minDecimals === 2 ? fracFull.slice(0, 2) : fracFull.slice(0, minDecimals)
  return `${negative ? '-' : ''}$${whole}.${frac}`
}

/**
 * Format all meaningful ERC-20 USDC decimals without rounding or truncating.
 * At least two fractional digits are shown; trailing zeroes beyond cents are
 * removed so sub-cent values remain exact without noisy zero padding.
 */
export function formatUsdc6Exact(units6: bigint): string {
  const negative = units6 < 0n
  const abs = negative ? -units6 : units6
  const whole = groupWhole((abs / UNITS_6_PER_DOLLAR).toString())
  const fraction = (abs % UNITS_6_PER_DOLLAR).toString().padStart(6, '0')
  const trimmed = fraction.replace(/0+$/, '')
  const visible = trimmed.length < 2 ? fraction.slice(0, 2) : trimmed
  return `${negative ? '-' : ''}$${whole}.${visible}`
}

