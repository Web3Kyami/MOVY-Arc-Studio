import * as React from "react"

const MOBILE_BREAKPOINT = 768

/**
 * Media-query subscription.
 *
 * This replaces the upstream base's `useEffect` + `setState` version, which the
 * React compiler correctly flags: it renders once with a default, then corrects
 * itself. `useSyncExternalStore` reads the query during render, subscribes to
 * changes, and takes a server snapshot so the first client render matches the
 * server HTML with no hydration mismatch.
 *
 * The server snapshot is `true` because mobile is the canonical layout for MOVY
 * (`DECISIONS.md` D4), so a dialog renders as a bottom sheet on first paint.
 */
const query = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

function subscribe(onChange: () => void) {
  if (typeof window === "undefined") return () => {}
  const mql = window.matchMedia(query)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

function getSnapshot(): boolean {
  if (typeof window === "undefined") return true
  return window.matchMedia(query).matches
}

function getServerSnapshot(): boolean {
  return true
}

export function useIsMobile(): boolean {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
