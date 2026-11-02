import assert from 'node:assert/strict'

globalThis.window = new EventTarget()
window.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
const { demoWagmiConfig } = await import('../src/lib/wagmi.ts')
assert.equal(demoWagmiConfig._internal.mipd, undefined, 'Demo must not start wallet discovery')
const provider = { request: async () => [], on: () => {}, removeListener: () => {} }
window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: {
  info: { uuid: '00000000-0000-4000-8000-000000000001', name: 'Test wallet', icon: 'data:image/svg+xml,<svg/>', rdns: 'test.wallet' },
  provider,
} }))
await new Promise((resolve) => setTimeout(resolve, 20))
assert.deepEqual(demoWagmiConfig.connectors, [], 'Demo must ignore EIP-6963 provider announcements')
console.log('PASS: Demo ignores a simulated EIP-6963 wallet announcement')
