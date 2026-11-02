/**
 * Explicit production activation is bound to the verified deployment and signer.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} network
 * @param {{address: string, roles?: {relayer: string}}} [deployment]
 */
export function assertProductionAutomation(env, network, deployment = undefined) {
  const worker = env.MOVY_WORKER_ENABLED
  const relayer = env.MOVY_RELAYER_ENABLED
  if (!['true', 'false'].includes(worker) || !['true', 'false'].includes(relayer)) {
    throw new Error('Production automation switches must be explicitly true or false')
  }
  if (worker === 'false' && relayer === 'false') return
  if (network !== 'mainnet' || !deployment) {
    throw new Error('Production automation requires an approved Mainnet deployment')
  }
  if (relayer === 'true' && worker !== 'true') {
    throw new Error('Relayer activation requires the worker to be enabled')
  }
  for (const [key, expected] of [
    ['MOVY_AUTOMATION_APPROVED_CONTRACT', deployment.address],
    ['MOVY_AUTOMATION_APPROVED_RELAYER', deployment.roles?.relayer],
  ]) {
    const value = env[key]
    if (!expected || !/^0x[0-9a-fA-F]{40}$/.test(value ?? '') || value.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`${key} must match the verified Mainnet deployment`)
    }
  }
}
