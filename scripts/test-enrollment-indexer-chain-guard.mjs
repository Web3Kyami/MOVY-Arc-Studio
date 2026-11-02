import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { getEnrollmentHistoryCursor } from '../src/lib/server/db.ts'
import { processEnrollmentEvents } from '../src/lib/server/enrollment-indexer.ts'

const originalRpc = process.env.ARC_TESTNET_RPC_URL
const originalPublicRpc = process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL
const server = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  const payload = JSON.parse(body)
  const result = (Array.isArray(payload) ? payload : [payload]).map(({ id, method }) => {
    assert.equal(method, 'eth_chainId', 'Wrong-network preflight must stop before requesting event logs')
    return { jsonrpc: '2.0', id, result: '0x1' }
  })
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(Array.isArray(payload) ? result : result[0]))
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
process.env.ARC_TESTNET_RPC_URL = `http://127.0.0.1:${address.port}`
process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL = process.env.ARC_TESTNET_RPC_URL
try {
  await assert.rejects(
    () => processEnrollmentEvents(5042002, 100),
    /Enrollment indexer RPC chain ID does not match the requested network/,
  )
  assert.equal(await getEnrollmentHistoryCursor(5042002), null, 'Wrong-network RPC must not advance the durable enrollment cursor')
} finally {
  server.close()
  if (originalRpc === undefined) delete process.env.ARC_TESTNET_RPC_URL
  else process.env.ARC_TESTNET_RPC_URL = originalRpc
  if (originalPublicRpc === undefined) delete process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL
  else process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL = originalPublicRpc
}

console.log('Enrollment indexer refuses wrong-chain RPC before reading logs or writing cursors')
