import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalAdapter, resetLocalAdapterMemoryForTests } from '../../../data/local-adapter'
import { GELLY_AUTH_SIGNED_OUT_EVENT } from '../../auth/AuthBoundary'
import { DASHBOARD_AUTH_EMAIL } from '../../auth/supabaseAuth'
import { getImportRecoveryStorageKey } from '../draft-recovery'
import { ImportWorkspace } from '../ImportWorkspace'

const getSessionMock = vi.fn()
const getAuthClientMock = vi.fn()

vi.mock('../../auth/supabaseAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../auth/supabaseAuth')>()
  return {
    ...actual,
    getAuthClient: () => getAuthClientMock(),
  }
})

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  getSessionMock.mockReset()
  getAuthClientMock.mockReset()
  localStorage.clear()
})

function withSessionToken(token: string | null) {
  getSessionMock.mockResolvedValue({ data: { session: token ? { access_token: token } : null } })
  getAuthClientMock.mockReturnValue({ auth: { getSession: getSessionMock } })
}

const validLocalOrder = '{"customer_name":"Mika","items":[{"product_slug":"matcha-latte","quantity":1}],"address":"Makati"}'
const secondLocalOrder = '{"customer_name":"Aira","items":[{"product_slug":"strawberry-hojicha","quantity":2}],"address":"Quezon City"}'

describe('ImportWorkspace local JSON intake', () => {
  it('keeps JSON local and blocks Viber text without calling the extraction endpoint', async () => {
    resetLocalAdapterMemoryForTests()
    const adapter = await LocalAdapter.create()
    const user = userEvent.setup()
    getAuthClientMock.mockReturnValue(null)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<ImportWorkspace adapter={adapter} />)
    const input = screen.getByRole('textbox', { name: 'Paste order JSON or JSON Lines' })
    expect(screen.getByText(/Viber text extraction is unavailable in this release/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /ChatGPT/i })).not.toBeInTheDocument()
    fireEvent.change(input, { target: { value: validLocalOrder } })
    await user.click(screen.getByRole('button', { name: 'Create drafts from JSON' }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await screen.findByText('1 draft ready')).toBeInTheDocument()
    expect(screen.queryByText('Editable order draft')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(await screen.findByText('Editable order draft')).toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'Mika: one matcha latte, Makati' } })
    await user.click(screen.getByRole('button', { name: 'Create drafts from JSON' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/Viber text extraction is unavailable.*Paste order JSON or JSON Lines/i)
    expect(screen.getByText('1 draft ready')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
    await adapter.close()
  })
})

