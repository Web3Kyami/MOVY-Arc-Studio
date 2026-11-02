import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'))
assert.equal(vercel.git?.deploymentEnabled?.['audit/movy-full-stack-certification'], false)
assert.equal(Object.hasOwn(vercel, 'crons'), false, 'the project must not schedule a financial worker')

console.log('PASS: the audit branch is excluded from Vercel deployments and no Cron schedule is configured')
