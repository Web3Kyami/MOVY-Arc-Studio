'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Camera, ImagePlus, Grid2X2, Trash2 } from 'lucide-react'
import { AVATARS, useLocalProfile } from '@/hooks/use-local-profile'
import { useDialogFocus } from '@/hooks/use-dialog-focus'
import { ProfileAvatar } from '../profile-avatar'
import { prepareProfilePhoto } from '@/lib/profile-photo'

export function EditProfileView() {
  const local = useLocalProfile()
  if (!local.ready) return <p role="status">Loading profile...</p>
  if (local.error) return <p role="alert">Your profile could not be loaded. Refresh to try again.</p>
  return <ProfileEditor key={local.identity || 'disconnected'} local={local} />
}

function ProfileEditor({ local }: { local: ReturnType<typeof useLocalProfile> }) {
  const router = useRouter()
  const [draft, setDraft] = useState(local.profile)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [avatarsOpen, setAvatarsOpen] = useState(false)
  const cameraSupported = Boolean(typeof window !== 'undefined' && window.isSecureContext && navigator.mediaDevices?.getUserMedia)
  const [cameraOpen, setCameraOpen] = useState(false)
  const [cameraReady, setCameraReady] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const photoOptions = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const alive = useRef(true)
  const cameraRequest = useRef(0)
  const dialog = useRef<HTMLDivElement>(null)

  function stopCamera() {
    cameraRequest.current += 1
    stream.current?.getTracks().forEach(track => track.stop())
    stream.current = null
    setCameraOpen(false)
    setCameraReady(false)
  }
  useDialogFocus(cameraOpen, dialog, stopCamera)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      cameraRequest.current += 1
      stream.current?.getTracks().forEach(track => track.stop())
    }
  }, [])
  useEffect(() => {
    if (cameraOpen && cameraReady && video.current && stream.current) {
      video.current.srcObject = stream.current
      void video.current.play().catch(() => { setError('Camera playback failed. You can upload a photo instead.'); stopCamera() })
    }
  }, [cameraOpen, cameraReady])

  async function upload(file?: File) {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const photo = await prepareProfilePhoto(file)
      if (alive.current) setDraft(previous => ({ ...previous, photo }))
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : 'This photo could not be read.')
    } finally { if (alive.current) setBusy(false) }
  }

  async function takePhoto() {
    setError(null)
    setCameraOpen(true)
    setCameraReady(false)
    const request = ++cameraRequest.current
    try {
      const next = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 720 } }, audio: false })
      if (!alive.current || request !== cameraRequest.current) { next.getTracks().forEach(track => track.stop()); return }
      stream.current = next
      setCameraReady(true)
    } catch {
      if (alive.current && request === cameraRequest.current) {
        stopCamera()
        setError('Camera access is unavailable. Allow camera access in your browser, or upload a photo instead.')
      }
    }
  }

  async function capture() {
    const source = video.current
    if (!source || !source.videoWidth) { setError('The camera is not ready yet. Try again.'); return }
    const canvas = document.createElement('canvas')
    canvas.width = source.videoWidth
    canvas.height = source.videoHeight
    canvas.getContext('2d')?.drawImage(source, 0, 0)
    stopCamera()
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', .9))
    if (blob && alive.current) await upload(new File([blob], 'camera.jpg', { type: 'image/jpeg' }))
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    const name = draft.name.trim()
    if (!name || name.length > 60) { setError('Enter a name between 1 and 60 characters.'); return }
    try {
      setBusy(true)
      await local.save({ ...draft, name })
      router.push('/settings')
    } catch { setError('Your profile could not be saved. Check your wallet and try again.') } finally { setBusy(false) }
  }

  return (
    <form className="consumer-editor" onSubmit={save}>
      <div className="editor-heading">
        <Link href="/settings" aria-label="Back to Settings"><ArrowLeft size={20} /></Link>
        <h1>Edit profile</h1>
      </div>
      <div className="editor-avatar">
        <button type="button" className="profile-edit-photo" aria-label="Change profile photo" onClick={() => photoOptions.current?.querySelector('button')?.focus()}>
          <ProfileAvatar profile={draft} size={136} />
          <span className="photo-badge"><Camera size={16} /></span>
        </button>
      </div>
      <div ref={photoOptions} className="photo-options">
        {cameraSupported && <button type="button" className="settings-row" disabled={busy} onClick={takePhoto}><Camera /><span>Take photo</span></button>}
        <button type="button" className="settings-row" disabled={busy} onClick={() => input.current?.click()}><ImagePlus /><span>{busy ? 'Processing photo...' : 'Choose from gallery'}</span></button>
        <input ref={input} type="file" aria-label="Upload photo" accept="image/jpeg,image/png,image/webp" hidden onChange={event => { void upload(event.target.files?.[0]); event.target.value = '' }} />
        <button type="button" className="settings-row" disabled={busy} aria-expanded={avatarsOpen} onClick={() => setAvatarsOpen(!avatarsOpen)}><Grid2X2 /><span>Choose an avatar</span></button>
        <button type="button" className="settings-row destructive" disabled={busy} onClick={() => { setDraft(previous => ({ ...previous, photo: null, avatar: 'sage' })); setError(null) }}><Trash2 /><span>Remove photo</span></button>
      </div>
      {avatarsOpen && (
        <div className="avatar-options" role="radiogroup" aria-label="Profile avatar">
          {AVATARS.map((avatar, index) => (
            <button key={avatar} type="button" role="radio" aria-label={`${avatar === 'portrait' ? 'Portrait' : avatar.charAt(0).toUpperCase() + avatar.slice(1)} avatar`} aria-checked={!draft.photo && draft.avatar === avatar}
              tabIndex={(!draft.photo && draft.avatar === avatar || draft.photo && index === 0) ? 0 : -1}
              onClick={() => setDraft(previous => ({ ...previous, photo: null, avatar }))}
              onKeyDown={event => {
                if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
                  event.preventDefault()
                  const next = (index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + AVATARS.length) % AVATARS.length
                  setDraft(previous => ({ ...previous, photo: null, avatar: AVATARS[next] }))
                  ;(event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus()
                }
              }}><ProfileAvatar profile={{ ...draft, avatar, photo: null }} size={48} /></button>
          ))}
        </div>
      )}
      <label className="editor-field" htmlFor="profile-name">Name
        <input id="profile-name" autoComplete="nickname" value={draft.name} maxLength={60} onChange={event => setDraft(previous => ({ ...previous, name: event.target.value }))} aria-describedby={error ? 'profile-error' : 'profile-privacy'} aria-invalid={error && !draft.name.trim() ? true : undefined} />
      </label>
      <p id="profile-privacy" className="settings-note">{local.identity?.endsWith(':demo') ? 'Saved on this device.' : 'Your name is public. Saving needs a wallet signature.'}</p>
      {error && <p id="profile-error" className="consumer-error" role="alert">{error}</p>}
      <div className="editor-save"><button type="submit" disabled={busy || !local.identity} className="consumer-primary">Save</button><Link href="/settings">Cancel</Link></div>
      {cameraOpen && <div className="consumer-overlay"><div ref={dialog} className="consumer-dialog" role="dialog" aria-modal="true" aria-labelledby="camera-title" tabIndex={-1}>
        <h2 id="camera-title">Take photo</h2>
        <video ref={video} muted playsInline aria-label="Camera preview" />
        {!cameraReady && <p role="status">Waiting for camera access...</p>}
        <button type="button" className="consumer-primary" disabled={!cameraReady} onClick={() => void capture()}>Capture photo</button>
        <button type="button" data-dialog-autofocus onClick={stopCamera}>Cancel</button>
      </div></div>}
    </form>
  )
}