describe('ImportWorkspace batch confirm, recovery, and duplicates', () => {
  it('confirms selected ready drafts and leaves unresolved drafts in the list', async () => {
    resetLocalAdapterMemoryForTests()
    const adapter = await LocalAdapter.create()
    const user = userEvent.setup()
    withSessionToken('session-token-abc')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const before = await adapter.listOrders()
    render(<ImportWorkspace adapter={adapter} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Paste order JSON or JSON Lines' }), {
      target: { value: `[${validLocalOrder},${secondLocalOrder}]` },
    })
    await user.click(screen.getByRole('button', { name: 'Create drafts from JSON' }))
    expect(await screen.findByText('2 drafts ready')).toBeInTheDocument()
    expect(screen.queryByText('No delivery date')).not.toBeInTheDocument()
    expect(screen.queryByText('Editable order draft')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Select all ready orders' }))
    await user.click(screen.getByRole('button', { name: 'Confirm selected (2)' }))
    await waitFor(async () => {
      expect((await adapter.listOrders()).length).toBe(before.length + 2)
    })
    expect(screen.queryByText('2 drafts ready')).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
    await adapter.close()
  })

  it('persists unfinished paste text and drafts to owner-scoped recovery storage', async () => {
    resetLocalAdapterMemoryForTests()
    const adapter = await LocalAdapter.create()
    const user = userEvent.setup()
    withSessionToken('session-token-abc')
    render(<ImportWorkspace adapter={adapter} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Paste order JSON or JSON Lines' }), {
      target: { value: validLocalOrder },
    })
    await user.click(screen.getByRole('button', { name: 'Create drafts from JSON' }))
    expect(await screen.findByText('1 draft ready')).toBeInTheDocument()
    expect(screen.queryByText('Editable order draft')).not.toBeInTheDocument()
    await waitFor(() => {
      const stored = localStorage.getItem(getImportRecoveryStorageKey(DASHBOARD_AUTH_EMAIL))
      expect(stored).toBeTruthy()
      const parsed = JSON.parse(stored!) as { rawText: string; drafts: unknown[] }
      expect(parsed.rawText).toContain('Mika')
      expect(parsed.drafts).toHaveLength(1)
    })
    await adapter.close()
  })

  it('appends a second parse and flags a probable duplicate for review', async () => {
    resetLocalAdapterMemoryForTests()
    const adapter = await LocalAdapter.create()
    const user = userEvent.setup()
    withSessionToken('session-token-abc')
    render(<ImportWorkspace adapter={adapter} />)
    const input = screen.getByRole('textbox', { name: 'Paste order JSON or JSON Lines' })
    fireEvent.change(input, { target: { value: validLocalOrder } })
    await user.click(screen.getByRole('button', { name: 'Create drafts from JSON' }))
    expect(await screen.findByText('1 draft ready')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create drafts from JSON' }))
    expect(await screen.findByText('2 drafts ready')).toBeInTheDocument()
    expect(screen.getAllByText(/probable duplicate/i)).toHaveLength(2)
    expect(screen.queryByText('Editable order draft')).not.toBeInTheDocument()
    const editButtons = screen.getAllByRole('button', { name: 'Edit' })
    await user.click(editButtons[0])
    await user.click(editButtons[1])
    expect(screen.getAllByText('Editable order draft')).toHaveLength(2)
    await adapter.close()
  })

  it('hydrates recovered drafts as collapsed compact cards', async () => {
    resetLocalAdapterMemoryForTests()
    const adapter = await LocalAdapter.create()
    const user = userEvent.setup()
    withSessionToken('session-token-abc')
    const firstRender = render(<ImportWorkspace adapter={adapter} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Paste order JSON or JSON Lines' }), {
      target: { value: validLocalOrder },
    })
    await user.click(screen.getByRole('button', { name: 'Create drafts from JSON' }))
    expect(await screen.findByText('1 draft ready')).toBeInTheDocument()
    await waitFor(() => {
      expect(localStorage.getItem(getImportRecoveryStorageKey(DASHBOARD_AUTH_EMAIL))).toBeTruthy()
    })
    firstRender.unmount()

    render(<ImportWorkspace adapter={adapter} />)
    expect(await screen.findByText('1 draft ready')).toBeInTheDocument()
    expect(screen.queryByText('Editable order draft')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(await screen.findByText('Editable order draft')).toBeInTheDocument()
    await adapter.close()
  })

  it('clears mounted drafts when another tab removes recovery storage', async () => {
    resetLocalAdapterMemoryForTests()
    const adapter = await LocalAdapter.create()
    const user = userEvent.setup()
    withSessionToken('session-token-abc')
    render(<ImportWorkspace adapter={adapter} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Paste order JSON or JSON Lines' }), {
      target: { value: validLocalOrder },
    })
    await user.click(screen.getByRole('button', { name: 'Create drafts from JSON' }))
    expect(await screen.findByText('1 draft ready')).toBeInTheDocument()
    const key = getImportRecoveryStorageKey(DASHBOARD_AUTH_EMAIL)
    await waitFor(() => expect(localStorage.getItem(key)).toBeTruthy())
    localStorage.removeItem(key)
    fireEvent(window, new StorageEvent('storage', { key, newValue: null }))
    await waitFor(() => expect(screen.queryByText('1 draft ready')).not.toBeInTheDocument())
    await adapter.close()
  })

  it('clears React state and recovery storage on gelly-auth-signed-out', async () => {
    resetLocalAdapterMemoryForTests()
    const adapter = await LocalAdapter.create()
    const user = userEvent.setup()
    withSessionToken('session-token-abc')
    render(<ImportWorkspace adapter={adapter} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Paste order JSON or JSON Lines' }), {
      target: { value: validLocalOrder },
    })
    await user.click(screen.getByRole('button', { name: 'Create drafts from JSON' }))
    expect(await screen.findByText('1 draft ready')).toBeInTheDocument()
    const key = getImportRecoveryStorageKey(DASHBOARD_AUTH_EMAIL)
    await waitFor(() => expect(localStorage.getItem(key)).toBeTruthy())
    window.dispatchEvent(new CustomEvent(GELLY_AUTH_SIGNED_OUT_EVENT))
    await waitFor(() => {
      expect(screen.queryByText('1 draft ready')).not.toBeInTheDocument()
      expect(localStorage.getItem(key)).toBeNull()
    })
    await adapter.close()
  })
})
