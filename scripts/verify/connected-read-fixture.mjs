import { toFunctionSelector } from 'viem'
export const WALLET_A = '0x1111111111111111111111111111111111111111'
export const WALLET_B = '0x2222222222222222222222222222222222222222'
export async function connectedReadFixture(context) {
  await context.addInitScript(
    ({ A }) => {
      let accounts = [localStorage.getItem('movy_verification_wallet') || A]
      let chain = '0x4cef52'
      const listeners = new Map()
      window.__writes = []
      const provider = {
        isMetaMask: true,
        async request({ method }) {
          if (/sign|sendTransaction/.test(method)) {
            window.__writes.push(method)
            throw new Error('Signing prohibited in verification')
          }
          if (method === 'eth_chainId') return chain
          if (method === 'eth_accounts' || method === 'eth_requestAccounts') return accounts
          if (method === 'wallet_requestPermissions') return [{ parentCapability: 'eth_accounts' }]
          return null
        },
        on(event, fn) {
          if (!listeners.has(event)) listeners.set(event, new Set())
          listeners.get(event).add(fn)
          return provider
        },
        removeListener(event, fn) {
          listeners.get(event)?.delete(fn)
          return provider
        },
      }
      window.__switchWallet = (address) => {
        accounts = [address]
        localStorage.setItem('movy_verification_wallet', address)
        listeners.get('accountsChanged')?.forEach((fn) => fn(accounts))
      }
      window.__wrongChain = () => {
        chain = '0x1'
        listeners.get('chainChanged')?.forEach((fn) => fn(chain))
      }
      Object.defineProperty(window, 'ethereum', { configurable: true, value: provider })
    },
    { A: WALLET_A },
  )
  const savingsSelector = toFunctionSelector('savingsOf(address)')
  await context.route('https://rpc.testnet.arc.io**', async (route) => {
    const payload = route.request().postDataJSON()
    const respond = (request) => ({
      jsonrpc: '2.0',
      id: request.id,
      result:
        request.method === 'eth_chainId'
          ? '0x4cef52'
          : request.method === 'eth_getCode'
            ? '0x'
            : request.method === 'eth_getLogs'
              ? []
              : request.method === 'eth_call'
                ? `0x${(request.params?.[0]?.data?.startsWith(savingsSelector) ? 2n * 10n ** 18n : 0n).toString(16).padStart(64, '0')}`
                : '0x0',
    })
    await route.fulfill({ json: Array.isArray(payload) ? payload.map(respond) : respond(payload) })
  })
  await context.route('**/api/enrollment?**', (route) =>
    route.fulfill({ json: { enrollment: null, onchainConfig: null } }),
  )
  await context.route('**/api/auto-saver/activity**', (route) =>
    route.fulfill({
      json: route.request().url().includes('/summary')
        ? { confirmedRoundups6: '0', confirmedRoundupCount: 0, recordedLast7DaysRoundups6: '0' }
        : { activity: [] },
    }),
  )
}
export async function connectViaSettings(page, base) {
  await page.goto(`${base}/settings`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click()
  await page.getByRole('button', { name: /Connect Injected|Connect MetaMask/ }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
}
