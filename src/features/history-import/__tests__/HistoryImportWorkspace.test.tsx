import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalAdapter, resetLocalAdapterMemoryForTests } from '../../../data/local-adapter'
import type { StorageAdapter } from '../../../data/types'
import { getImportRecoveryStorageKey, HISTORY_IMPORT_RECOVERY_STORAGE_PREFIX } from '../../import/draft-recovery'
import { HistoryImportWorkspace } from '../HistoryImportWorkspace'
import { unsafeText } from '../../../../test/fixtures/import/hostile/hostile-import-fixtures'

vi.mock('../../auth/supabaseAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../auth/supabaseAuth')>()
  return { ...actual, getAuthClient: () => null }
})

function historyLine(sourceRef: string, customerName: string, deliveryDate = '2026-03-01'): string {
  return JSON.stringify({
    source_ref: sourceRef,
    customer_name: customerName,
    delivery_date: deliveryDate,
    items: [{ product_slug: 'matcha-latte', quantity: 1, level: 1, powder: 'yumeno', price: 1 }],
    address: 'Makati',
  })
}

const THREE_LINES = [
  historyLine('ref-ana', 'History Ana'),
  historyLine('ref-bea', 'History Bea'),
  historyLine('ref-cara', 'History Cara', '2999-01-01'),
].join('\n')

async function createAdapter() {
  resetLocalAdapterMemoryForTests()
  return LocalAdapter.create()
}

function renderWorkspace(adapter: StorageAdapter) {
  return render(<MemoryRouter><HistoryImportWorkspace adapter={adapter} /></MemoryRouter>)
}

async function pasteAndPreview(text: string) {
  await waitFor(() => expect(screen.getByText('Preview orders')).toBeEnabled())
  fireEvent.change(screen.getByLabelText('Paste JSON Lines'), { target: { value: text } })
  fireEvent.click(screen.getByText('Preview orders'))
}

