import { randomBytes, createHash } from 'node:crypto'
import { isAddress, verifyMessage, type Address, type Hex } from 'viem'
import { getDb } from '@/lib/server/db'
import { guardProductApiRequest } from '@/lib/server/api-origin-guard'
import { profileMessage, validProfile } from '@/lib/profile-contract'

export const runtime = 'nodejs'
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } })
const walletOf = (value: unknown) => typeof value === 'string' && isAddress(value) ? value.toLowerCase() : null

export async function GET(request: Request) {
  const blocked = guardProductApiRequest(request, { requireBrowserRequest: true })
  if (blocked) return blocked
  const wallet = walletOf(new URL(request.url).searchParams.get('wallet'))
  if (!wallet) return reply({ error: 'Invalid wallet' }, 400)
  try {
    const result = await getDb().query('SELECT name, avatar, photo FROM wallet_profiles WHERE wallet = $1', [wallet])
    return reply({ profile: result.rows[0] ?? null })
  } catch { return reply({ error: 'Profile unavailable' }, 503) }
}

export async function POST(request: Request) {
  const blocked = guardProductApiRequest(request)
  if (blocked) return blocked
  try {
    const body = await request.json()
    const wallet = walletOf(body.wallet)
    if (!wallet) return reply({ error: 'Invalid wallet' }, 400)
    const nonce = randomBytes(32).toString('hex')
    const client = await getDb().connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT pg_advisory_xact_lock(hashtext('movy-profile-challenges'))")
      await client.query('DELETE FROM wallet_profile_challenges WHERE expires_at < now()')
      const count = await client.query('SELECT count(*)::int AS total, count(*) FILTER (WHERE wallet = $1)::int AS wallet_total FROM wallet_profile_challenges', [wallet])
      if (count.rows[0].total >= 2048 || count.rows[0].wallet_total >= 3) {
        await client.query('ROLLBACK')
        return reply({ error: 'Too many requests. Try again later.' }, 429)
      }
      await client.query("INSERT INTO wallet_profile_challenges (nonce, wallet, expires_at) VALUES ($1, $2, now() + interval '5 minutes')", [nonce, wallet])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    return reply({ nonce })
  } catch { return reply({ error: 'Profile unavailable' }, 503) }
}

export async function PUT(request: Request) {
  const blocked = guardProductApiRequest(request)
  if (blocked) return blocked
  if (Number(request.headers.get('content-length') || 0) > 510_000) return reply({ error: 'Profile too large' }, 413)
  try {
    const text = await request.text()
    if (text.length > 510_000) return reply({ error: 'Profile too large' }, 413)
    const { wallet: rawWallet, nonce, signature, profile } = JSON.parse(text)
    const wallet = walletOf(rawWallet)
    if (!wallet || typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonce) || typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature) || signature.length > 2000 || !validProfile(profile)) return reply({ error: 'Invalid profile' }, 400)
    const digest = createHash('sha256').update(JSON.stringify(profile)).digest('hex')
    const verified = await verifyMessage({ address: wallet as Address, message: profileMessage(wallet, nonce, digest), signature: signature as Hex }).catch(() => false)
    if (!verified) return reply({ error: 'Invalid signature' }, 401)
    const client = await getDb().connect()
    try {
      await client.query('BEGIN')
      const challenge = await client.query('DELETE FROM wallet_profile_challenges WHERE nonce = $1 AND wallet = $2 AND expires_at > now() RETURNING nonce', [nonce, wallet])
      if (!challenge.rowCount) { await client.query('ROLLBACK'); return reply({ error: 'Challenge expired or already used' }, 401) }
      await client.query('INSERT INTO wallet_profiles (wallet, name, avatar, photo) VALUES ($1, $2, $3, $4) ON CONFLICT (wallet) DO UPDATE SET name = EXCLUDED.name, avatar = EXCLUDED.avatar, photo = EXCLUDED.photo, updated_at = now()', [wallet, profile.name, profile.avatar, profile.photo])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    return reply({ ok: true })
  } catch { return reply({ error: 'Profile could not be saved' }, 503) }
}
