import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalAdapter, resetLocalAdapterMemoryForTests } from '../../../data/local-adapter'
import { ImportWorkspace } from '../ImportWorkspace'
import { duplicatePastedJsonLines, unsafeText } from '../../../../test/fixtures/import/hostile/hostile-import-fixtures'

const getSessionMock = vi.fn()
const getAuthClientMock = vi.fn()

vi.mock('../../auth/supabaseAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../auth/supabaseAuth')>()
  return {
    ...actual,
    getAuthClient: () => getAuthClientMock(),
  }
})

async function renderWorkspace() {
  resetLocalAdapterMemoryForTests()
  getSessionMock.mockResolvedValue({ data: { session: { access_token: 'test-session-token' } } })
  getAuthClientMock.mockReturnValue({ auth: { getSession: getSessionMock } })
  const adapter = await LocalAdapter.create()
  render(<ImportWorkspace adapter={adapter} />)
  return adapter
}

async function pasteAndParse(user: ReturnType<typeof userEvent.setup>, value: string) {
  const input = screen.getByRole('textbox', { name: 'Paste order JSON or JSON Lines' })
  await act(async () => {
    fireEvent.change(input, { target: { value } })
  })
  await user.click(screen.getByRole('button', { name: 'Create drafts from JSON' }))
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Create drafts from JSON' })).toBeEnabled()
  })
}

async function expandFirstDraft(user: ReturnType<typeof userEvent.setup>) {
  const editButtons = screen.getAllByRole('button', { name: 'Edit' })
  await user.click(editButtons[0])
  expect(await screen.findByText('Editable order draft')).toBeInTheDocument()
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  getSessionMock.mockReset()
  getAuthClientMock.mockReset()
  localStorage.clear()
})

describe('T6 hostile import transport, rendering, and confirmation audit', () => {
  it('blocks free-text Viber extraction without making a network request', async () => {
    const adapter = await renderWorkspace()
    const user = userEvent.setup()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await pasteAndParse(user, 'Mika: one matcha latte, Makati')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(await screen.findByRole('status')).toHaveTextContent(/Viber text extraction is unavailable.*Paste order JSON or JSON Lines/i)
    expect(screen.queryByText(/drafts? ready/)).not.toBeInTheDocument()
    await adapter.close()
  })

  it('proves local JSON imports make zero network calls in the rendered client', async () => {
    const adapter = await renderWorkspace()
    const user = userEvent.setup()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await pasteAndParse(user, '{"customer_name":"Local Lia","items":[{"product_slug":"matcha-latte","quantity":1}],"address":"Makati"}')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(await screen.findByText('Parsed locally — no network request was made.')).toBeInTheDocument()
    await adapter.close()
  })

  it('renders untrusted structural name, address, and notes as text rather than executable HTML', async () => {
    const adapter = await renderWorkspace()
    const user = userEvent.setup()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await pasteAndParse(user, JSON.stringify({
      customer_name: unsafeText,
      items: [{ product_slug: 'matcha-latte', quantity: 1 }],
      address: unsafeText,
      notes: unsafeText,
    }))
    await expandFirstDraft(user)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(await screen.findByRole('textbox', { name: 'Customer name' })).toHaveValue(unsafeText)
    expect(screen.getByRole('textbox', { name: 'Address' })).toHaveValue(unsafeText)
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveValue(unsafeText)
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
    expect((globalThis as typeof globalThis & { __hostileXss?: unknown }).__hostileXss).toBeUndefined()
    await adapter.close()
  })

  it('flags a missing address visibly in the editable card', async () => {
    const adapter = await renderWorkspace()
    const user = userEvent.setup()
    await pasteAndParse(user, '{"customer_name":"No Address","items":[{"product_slug":"matcha-latte","quantity":1}]}')
    expect(await screen.findByText('Delivery address is missing — review before confirming')).toBeInTheDocument()
    expect(screen.queryByText('Editable order draft')).not.toBeInTheDocument()
    await expandFirstDraft(user)
    expect(screen.getByText('Editable order draft')).toBeInTheDocument()
    expect(screen.getAllByText('Delivery address is missing — review before confirming').length).toBeGreaterThanOrEqual(2)
    await adapter.close()
  })

  it('does not create duplicate orders when the same confirmation control receives two rapid clicks', async () => {
    const adapter = await renderWorkspace()
    const user = userEvent.setup()
    const before = await adapter.listOrders()
    await pasteAndParse(user, '{"customer_name":"Double Dana","items":[{"product_slug":"matcha-latte","quantity":1}],"address":"Makati"}')
    await expandFirstDraft(user)
    const confirm = await screen.findByRole('button', { name: 'Confirm order' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(await screen.findByRole('status')).toHaveTextContent(/was created as new/)
    expect((await adapter.listOrders()).length).toBe(before.length + 1)
    await adapter.close()
  })

  it('does not turn duplicate pasted JSON Lines into two independently confirmable orders', async () => {
    const adapter = await renderWorkspace()
    const user = userEvent.setup()
    const before = await adapter.listOrders()
    await pasteAndParse(user, duplicatePastedJsonLines)

    expect(await screen.findByText('1 draft ready')).toBeInTheDocument()
    await expandFirstDraft(user)
    await user.click(screen.getByRole('button', { name: 'Confirm order' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/was created as new/)
    expect((await adapter.listOrders()).length).toBe(before.length + 1)
    await adapter.close()
  })
})
