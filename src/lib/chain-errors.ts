/**
 * Turn a chain-transport failure into something a person can act on.
 *
 * The raw viem error for a dropped request is several lines of JSON-RPC detail:
 * `HTTP request failed. URL: … Request body: {"method":"eth_call","params":[…]}
 * Raw Call Arguments: … Contract Call: … Docs: …`. That is a developer message.
 * On a phone, behind a mobile network, a dropped request is almost always a
 * connectivity or rate-limit problem the user can fix by retrying, so that is what
 * it should say.
 */

import { ACTIVE_NETWORK_LABEL } from './chain'

export type ChainErrorKind =
  | 'offline'
  | 'timeout'
  | 'rate-limited'
  | 'range-too-large'
  | 'reverted'
  | 'unknown'

export interface FriendlyChainError {
  kind: ChainErrorKind
  title: string
  body: string
  /** Whether simply trying again is likely to help. */
  retryable: boolean
}

const OFFLINE_PATTERNS = [
  'failed to fetch',
  'networkerror',
  'network request failed',
  'load failed',
  'err_internet_disconnected',
  'econnrefused',
  'econnreset',
  'socket hang up',
]

const TIMEOUT_PATTERNS = ['timeout', 'timed out', 'aborted', 'aborterror']

const RATE_PATTERNS = [
  'requested range too large',
  'rate limit',
  'too many requests',
  '429',
  'exceeded',
]

const REVERT_PATTERNS = [
  'reverted',
  'execution reverted',
  'movyzero',
  'movyself',
  'movyvalue',
  'movypurchase',
  'movyinsufficient',
  'movyreentrancy',
  'movymerchant',
]

function includes(message: string, needles: string[]): boolean {
  return needles.some((n) => message.includes(n))
}

export function describeChainError(raw: unknown): FriendlyChainError {
  const message = (raw instanceof Error ? raw.message : String(raw ?? '')).toLowerCase()

  if (includes(message, OFFLINE_PATTERNS)) {
    return {
      kind: 'offline',
      title: `Could not reach ${ACTIVE_NETWORK_LABEL}`,
      body: `The connection to ${ACTIVE_NETWORK_LABEL} dropped. Check your internet, then try again. Nothing was charged and nothing changed.`,
      retryable: true,
    }
  }

  if (includes(message, TIMEOUT_PATTERNS)) {
    return {
      kind: 'timeout',
      title: `${ACTIVE_NETWORK_LABEL} took too long to answer`,
      body: 'The request timed out before the node replied. Try again — on a slow connection this is usually temporary.',
      retryable: true,
    }
  }

  if (includes(message, RATE_PATTERNS)) {
    return {
      kind: 'rate-limited',
      title: 'Too many requests to the public node',
      body: `The shared ${ACTIVE_NETWORK_LABEL} node is rate limiting. Wait a few seconds and try again.`,
      retryable: true,
    }
  }

  if (includes(message, REVERT_PATTERNS)) {
    return {
      kind: 'reverted',
      title: 'The contract rejected that',
      body: 'Nothing was paid and your savings did not change. A MOVY payment is all or nothing.',
      retryable: false,
    }
  }

  return {
    kind: 'unknown',
    title: 'Something went wrong reading the chain',
    body: message
      ? message.split('\n')[0].slice(0, 160)
      : `The ${ACTIVE_NETWORK_LABEL} node returned an unexpected response. Try again.`,
    retryable: true,
  }
}
