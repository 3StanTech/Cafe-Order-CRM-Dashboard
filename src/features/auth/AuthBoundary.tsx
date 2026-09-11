import { LoaderCircle } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import gellyLogo from '../../assets/brand/gelly-logo-mark.png'
import { clearAllImportWorkspaces } from '../import/draft-recovery'
import { DASHBOARD_AUTH_EMAIL, getAuthClient, isDemoMode, type AuthClient } from './supabaseAuth'

type AuthState = 'loading' | 'signed-out' | 'signed-in'

type AuthBoundaryProps = {
  children: ReactNode
  client?: AuthClient | null
  demoMode?: boolean
}

export const GELLY_AUTH_SIGNED_OUT_EVENT = 'gelly-auth-signed-out'

function dispatchAuthSignedOut() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(GELLY_AUTH_SIGNED_OUT_EVENT))
}

export function AuthBoundary({ children, client = getAuthClient(), demoMode = isDemoMode }: AuthBoundaryProps) {
  const [authState, setAuthState] = useState<AuthState>(demoMode ? 'signed-in' : 'loading')

  useEffect(() => {
    if (demoMode) return
    if (!client) {
      setAuthState('signed-out')
      return
    }

    let active = true
    const applySession = (session: Session | null) => {
      if (active) setAuthState(session ? 'signed-in' : 'signed-out')
    }

    void client.auth.getSession().then(({ data }) => applySession(data.session)).catch(() => applySession(null))
    const { data: listener } = client.auth.onAuthStateChange((event, session) => {
      applySession(session)
      if (event === 'SIGNED_OUT') {
        clearAllImportWorkspaces()
        dispatchAuthSignedOut()
      }
    })

    return () => {
      active = false
      listener.subscription.unsubscribe()
    }
  }, [client, demoMode])

  if (demoMode) return <>{children}</>
  if (authState === 'loading') return <AuthLoading />
  if (authState === 'signed-out' || !client) return <PinGate client={client} onSignedIn={() => setAuthState('signed-in')} />

  return <AuthenticatedSession client={client} onSignedOut={() => setAuthState('signed-out')}>{children}</AuthenticatedSession>
}

function AuthLoading() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#FBF3D5] px-5 text-center">
      <p className="motion-fade-in flex items-center gap-2 text-sm font-semibold text-[#4A5365]" role="status">
        <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" size={16} />
        Checking your session…
      </p>
    </main>
  )
}

type PinGateProps = {
  client: AuthClient | null
  onSignedIn: () => void
}

function PinGate({ client, onSignedIn }: PinGateProps) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!client || submitting) return

    setError('')
    setSubmitting(true)
    try {
      const { error: signInError } = await client.auth.signInWithPassword({
        email: DASHBOARD_AUTH_EMAIL,
        password: pin,
      })
      if (signInError) {
        setError("That PIN didn't work. Try again.")
        return
      }

      onSignedIn()
    } catch {
      setError("That PIN didn't work. Try again.")
    } finally {
      setPin('')
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#FBF3D5] px-5 py-8">
      <section aria-labelledby="pin-gate-title" className="motion-fade-up w-full max-w-sm rounded-3xl border border-[#4F74C8]/20 bg-white/70 p-6 shadow-sm">
        <img src={gellyLogo} alt="" className="mx-auto size-16 rounded-full shadow-[0_0_0_4px_rgba(79,116,200,0.1)]" height={64} width={64} />
        <p className="mt-4 text-center text-xs font-bold tracking-[0.18em] text-[#4F74C8]">MADE BY ANGELA</p>
        <h1 id="pin-gate-title" className="mt-1 text-center text-3xl font-bold tracking-tight text-[#20242F]">Gelly Dashboard</h1>
        <p className="mt-2 text-center text-sm leading-6 text-[#4A5365]">Enter your PIN to continue.</p>
        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <div>
            <label className="sr-only" htmlFor="dashboard-pin">PIN</label>
            <input
              id="dashboard-pin"
              aria-describedby={error ? 'pin-error' : undefined}
              autoComplete="current-password"
              className="w-full rounded-xl border border-[#4F74C8]/30 bg-white px-4 py-3 text-center text-lg tracking-[0.3em] text-[#20242F] outline-none transition focus:border-[#4F74C8] focus:ring-2 focus:ring-[#4F74C8]/30"
              inputMode="numeric"
              name="pin"
              onChange={(event) => setPin(event.target.value)}
              pattern="[0-9]*"
              placeholder="••••"
              required
              type="password"
              value={pin}
            />
            {error && <p id="pin-error" className="motion-fade-in mt-2 text-sm font-medium text-[#A33B3B]" role="alert">{error}</p>}
          </div>
          <button
            className="w-full rounded-xl bg-[#4F74C8] px-4 py-3 font-bold text-white transition duration-200 hover:bg-[#365AA9] active:scale-[0.98] motion-safe:transition-transform disabled:cursor-wait disabled:opacity-70"
            disabled={submitting}
            type="submit"
          >
            {submitting ? 'Unlocking…' : 'Continue'}
          </button>
        </form>
      </section>
    </main>
  )
}

function AuthenticatedSession({ children, client, onSignedOut }: { children: ReactNode; client: AuthClient; onSignedOut: () => void }) {
  const [signingOut, setSigningOut] = useState(false)

  async function handleSignOut() {
    if (signingOut) return
    setSigningOut(true)
    try {
      const { error } = await client.auth.signOut()
      if (!error) {
        clearAllImportWorkspaces()
        dispatchAuthSignedOut()
        onSignedOut()
      }
    } catch {
      // The existing session remains active if Supabase cannot complete sign-out.
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <>
      <button
        aria-label="Sign out"
        className="fixed right-4 top-[max(0.75rem,env(safe-area-inset-top))] z-20 rounded-full border border-[#4F74C8]/30 bg-[#FBF3D5]/95 px-3 py-1.5 text-xs font-bold text-[#365AA9] shadow-sm backdrop-blur transition duration-200 hover:bg-white active:scale-95 motion-safe:transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4F74C8] disabled:opacity-60"
        disabled={signingOut}
        onClick={handleSignOut}
        type="button"
      >
        {signingOut ? 'Signing out…' : 'Sign out'}
      </button>
      {children}
    </>
  )
}
