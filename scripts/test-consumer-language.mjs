import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const modeSource = readFileSync('src/hooks/use-movy-mode-data.ts', 'utf8')
const homeSource = readFileSync('src/components/movy/views/home-view.tsx', 'utf8')
const consumerFiles = [
  'src/components/movy/views/home-view.tsx',
  'src/components/movy/views/savings-view.tsx',
  'src/components/movy/views/settings-view.tsx',
  'src/components/movy/onboarding/onboarding-flow.tsx',
  'src/hooks/use-payment.ts',
  'src/components/movy/views/enrollment-revocation-control.tsx',
]

assert.match(modeSource, /label: 'Connected'/)
assert.doesNotMatch(modeSource, /Arc Testnet Connected/i)
assert.doesNotMatch(modeSource, /Fetching blockchain data/i)
assert.match(modeSource, /Loading savings activity/)
assert.doesNotMatch(homeSource, /Supported network Arc/i)
assert.doesNotMatch(homeSource, /Enroll on \$\{ACTIVE_NETWORK_LABEL\} before changing automatic savings/)

// User-facing wallet setup uses the selected network; transaction review retains
// explicit network and chain ID disclosure at approval boundaries.
for (const file of consumerFiles) {
  assert.doesNotMatch(readFileSync(file, 'utf8'), /Arc Testnet/i, `${file} should not contain Testnet-only consumer copy`)
}
const settingsSource = readFileSync('src/components/movy/views/settings-view.tsx', 'utf8')
const onboardingSource = readFileSync('src/components/movy/onboarding/onboarding-flow.tsx', 'utf8')
assert.doesNotMatch(settingsSource, /Verify your \$\{ACTIVE_NETWORK_LABEL\} enrollment before changing automatic saving/)
assert.match(settingsSource, /\? 'Enrolled'/)
assert.doesNotMatch(onboardingSource, /Connect an \{ACTIVE_NETWORK_LABEL\} wallet/)
assert.match(settingsSource, /\(chain \{ACTIVE_CHAIN_ID\}\)/)
assert.match(onboardingSource, /USDC allowance on \{ACTIVE_NETWORK_LABEL\} \(chain \{ACTIVE_CHAIN_ID\}\)/)

console.log('PASS: everyday wallet/status copy is consumer-facing and network guidance remains at wallet controls')
