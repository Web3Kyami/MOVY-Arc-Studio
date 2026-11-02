import { Skeleton } from '@/components/ui/skeleton'
import { describeChainError } from '@/lib/chain-errors'
import { cn } from '@/lib/utils'

/** Shown for every list surface when a wallet is connected but has no history. */
export function EmptyState({
  title,
  body,
  action,
  className,
}: {
  title: string
  body: string
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-2 rounded-[length:var(--radius-card)] border border-dashed px-6 py-10 text-center',
        className,
      )}
    >
      <p className="text-sm font-semibold">{title}</p>
      <p className="max-w-[36ch] text-sm text-muted-foreground">{body}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}

export function LoadingRows({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-[length:var(--radius-control)] border p-3">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  )
}

/**
 * Error surface. Always offers a retry and never silently swallows the message.
 * `role="alert"` so a screen reader announces it when it appears.
 *
 * Chain failures are translated before they get here: the raw viem error for a
 * dropped request is a wall of JSON-RPC detail that means nothing to a person.
 */
export function ErrorNote({
  title,
  body,
  onRetry,
  className,
}: {
  title: string
  body: string
  onRetry?: () => void
  className?: string
}) {
  return (
    <div
      role="alert"
      className={cn(
        'space-y-3 rounded-[length:var(--radius-card)] border border-error/30 bg-error-soft p-4',
        className,
      )}
    >
      <div>
        <p className="text-sm font-semibold text-error">{title}</p>
        <p className="text-sm leading-relaxed text-foreground/80">{body}</p>
      </div>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex min-h-9 items-center rounded-[length:var(--radius-control)] border border-error/40 px-3 text-sm font-medium text-error transition-colors hover:bg-error/10"
        >
          Try again
        </button>
      ) : null}
    </div>
  )
}

/** Error surface for anything read from the chain. */
export function ChainErrorNote({
  error,
  onRetry,
  className,
}: {
  error: unknown
  onRetry?: () => void
  className?: string
}) {
  const friendly = describeChainError(error)
  return (
    <ErrorNote title={friendly.title} body={friendly.body} onRetry={onRetry} className={className} />
  )
}

export function SectionHeading({
  children,
  id,
  className,
}: {
  children: React.ReactNode
  id?: string
  className?: string
}) {
  return (
    <h2 id={id} className={cn('text-sm font-semibold tracking-tight text-muted-foreground', className)}>
      {children}
    </h2>
  )
}
