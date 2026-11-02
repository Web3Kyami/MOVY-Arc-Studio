import { spawnSync } from 'node:child_process'

const tests = [
  'scripts/test-observer-relayer.mjs',
  'scripts/test-observer-inspection-retry.mjs',
]

for (const test of tests) {
  const result = spawnSync(process.execPath, ['scripts/run-postgres-isolated.mjs', test], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1
    break
  }
}
