import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const environment = process.argv[2]
if (environment !== 'preview') {
  throw new Error('For safety this tool only creates a preview relayer secret. Production activation needs a separate controlled release approval.')
}
if (process.env.MOVY_CREATE_RELAYER_WALLET !== '1' || process.env.CI) {
  throw new Error('Set MOVY_CREATE_RELAYER_WALLET=1 only during the owner-controlled secret-store setup (not CI).')
}
let linkedProject
try {
  linkedProject = JSON.parse(await readFile('.vercel/project.json', 'utf8'))
} catch {
  throw new Error('Link the intended MOVY Vercel project before creating a relayer secret.')
}
if (typeof linkedProject.projectName !== 'string' || linkedProject.projectName.toLowerCase() !== 'movy') {
  throw new Error('The linked Vercel project is not named MOVY; refusing to store a relayer secret.')
}

const privateKey = generatePrivateKey()
const secretBytes = Buffer.from(privateKey, 'utf8')
const publicAddress = privateKeyToAccount(privateKey).address
const child = spawn('vercel', ['env', 'add', 'RELAYER_PRIVATE_KEY', 'preview'], {
  shell: false,
  stdio: ['pipe', 'ignore', 'ignore'],
})

const payload = Buffer.concat([secretBytes, Buffer.from('\n')])
const completion = new Promise((resolve, reject) => {
  child.once('error', () => reject(new Error('Could not start the Vercel CLI; no private key was displayed.')))
  child.once('exit', (code) => code === 0
    ? resolve()
    : reject(new Error('Vercel did not accept the relayer secret. No private key was displayed.')))
})
child.stdin.end(payload)
try {
  await completion
} finally {
  secretBytes.fill(0)
  payload.fill(0)
}

console.log(JSON.stringify({ chainId: 5042002, publicAddress, secretConfiguration: 'stored in Vercel Preview environment' }))
