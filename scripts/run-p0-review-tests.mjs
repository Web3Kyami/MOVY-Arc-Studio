import { spawnSync } from 'node:child_process'

const tests = [
  'scripts/test-p0-review-activation.mjs',
  'scripts/test-p0-review-worker-lock.mjs',
  'scripts/test-p0-review-indexer.mjs',
  'scripts/test-p0-review-enrollment-history.mjs',
  'scripts/test-p0-review-pending-migration-gate.mjs',
  'scripts/test-p0-review-relayer-recovery.mjs',
  'scripts/test-relayer-global-pause.mjs',
  'scripts/test-p0-review-enrollment.mjs',
]

for (const test of tests) {
  const env = { ...process.env }
  delete env.RELAYER_PRIVATE_KEY
  delete env.MOVY_DEPLOYER_KEY
  delete env.MOVY_TRUST_PROXY_IP_HEADER
  const result = spawnSync(process.execPath, ['scripts/run-postgres-isolated.mjs', test], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
