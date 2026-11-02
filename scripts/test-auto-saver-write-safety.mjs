import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import {
  assertAutoSaverWriteAllowed,
  AutoSaverWriteSafetyError,
  isUnsafeAutoSaverAddress,
} from '../src/lib/auto-saver-write-safety.ts'

const unsafe = '0xd4a54e8315331a3ecd7e27a0bc4ff007a932332d'
assert.equal(isUnsafeAutoSaverAddress('testnet', unsafe), true)
assert.equal(isUnsafeAutoSaverAddress('mainnet', unsafe), false, 'Testnet denylist cannot cross networks')
assert.equal(isUnsafeAutoSaverAddress('testnet', '0x1111111111111111111111111111111111111111'), false)

for (const action of ['enroll', 'update-config', 'increase-allowance', 'resume']) {
  assert.throws(
    () => assertAutoSaverWriteAllowed('testnet', unsafe, action),
    AutoSaverWriteSafetyError,
    `${action} must be blocked for the compromised Testnet contract`,
  )
}
for (const action of ['pause', 'revoke', 'clear-allowance']) {
  assert.doesNotThrow(
    () => assertAutoSaverWriteAllowed('testnet', unsafe, action),
    `${action} remains available as a protective action`,
  )
}
assert.doesNotThrow(() => assertAutoSaverWriteAllowed('mainnet', unsafe, 'enroll'))

const hook = readFileSync(new URL('../src/hooks/use-auto-saver.ts', import.meta.url), 'utf8')
assert.match(hook, /assertAutoSaverWriteAllowed\(ACTIVE_NETWORK, contractAddress, 'enroll'\)/)
assert.match(hook, /targetAllowance6 === 0n \? 'clear-allowance' : 'increase-allowance'/)
assert.match(hook, /assertAutoSaverWriteAllowed\(ACTIVE_NETWORK, contractAddress, 'update-config'\)/)
assert.match(hook, /isPaused \? 'pause' : 'resume'/)
assert.match(hook, /assertAutoSaverWriteAllowed\(ACTIVE_NETWORK, contractAddress, 'revoke'\)/)

// Compiled for Mainnet (NEXT_PUBLIC_MOVY_TARGET_NETWORK is inlined at build time): the Testnet
// denylist is not bundled, so a Testnet selection must be refused rather than silently allowed.
const safetyModule = pathToFileURL(new URL('../src/lib/auto-saver-write-safety.ts', import.meta.url).pathname).href
function inMainnetBuild(code) {
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    const m = await import(${JSON.stringify(safetyModule)})
    ${code}
    console.log('child-ok')
  `], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { PATH: process.env.PATH, HOME: process.env.HOME ?? '/tmp', NEXT_PUBLIC_MOVY_TARGET_NETWORK: 'mainnet' },
    encoding: 'utf8',
  })
}
const mainnetBuild = inMainnetBuild(`
  assert.equal(m.UNSAFE_TESTNET_AUTO_SAVER_ADDRESSES.size, 0, 'no Testnet contract address is bundled in a Mainnet build')
  assert.equal(m.isUnsafeAutoSaverAddress('mainnet', '${unsafe}'), false)
  assert.equal(m.isUnsafeAutoSaverAddress('mainnet', undefined), false)
  for (const address of ['${unsafe}', '0x1111111111111111111111111111111111111111', undefined]) {
    assert.equal(m.isUnsafeAutoSaverAddress('testnet', address), true, 'a Testnet selection is always unsafe in a Mainnet build')
    assert.throws(() => m.assertAutoSaverWriteAllowed('testnet', address, 'enroll'), m.AutoSaverWriteSafetyError)
    assert.throws(() => m.assertAutoSaverWriteAllowed('testnet', address, 'increase-allowance'), m.AutoSaverWriteSafetyError)
    assert.doesNotThrow(() => m.assertAutoSaverWriteAllowed('testnet', address, 'revoke'))
  }
  assert.doesNotThrow(() => m.assertAutoSaverWriteAllowed('mainnet', '0x2222222222222222222222222222222222222222', 'enroll'))
`)
assert.equal(mainnetBuild.status, 0, `${mainnetBuild.stdout}\n${mainnetBuild.stderr}`)
assert.match(mainnetBuild.stdout, /child-ok/)

console.log('PASS: compromised Testnet AutoSaver cannot receive new approvals, enrollments, or config/resume writes; pause, revoke, and allowance reset remain available')
