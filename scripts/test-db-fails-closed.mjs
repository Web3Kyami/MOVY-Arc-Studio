import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const directory = mkdtempSync(join(tmpdir(), 'movy-db-config-'))
const accidentalSqlitePath = join(directory, 'should-not-be-created.sqlite')

try {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    MOVY_DB_PATH: accidentalSqlitePath,
    MOVY_TARGET_NETWORK: 'testnet',
    NEXT_PUBLIC_MOVY_TARGET_NETWORK: 'testnet',
    NEXT_PUBLIC_MOVY_CHAIN_ID: '5042002',
    MOVY_DATABASE_NETWORK: 'testnet',
    MOVY_WORKER_ENABLED: 'false',
    MOVY_RELAYER_ENABLED: 'false',
    ARC_TESTNET_RPC_URL: 'https://rpc.testnet.arc.io',
    NEXT_PUBLIC_ARC_TESTNET_RPC_URL: 'https://rpc.testnet.arc.io',
    NEXT_PUBLIC_ARC_TESTNET_EXPLORER_URL: 'https://explorer.testnet.arc.io',
    NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET: '0xd4a54e8315331a3ecd7e27a0bc4ff007a932332d',
    MOVY_AUTO_SAVER_TESTNET_DEPLOY_BLOCK: '64445085',
  }
  delete env.DATABASE_URL
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e',
    "import { getDb } from './src/lib/server/db.ts'; getDb()",
  ], { cwd: process.cwd(), env, encoding: 'utf8' })

  assert.notEqual(result.status, 0, 'production database access must fail without DATABASE_URL')
  assert.match(result.stderr, /DATABASE_URL is required/i)
  assert.equal(existsSync(accidentalSqlitePath), false, 'production must never fall back to a local SQLite file')

  const localDatabaseEnv = {
    ...process.env,
    NODE_ENV: 'production',
    CI: 'true',
    DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/movy_test?sslmode=disable',
    MOVY_TARGET_NETWORK: 'testnet',
    NEXT_PUBLIC_MOVY_TARGET_NETWORK: 'testnet',
    NEXT_PUBLIC_MOVY_CHAIN_ID: '5042002',
    MOVY_DATABASE_NETWORK: 'testnet',
    MOVY_WORKER_ENABLED: 'false',
    MOVY_RELAYER_ENABLED: 'false',
    ARC_TESTNET_RPC_URL: 'https://rpc.testnet.arc.io',
    NEXT_PUBLIC_ARC_TESTNET_RPC_URL: 'https://rpc.testnet.arc.io',
    NEXT_PUBLIC_ARC_TESTNET_EXPLORER_URL: 'https://explorer.testnet.arc.io',
    NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET: '0xd4a54e8315331a3ecd7e27a0bc4ff007a932332d',
    MOVY_AUTO_SAVER_TESTNET_DEPLOY_BLOCK: '64445085',
  }
  delete localDatabaseEnv.MOVY_TEST_ALLOW_LOCAL_POSTGRES
  const localWithoutOptIn = spawnSync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e',
    "import { getDb } from './src/lib/server/db.ts'; getDb()",
  ], { cwd: process.cwd(), env: localDatabaseEnv, encoding: 'utf8' })
  assert.notEqual(localWithoutOptIn.status, 0, 'CI alone must not bypass the production Neon requirement')
  assert.match(localWithoutOptIn.stderr, /Production DATABASE_URL must use a Neon pooled endpoint/i)

  const isolatedTestEnv = { ...localDatabaseEnv, MOVY_TEST_ALLOW_LOCAL_POSTGRES: 'true' }
  const isolatedTest = spawnSync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e',
    "import { getDb, closeDb } from './src/lib/server/db.ts'; getDb(); await closeDb()",
  ], { cwd: process.cwd(), env: isolatedTestEnv, encoding: 'utf8' })
  assert.equal(isolatedTest.status, 0, isolatedTest.stderr)

  const noCiEnv = { ...isolatedTestEnv, CI: 'false' }
  const noCi = spawnSync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e',
    "import { getDb } from './src/lib/server/db.ts'; getDb()",
  ], { cwd: process.cwd(), env: noCiEnv, encoding: 'utf8' })
  assert.notEqual(noCi.status, 0, 'the local PostgreSQL test flag is ineffective outside CI')
  assert.match(noCi.stderr, /Production DATABASE_URL must use a Neon pooled endpoint/i)
  console.log('PASS: production database configuration fails closed without creating SQLite state')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
