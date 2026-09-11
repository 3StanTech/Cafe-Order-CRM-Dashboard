import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { getImportRecoveryStorageKey, saveImportWorkspace } from '../../import/draft-recovery'
import { AuthBoundary, GELLY_AUTH_SIGNED_OUT_EVENT } from '../AuthBoundary'
import type { AuthClient } from '../supabaseAuth'

type SessionState = { session: object | null }

function createAuthClient({ session = null, signInError = null }: { session?: object | null; signInError?: object | null } = {}) {
  let currentSession = session
  const subscription = { unsubscribe: vi.fn() }
  let onAuthStateChange: ((event: string, nextSession: object | null) => void) | undefined
  const client = {
    auth: {
      getSession: vi.fn(async (): Promise<{ data: SessionState }> => ({ data: { session: currentSession } })),
      onAuthStateChange: vi.fn((callback: (event: string, nextSession: object | null) => void) => {
        onAuthStateChange = callback
        return { data: { subscription } }
      }),
      signInWithPassword: vi.fn(async () => ({ error: signInError })),
      signOut: vi.fn(async () => {
        currentSession = null
        onAuthStateChange?.('SIGNED_OUT', null)
        return { error: null }
      }),
    },
  } as unknown as AuthClient

  return client
}

function renderBoundary(client: AuthClient, demoMode = false) {
  return render(<AuthBoundary client={client} demoMode={demoMode}><p>Private dashboard</p></AuthBoundary>)
}

describe('AuthBoundary', () => {
  afterEach(() => {
    window.history.pushState({}, '', '/')
    localStorage.clear()
  })

  it('bypasses the PIN gate in demo mode', () => {
    renderBoundary(createAuthClient(), true)
    expect(screen.getByText('Private dashboard')).toBeInTheDocument()
    expect(screen.queryByLabelText('PIN')).not.toBeInTheDocument()
  })

  it('shows only a PIN field and safely rejects an invalid PIN', async () => {
    const client = createAuthClient({ signInError: { message: 'credentials invalid' } })
    const user = userEvent.setup()
    renderBoundary(client)

    await screen.findByLabelText('PIN')
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('PIN'), '1234')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByRole('alert')).toHaveTextContent("That PIN didn't work. Try again.")
    expect(screen.queryByText('credentials invalid')).not.toBeInTheDocument()
  })

  it('restores an existing session after a remount', async () => {
    const client = createAuthClient({ session: { access_token: 'test' } })
    const firstRender = renderBoundary(client)
    expect(await screen.findByText('Private dashboard')).toBeInTheDocument()
    firstRender.unmount()

    renderBoundary(client)
    expect(await screen.findByText('Private dashboard')).toBeInTheDocument()
  })

  it('returns to the PIN gate after sign-out', async () => {
    const client = createAuthClient({ session: { access_token: 'test' } })
    const user = userEvent.setup()
    renderBoundary(client)

    await screen.findByText('Private dashboard')
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(screen.getByLabelText('PIN')).toBeInTheDocument())
    expect(client.auth.signOut).toHaveBeenCalledOnce()
  })

  it('dispatches gelly-auth-signed-out on sign-out', async () => {
    const client = createAuthClient({ session: { access_token: 'test' } })
    const user = userEvent.setup()
    const onSignedOut = vi.fn()
    window.addEventListener(GELLY_AUTH_SIGNED_OUT_EVENT, onSignedOut)
    renderBoundary(client)

    await screen.findByText('Private dashboard')
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(onSignedOut).toHaveBeenCalled())
    window.removeEventListener(GELLY_AUTH_SIGNED_OUT_EVENT, onSignedOut)
  })

  it('clears import recovery keys on sign-out even when Import is unmounted', async () => {
    const ownerA = 'angela@madebyangela.local'
    const ownerB = 'other@madebyangela.local'
    expect(saveImportWorkspace(ownerA, { rawText: 'viber paste a', drafts: [] })).toBe(true)
    expect(saveImportWorkspace(ownerB, { rawText: 'viber paste b', drafts: [] })).toBe(true)
    const keyA = getImportRecoveryStorageKey(ownerA)
    const keyB = getImportRecoveryStorageKey(ownerB)
    expect(localStorage.getItem(keyA)).toBeTruthy()
    expect(localStorage.getItem(keyB)).toBeTruthy()

    const client = createAuthClient({ session: { access_token: 'test' } })
    const user = userEvent.setup()
    renderBoundary(client)

    await screen.findByText('Private dashboard')
    expect(screen.queryByText('Import')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(screen.getByLabelText('PIN')).toBeInTheDocument())
    expect(localStorage.getItem(keyA)).toBeNull()
    expect(localStorage.getItem(keyB)).toBeNull()
  })
})