function historyOrders(orders: Awaited<ReturnType<StorageAdapter['listOrders']>>) {
  return orders.filter((order) => order.rawSource.startsWith('history-import:'))
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('HistoryImportWorkspace', () => {
  it('previews locally, honours a deselected row, and imports only the selected past orders', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const adapter = await createAdapter()
    const user = userEvent.setup()
    renderWorkspace(adapter)

    await pasteAndPreview(THREE_LINES)
    expect(await screen.findByText('3 orders found · 2 ready')).toBeInTheDocument()
    expect(screen.getByText(/in the future/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Include line 3, History Cara' })).toBeDisabled()

    await user.click(screen.getByRole('checkbox', { name: 'Include line 2, History Bea' }))
    await user.click(screen.getByRole('button', { name: 'Import 1 order' }))

    expect(await screen.findByText('Imported 1 order.')).toBeInTheDocument()
    const imported = historyOrders(await adapter.listOrders())
    expect(imported.map((order) => order.rawSource)).toEqual(['history-import:ref-ana'])
    expect(imported[0].status).toBe('delivered')
    expect(fetchMock).not.toHaveBeenCalled()
    await adapter.close()
  })

  it('reads a chosen file on the device', async () => {
    const adapter = await createAdapter()
    const user = userEvent.setup()
    renderWorkspace(adapter)
    const input = screen.getByLabelText('Choose a JSON Lines file')
    await waitFor(() => expect(input).toBeEnabled())

    await user.upload(input, new File([THREE_LINES], 'history.jsonl', { type: 'application/x-ndjson' }))

    expect(await screen.findByText('3 orders found · 2 ready')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import 2 orders' })).toBeEnabled()
    await adapter.close()
  })

  it('does not create duplicate orders when Import receives two rapid clicks', async () => {
    const adapter = await createAdapter()
    renderWorkspace(adapter)
    await pasteAndPreview(THREE_LINES)
    const button = await screen.findByRole('button', { name: 'Import 2 orders' })

    fireEvent.click(button)
    fireEvent.click(button)

    expect(await screen.findByText('Imported 2 orders.')).toBeInTheDocument()
    expect(historyOrders(await adapter.listOrders())).toHaveLength(2)
    await adapter.close()
  })

  it('stops on the first error and resumes without duplicating the stopped order', async () => {
    const adapter = await createAdapter()
    const user = userEvent.setup()
    const original = adapter.updateOrder.bind(adapter)
    let calls = 0
    vi.spyOn(adapter, 'updateOrder').mockImplementation(async (id, patch) => {
      calls += 1
      if (calls === 1) throw new Error('Connection dropped.')
      return original(id, patch)
    })
    renderWorkspace(adapter)
    await pasteAndPreview(THREE_LINES)
    await user.click(await screen.findByRole('button', { name: 'Import 2 orders' }))

    expect(await screen.findByText(/Stopped at line 1: Connection dropped\./)).toBeInTheDocument()
    expect(historyOrders(await adapter.listOrders())).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Resume import (2 left)' }))

    expect(await screen.findByText('Imported 2 orders.')).toBeInTheDocument()
    const imported = historyOrders(await adapter.listOrders())
    expect(imported).toHaveLength(2)
    expect(imported.every((order) => order.status === 'delivered')).toBe(true)
    await adapter.close()
  })

  it('recovers an interrupted import after a reload under its own storage key', async () => {
    const adapter = await createAdapter()
    const user = userEvent.setup()
    const original = adapter.updateOrder.bind(adapter)
    let calls = 0
    const spy = vi.spyOn(adapter, 'updateOrder').mockImplementation(async (id, patch) => {
      calls += 1
      if (calls === 1) throw new Error('Connection dropped.')
      return original(id, patch)
    })
    const first = renderWorkspace(adapter)
    await pasteAndPreview(THREE_LINES)
    await user.click(await screen.findByRole('button', { name: 'Import 2 orders' }))
    expect(await screen.findByText(/Stopped at line 1/)).toBeInTheDocument()
    expect(localStorage.getItem(getImportRecoveryStorageKey('demo-owner', HISTORY_IMPORT_RECOVERY_STORAGE_PREFIX))).toMatch(/"confirmationKey":"history-/)
    expect(localStorage.getItem(getImportRecoveryStorageKey('demo-owner'))).toBeNull()
    first.unmount()
    spy.mockRestore()

    renderWorkspace(adapter)
    expect(await screen.findByText(/An earlier import was interrupted/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Resume import (2 left)' }))

    expect(await screen.findByText('Imported 2 orders.')).toBeInTheDocument()
    expect(historyOrders(await adapter.listOrders())).toHaveLength(2)
    expect(localStorage.getItem(getImportRecoveryStorageKey('demo-owner', HISTORY_IMPORT_RECOVERY_STORAGE_PREFIX))).toBeNull()
    await adapter.close()
  })

  it('flags rows that were already imported when the same file is previewed again', async () => {
    const adapter = await createAdapter()
    const user = userEvent.setup()
    renderWorkspace(adapter)
    await pasteAndPreview(THREE_LINES)
    await user.click(await screen.findByRole('button', { name: 'Import 2 orders' }))
    expect(await screen.findByText('Imported 2 orders.')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Preview orders'))

    expect(await screen.findByText('3 orders found · 0 ready')).toBeInTheDocument()
    expect(screen.getAllByText('Already imported')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Import 0 orders' })).toBeDisabled()
    await adapter.close()
  })

  it('reports a repeated source_ref on screen instead of dropping it', async () => {
    const adapter = await createAdapter()
    renderWorkspace(adapter)
    await pasteAndPreview([historyLine('same', 'History Ana'), historyLine('same', 'History Bea')].join('\n'))

    expect(await screen.findByText('2 orders found · 1 ready')).toBeInTheDocument()
    expect(screen.getByText('Repeats the source_ref on line 1 — skipped')).toBeInTheDocument()
    await adapter.close()
  })

  it('renders untrusted names and notes as text rather than markup', async () => {
    const adapter = await createAdapter()
    renderWorkspace(adapter)
    await pasteAndPreview(JSON.stringify({
      source_ref: 'hostile',
      customer_name: unsafeText,
      delivery_date: '2026-03-01',
      items: [{ product_slug: 'matcha-latte', quantity: 1 }],
      notes: unsafeText,
    }))

    const list = await screen.findByText('1 order found · 1 ready')
    expect(within(list.closest('div')!).getByText(unsafeText)).toBeInTheDocument()
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
    expect((globalThis as typeof globalThis & { __hostileXss?: unknown }).__hostileXss).toBeUndefined()
    await adapter.close()
  })
})
