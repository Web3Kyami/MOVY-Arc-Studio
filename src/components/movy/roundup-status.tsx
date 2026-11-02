import Link from 'next/link'

export function RoundupStatus() {
  return (
    <section className="space-y-2 rounded-[length:var(--radius-card)] border bg-surface p-5">
      <h2 className="font-semibold">Automatic roundups are not active</h2>
      <p className="text-sm text-muted-foreground">Enable automatic spare-change savings in Settings to automatically save with every purchase.</p>
      <Link href="/settings" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent">Manage roundup settings</Link>
    </section>
  )
}
