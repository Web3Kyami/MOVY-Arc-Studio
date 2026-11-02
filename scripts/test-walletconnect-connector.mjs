import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = 'movy-walletconnect-test-project'

const { wagmiConfig, demoWagmiConfig } = await import('../src/lib/wagmi.ts')
// RainbowKit uses mock connector implementations when rendering on the server.
// Its metadata still identifies the wallet choices the browser will configure.
const walletNames = wagmiConfig.connectors.map((connector) => connector.rkDetails?.name).filter(Boolean)
assert.ok(walletNames.includes('Rainbow'), 'Rainbow is offered by the configured chooser')
assert.ok(walletNames.includes('MetaMask'), 'MetaMask is offered by the configured chooser')
assert.ok(walletNames.includes('WalletConnect'), 'mobile and QR transport is configured')
assert.deepEqual(demoWagmiConfig.connectors, [], 'the isolated Demo origin exposes no wallet connectors')

const fallbackConfig = spawnSync(process.execPath, [
  '--import', 'tsx', '--input-type=module', '-e',
  "const { wagmiConfig } = await import('./src/lib/wagmi.ts'); console.log(JSON.stringify(wagmiConfig.connectors.map(({ id }) => id)))",
], {
  cwd: process.cwd(),
  encoding: 'utf8',
  env: { ...process.env, NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: '' },
})
assert.equal(fallbackConfig.status, 0, fallbackConfig.stderr)
const fallbackConnectorIds = JSON.parse(fallbackConfig.stdout)
assert.deepEqual(fallbackConnectorIds, ['metaMask', 'rabby'], 'only the configured EVM extension options remain without WalletConnect')

console.log('PASS: RainbowKit wallet metadata is configured and Demo stays wallet-free')
