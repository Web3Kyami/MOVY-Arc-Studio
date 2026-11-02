export function shouldReadEnrollmentStatus(input: {
  enabled: boolean
  isConnected: boolean
  hasAddress: boolean
  chainId?: number
  expectedChainId: number
}): boolean {
  return input.enabled && input.isConnected && input.hasAddress && input.chainId === input.expectedChainId
}
