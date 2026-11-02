// next.config.ts derives development preview hostnames only from explicitly configured,
// strictly validated product origins. Run with: node --import tsx scripts/test-dev-origins-config.mjs
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const configUrl = pathToFileURL(path.resolve('next.config.ts')).href
let version = 0
async function configFor(env) {
  const saved = { NODE_ENV: process.env.NODE_ENV, MOVY_PRODUCT_ORIGINS: process.env.MOVY_PRODUCT_ORIGINS }
  for (const key of Object.keys(saved)) delete process.env[key]
  Object.assign(process.env, env)
  try {
    return (await import(`${configUrl}?case=${version++}`)).default
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const dev = { NODE_ENV: 'development' }

// Nothing configured: default Next.js behavior, no allowedDevOrigins key at all.
assert.equal('allowedDevOrigins' in await configFor({ ...dev }), false)
assert.equal('allowedDevOrigins' in await configFor({ ...dev, MOVY_PRODUCT_ORIGINS: '   ' }), false)

// Exact origins yield exact hostnames; loopback hosts are skipped; duplicates collapse.
assert.deepEqual(
  (await configFor({ ...dev, MOVY_PRODUCT_ORIGINS: 'http://0.0.0.0:5173 https://preview.example.app https://preview.example.app:8443 http://localhost:3000' })).allowedDevOrigins,
  ['preview.example.app'],
)
assert.deepEqual(
  (await configFor({ ...dev, MOVY_PRODUCT_ORIGINS: 'https://a.example.app, https://b.example.app' })).allowedDevOrigins,
  ['a.example.app', 'b.example.app'],
)
assert.equal('allowedDevOrigins' in await configFor({ ...dev, MOVY_PRODUCT_ORIGINS: 'http://localhost:3000 http://127.0.0.1:3111' }), false, 'loopback-only adds nothing')

// Any invalid entry rejects the whole list (fail closed) and leaves default behavior.
for (const bad of [
  'https://*.example.app',
  '*',
  'https://example.app/path',
  'https://example.app/?q=1',
  'https://example.app/#frag',
  'https://user:pass@example.app',
  'ftp://example.app',
  'example.app',
  'https://',
  'not a url',
  'https://good.example.app https://*.bad.example.app',
  'https://good.example.app https://bad.example.app/x',
  'https://Example.App.', // non-canonical origin
]) {
  const config = await configFor({ ...dev, MOVY_PRODUCT_ORIGINS: bad })
  assert.equal('allowedDevOrigins' in config, false, `must reject ${JSON.stringify(bad)}`)
}

// Production never gets development origins.
assert.equal('allowedDevOrigins' in await configFor({ NODE_ENV: 'production', MOVY_PRODUCT_ORIGINS: 'https://preview.example.app' }), false)

// No wildcard can ever appear in what is returned.
const result = await configFor({ ...dev, MOVY_PRODUCT_ORIGINS: 'https://preview.example.app' })
assert.ok(result.allowedDevOrigins.every((host) => !host.includes('*')))

console.log('PASS: dev preview hostnames come only from strictly validated configured product origins')
