# Third-party notices

Full licence texts are in [`LICENSE`](./LICENSE). This file is the human-readable
index: what came from where, at which commit, and what was deliberately left
behind.

## Upstream provenance

| Project | Repository | Pinned commit | Licence | Role |
|---|---|---|---|---|
| shadcn-fintech | https://github.com/abderrahimghazali/shadcn-fintech | `e338240d10c908ab49403adbcd0bb4cc980ebfce` | MIT, (c) 2026 Abderrahim Ghazali | App base: shell, routes, Tailwind v4 theme, shadcn primitives |
| FinKit UI | https://github.com/amirito/finkit-ui | `e52bbc981ac8f78264aa41ae52b6a195b705cd40` | MIT, (c) 2024 Fintech-Kit | Component donor: three components adapted, none copied verbatim |

Both upstream `LICENSE` files were opened and read at those commits and their
SHA-256 hashes are recorded in the project handoff's
`references/UPSTREAM-MANIFEST.md`. Both are unmodified MIT texts. Both notices are
retained here and in `LICENSE`.

Neither repository is vendored as a submodule, subtree or tarball. MOVY has its
own history; provenance lives in this file and in the header comment of each
adapted component.

## What MOVY took from shadcn-fintech

Retained largely as-is:

- `src/components/ui/*.tsx` — 8 shadcn primitives (`button`, `card`, `badge`,
  `dialog`, `sheet`, `input`, `separator`, `skeleton`). These are generated
  shadcn components built on `@base-ui/react` and carry their own upstream
  provenance.
- `src/lib/utils.ts`, `src/hooks/use-mobile.ts` (rewritten to
  `useSyncExternalStore`; see below), `next.config.ts`, `postcss.config.mjs`,
  `tsconfig.json` (target raised to ES2022), `eslint.config.mjs`,
  `components.json`.

Rewritten:

- `src/app/layout.tsx` — metadata, viewport and font wiring replaced; the
  `TooltipProvider` and upstream OpenGraph screenshot reference removed.
- `src/app/globals.css` — token block replaced with the MOVY palette. The
  upstream neutral grey palette is not carried over.
- `package.json` — dependencies pruned to what the MVP uses.

**Not taken:** all 15 upstream pages (dashboard, accounts, analytics, budgets,
cards, crypto, investments, notifications, support, transactions, transfers,
sign-in, sign-up), `src/data/seed.ts` (52 KB of mock financial data), and the
`@dnd-kit`, `three`, `@react-three/*`, `date-fns`, `react-day-picker` and `cmdk`
dependencies, all of which were tied to the removed pages.

## What MOVY took from FinKit UI

No file is copied verbatim. Three components contributed structure that was
rewritten. Each adapted file carries a header comment naming the origin path,
the pinned commit, the licence, and the specific changes made.

| Origin file | MOVY file | Copied? | What changed |
|---|---|---|---|
| `src/components/fintech/HeroBalanceCard.tsx` | `src/components/movy/savings-hero.tsx` | Structure only | Hardcoded "Total Balance" → "Saved with roundups"; trend chip → real weekly-saved and roundup-count; float `formatCurrency` → integer-cents formatter; gradient removed; dead `BalanceCardChart` and unread `showVisibilityToggle` dropped |
| `src/components/fintech/TransactionRow.tsx` | `src/components/movy/activity-row.tsx` | Structure only | Two money values (purchase + roundup) instead of one signed amount; removed up/down colouring; `Sub` badge dropped; root became a `<button>` for keyboard access; no fixed widths |
| `src/components/fintech/TransactionDetailDrawer.tsx` | `src/components/movy/activity-detail.tsx` | Layout only | Radix dialog → existing shadcn `Sheet` (Base UI); `x` animation → axis-correct per breakpoint; hardcoded `Visa •••• 1234`, PDF receipt, dispute button and fake `StatusTimeline` clock times all removed |
| `src/components/fintech/Progress.tsx` | — | **Not used** | Duplicate of the base's shadcn `progress`; no real savings goal exists in the MVP, and `DESIGN-SYSTEM.md` forbids a fictional progress meter |
| `src/components/fintech/CurrencyInput.tsx` | `src/components/movy/amount-input.tsx` | **Reimplemented** | Donor parses money with `parseFloat` and round-trips an `Intl` string through the input value, which `AGENT-INSTRUCTIONS.md` forbids. Reimplemented on `BigInt` integer cents |
| `src/lib/formatters.ts` | `src/lib/money.ts` | **Reimplemented** | Donor takes `number` and runs it through `Intl.NumberFormat`. MOVY's module has no `number` parameters anywhere |
| `src/providers/FinKitProvider.tsx` | — | **Not used** | Writes inline CSS variables onto `document.documentElement`, which would override the `next-themes` class-based theme already in the app |
| `src/styles/theme.css` | — | **Not used** | Hardcoded dark palette; would defeat the MOVY visual direction |

## Why there are no third-party images

`LICENSE-NOTES.md` in the handoff predicted that "MIT licensing of source does not
automatically grant rights to every third-party image or trademark in a
repository." That was verified: the upstream shadcn-fintech `public/` directory
holds **55 files** that its MIT grant does not cover —

- 52 brand logos, overwhelmingly third-party trademarks: `starbucks-com.png`,
  `netflix-com.png`, `visa-com.svg`, `mastercard-com.svg`, `uber-com.png`,
  `amazon-com.png`, `paypal-com.png`, `chase-com.png`, `target-com.png`,
  `doordash-com.png`, `shell-com.svg`, and roughly forty more including crypto
  marks;
- 10 `.jpg` files of identifiable people used as profile placeholders;
- one 519 KB screenshot advertising the upstream product, referenced by its
  `metadata.openGraph`.

**None of the 55 were copied.** MOVY's `public/` contains no binary assets. The
Demo Store marks in `src/components/movy/marks.tsx` are original inline SVG drawn
for this project, and merchant identity is carried by text. This is recorded as
decision D14.

## Fonts

Geist and Geist Mono are loaded through `next/font/google` at build time under the
SIL Open Font License 1.1. No font file is vendored into this repository, so no
OFL text is required in `LICENSE` beyond the attribution in this file. The handoff
instructed not to license a new font for the MVP, and none was added.

## Independent review

The `MovySavings` contract is unaudited hackathon code. Nothing in this file should
be read as a security claim.
