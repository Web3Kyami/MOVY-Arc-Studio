import assert from 'node:assert/strict'

// Exercise API handler behavior with no database configuration. This process
// cannot use a developer or hosted database by construction.
delete process.env.DATABASE_URL
delete process.env.MOVY_DATABASE_URL
delete process.env.MOVY_TEST_ALLOW_LOCAL_POSTGRES
process.env.NODE_ENV = 'production'
process.env.MOVY_TARGET_NETWORK = 'testnet'
process.env.NEXT_PUBLIC_MOVY_TARGET_NETWORK = 'testnet'
process.env.NEXT_PUBLIC_MOVY_CHAIN_ID = '5042002'
process.env.MOVY_DATABASE_NETWORK = 'testnet'
process.env.MOVY_PRODUCT_ORIGINS = 'https://product.movy.test'
process.env.MOVY_DEMO_ORIGINS = 'https://demo.movy.test'
process.env.MOVY_DEMO_ENTRY_ORIGIN = 'https://demo.movy.test'
process.env.MOVY_WORKER_ENABLED = 'false'
process.env.MOVY_RELAYER_ENABLED = 'false'
process.env.ARC_TESTNET_RPC_URL = 'https://rpc.testnet.arc.io'
process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL = 'https://rpc.testnet.arc.io'
process.env.NEXT_PUBLIC_ARC_TESTNET_EXPLORER_URL = 'https://explorer.testnet.arc.io'
process.env.NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET = '0xd4a54e8315331a3ecd7e27a0bc4ff007a932332d'
process.env.MOVY_AUTO_SAVER_TESTNET_DEPLOY_BLOCK = '64445085'

const product = 'https://product.movy.test'
const wallet = '0x000000000000000000000000000000000000dEaD'
const browserHeaders = {
  origin: product,
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
}
const request = (path, init = {}) => new Request(`${product}${path}`, {
  ...init,
  headers: { ...browserHeaders, ...(init.headers || {}) },
})

const [health, enrollment, activity, autoActivity, summary, status, opsHealth, cron] = await Promise.all([
  import('../src/app/api/health/route.ts'),
  import('../src/app/api/enrollment/route.ts'),
  import('../src/app/api/activity/route.ts'),
  import('../src/app/api/auto-saver/activity/route.ts'),
  import('../src/app/api/auto-saver/activity/summary/route.ts'),
  import('../src/app/api/status/route.ts'),
  import('../src/app/api/ops/health/route.ts'),
  import('../src/app/api/worker/cron/route.ts'),
])

const results = await Promise.all([
  health.GET(request('/api/health')),
  enrollment.GET(request(`/api/enrollment?wallet=${wallet}&chainId=5042002`)),
  activity.GET(request(`/api/activity?wallet=${wallet}&chainId=5042002`)),
  autoActivity.GET(request(`/api/auto-saver/activity?wallet=${wallet}&chainId=5042002`)),
  summary.GET(request(`/api/auto-saver/activity/summary?wallet=${wallet}&chainId=5042002`)),
  status.GET(request('/api/status?chainId=5042002')),
  opsHealth.GET(request('/api/ops/health')),
  cron.GET(request('/api/worker/cron')),
])

for (const index of [0, 1, 2, 3, 4, 5]) {
  assert.equal(results[index].status, 503, `DB-backed route ${index} must fail closed with 503`)
  assert.equal(results[index].headers.get('cache-control'), 'no-store', `DB-backed route ${index} must not be cached`)
}
for (const index of [6, 7]) assert.equal(results[index].status, 401, 'unauthenticated operational route must reject before DB access')

for (const response of results) {
  const body = await response.json()
  assert.doesNotMatch(JSON.stringify(body), /DATABASE_URL|postgres(?:ql)?:\/\/|password|stack/i)
}

console.log('PASS: health, enrollment, activity, summary and status fail closed with redacted 503s without a database; operator and cron routes reject unauthenticated requests')
