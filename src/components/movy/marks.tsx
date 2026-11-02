/**
 * Original marks for the Demo Store catalogue.
 *
 * MOVY ships no third-party imagery. The upstream base repository's `public/`
 * folder contains 52 trademark logos and 10 photographs of people, none of which
 * are covered by its MIT grant; see `references/UPSTREAM-MANIFEST.md`. These
 * marks are drawn here as inline SVG so there is no asset pipeline, no binary
 * blob, and no licensing question.
 */
export function ItemMark({ mark, className }: { mark: 'coffee' | 'sticker' | 'cookie'; className?: string }) {
  const common = {
    className: className ?? 'size-10',
    viewBox: '0 0 40 40',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg',
    'aria-hidden': true as const,
  }

  if (mark === 'coffee') {
    return (
      <svg {...common}>
        <rect x="4" y="12" width="24" height="18" rx="5" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="2" />
        <path d="M28 17h4a5 5 0 0 1 0 10h-4" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
        <path
          d="M12 3c-1.6 2-1.6 3.6 0 5.6M19 3c-1.6 2-1.6 3.6 0 5.6"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.6"
        />
      </svg>
    )
  }

  if (mark === 'sticker') {
    return (
      <svg {...common}>
        <path
          d="M20 5c8 0 15 5 15 13s-7 17-15 17S5 26 5 18 12 5 20 5Z"
          fill="var(--accent-soft)"
          stroke="var(--accent)"
          strokeWidth="2"
        />
        <path
          d="M13 19c2-3 4-3 6 0s4 3 6 0"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    )
  }

  return (
    <svg {...common}>
      <circle cx="20" cy="20" r="14" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="2" />
      <circle cx="15" cy="17" r="1.8" fill="var(--accent)" />
      <circle cx="24" cy="15" r="1.6" fill="var(--accent)" />
      <circle cx="21" cy="24" r="2" fill="var(--accent)" />
      <circle cx="13" cy="24" r="1.5" fill="var(--accent)" />
    </svg>
  )
}
