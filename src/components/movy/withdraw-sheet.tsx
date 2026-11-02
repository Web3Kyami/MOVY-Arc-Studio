'use client'

import { useState } from 'react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { PaymentBreakdownView } from './payment-breakdown'
import { useWithdraw } from '@/hooks/use-payment'
import { useWallet } from '@/hooks/use-wallet'
import { centsToWei, formatCents, formatFee, weiToCents } from '@/lib/money'
import { useIsMobile } from '@/hooks/use-mobile'
import { txUrl } from '@/lib/chain'

/**
 * Owner-controlled withdrawal.
 *
 * Two rules from `CONTRACT-ARCHITECTURE.md` are made visible here rather than
 * assumed: the recipient is always the connected wallet, and the amount can never
 * exceed the savings balance. The maximum is enforced by the input clamping and
 * again by the contract, so the UI cannot offer a withdrawal the chain will
 * reject.
 */
export function WithdrawSheet({
  open,
  onOpenChange,
  savingsWei,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  savingsWei: bigint
  onDone: () => void
}) {
  const wallet = useWallet()
  const withdraw = useWithdraw({ enabled: open })
  const isMobile = useIsMobile()
  const [amount, setAmount] = useState<string>('all')

  const savingsCents = weiToCents(savingsWei)
  const requestedCents = amount === 'all' ? savingsCents : parseCentsLoose(amount)
  const requestedWei = centsToWei(requestedCents ?? 0n)
  const invalid = requestedCents === null || requestedCents <= 0n || requestedWei > savingsWei

  const canSend =
    !invalid &&
    wallet.isConnected && !wallet.isWrongNetwork &&
    withdraw.feeQuote.state === 'ready' &&
    savingsWei > 0n &&
    wallet.nativeWei >= withdraw.feeQuote.reserveWei &&
    withdraw.phase !== 'awaitingSignature' &&
    withdraw.phase !== 'submitted'

  const finish = () => {
    withdraw.reset()
    setAmount('all')
    onDone()
    onOpenChange(false)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? 'bottom' : 'right'}
        className="max-h-[88dvh] overflow-y-auto border-border bg-surface md:w-[26rem] md:max-w-[26rem] md:rounded-l-[length:var(--radius-card)] md:rounded-tr-none"
      >
        <SheetHeader className="px-5 pt-5 pb-0">
          <SheetTitle className="text-xl font-bold">Withdraw savings</SheetTitle>
          <SheetDescription className="text-sm">
            Savings go back to your connected wallet. Only you can trigger this.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 px-5 py-5">
          {withdraw.phase === 'confirmed' ? (
            <div className="space-y-3 rounded-[length:var(--radius-control)] border border-success/30 bg-success-soft p-4">
              <p className="text-sm font-bold text-success">Withdrawal confirmed</p>
              {withdraw.hash ? (
                <a
                  href={txUrl(wallet.network, withdraw.hash)}
                  target="_blank"
                  rel="noreferrer"
                  className="money-wrap block font-mono text-xs text-success underline"
                >
                  {withdraw.hash}
                </a>
              ) : null}
            </div>
          ) : null}

          {withdraw.phase === 'failed' ? (
            <p role="alert" className="money-wrap rounded-[length:var(--radius-control)] border border-error/30 bg-error-soft p-3 text-sm text-error">
              {withdraw.errorMessage ?? 'The withdrawal did not complete.'}
            </p>
          ) : null}

          {withdraw.phase !== 'confirmed' ? (
            <>
              <div className="flex items-baseline justify-between gap-3 rounded-[length:var(--radius-control)] border p-3">
                <span className="text-sm text-muted-foreground">Available</span>
                <span className="money text-base font-bold">{formatCents(savingsCents)}</span>
              </div>

              <div className="space-y-2">
                <label htmlFor="movy-withdraw-amount" className="block text-sm font-medium">
                  Amount
                </label>
                <div className="flex gap-2">
                  <input
                    id="movy-withdraw-amount"
                    inputMode="decimal"
                    value={amount === 'all' ? formatCents(savingsCents).replace('$', '') : amount}
                    onChange={(e) => setAmount(e.target.value)}
                    aria-describedby="movy-withdraw-hint"
                    className="money h-12 w-full rounded-[length:var(--radius-field)] border bg-transparent px-3 text-lg font-semibold"
                  />
                  <Button variant="outline" onClick={() => setAmount('all')} className="min-h-12 shrink-0">
                    Max
                  </Button>
                </div>
                <p id="movy-withdraw-hint" className="text-sm text-muted-foreground">
                  {invalid && amount !== ''
                    ? savingsWei === 0n
                      ? 'There is nothing to withdraw yet.'
                      : 'Enter an amount up to your available savings.'
                    : 'Network fee is separate and comes from your USDC balance.'}
                </p>
              </div>

              <div className="rounded-[length:var(--radius-control)] border p-3">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-muted-foreground">You receive</span>
                  <span className="money font-semibold">
                    {invalid ? '—' : formatCents(requestedCents ?? 0n)}
                  </span>
                </div>
                <div className="mt-1 flex items-baseline justify-between gap-3 text-xs">
                  <span className="text-muted-foreground">Network fee</span>
                  <span className="money text-muted-foreground">
                    {withdraw.feeQuote.isLoading
                      ? 'Estimating…'
                      : `${formatFee(withdraw.feeQuote.worstCaseWei)} USDC`}
                  </span>
                </div>
              </div>

              <Button
                onClick={async () => {
                  const ok = await withdraw.submit(requestedWei)
                  if (ok) onDone()
                }}
                disabled={!canSend}
                className="min-h-11 w-full"
              >
                {withdraw.phase === 'awaitingSignature'
                  ? 'Waiting for your wallet…'
                  : 'Withdraw to my wallet'}
              </Button>
              <p className="text-xs text-muted-foreground">
                Recipient: your connected wallet. There is no other withdrawal path.
              </p>
            </>
          ) : null}

          {withdraw.phase === 'confirmed' ? (
            <Button onClick={finish} className="min-h-11 w-full">
              Done
            </Button>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function parseCentsLoose(value: string): bigint | null {
  const trimmed = value.trim().replace(/^\$/, '')
  if (!/^\d+(\.\d{0,2})?$/.test(trimmed)) return null
  const [whole = '0', frac = ''] = trimmed.split('.')
  return BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2))
}

export { PaymentBreakdownView }
