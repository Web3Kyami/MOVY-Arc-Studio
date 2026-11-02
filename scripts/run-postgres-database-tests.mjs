import { spawnSync } from 'node:child_process'

for (const script of ['scripts/test-postgres-concurrency.mjs', 'scripts/test-sqlite-import.mjs', 'scripts/test-relayer-disabled.mjs', 'scripts/test-operations-routes.mjs']) {
  const result = spawnSync(process.execPath, ['scripts/run-postgres-isolated.mjs', script], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
