import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PendingInbox } from '../PendingInbox'
import { DASHBOARD_AUTH_EMAIL } from '../../auth/supabaseAuth'

const getSessionMock = vi.fn()
const getAuthClientMock = vi.fn()

vi.mock('../../auth/supabaseAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../auth/supabaseAuth')>()
  return {
    ...actual,
    getAuthClient: () => getAuthClientMock(),
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  getSessionMock.mockReset()
  getAuthClientMock.mockReset()
})

function withOwnerSession() {
  getSessionMock.mockResolvedValue({
    data: { session: { access_token: 'owner-token', user: { email: DASHBOARD_AUTH_EMAIL } } },
  })
  getAuthClientMock.mockReturnValue({ auth: { getSession: getSessionMock } })
}

const pendingRow = {
  id: '11111111-1111-4111-8111-111111111111',
  reference: 'CB-SYNTH01',
  idempotency_key: 'public-order-synthetic-key-01',
  request_hash: 'a'.repeat(64),
  quote_revision: 'b'.repeat(64),
  review_hash: 'c'.repeat(64),
  review_version: 0,
  status: 'pending',
  customer_name: 'Synth Mika',
  customer_phone: '09170000001',
  address_snapshot: 'Synthetic Makati',
  delivery_date: '2026-09-12',
  notes: null,
  items: [{ productSlug: 'matcha-latte', quantity: 1, modifiers: { level: 2, powder: 'yumeno' } }],
  thermal_bags: [],
  catalog_snapshot: {},
  priced_items: {},
  subtotal_centavos: 22500,
  delivery_fee_centavos: 0,
  total_centavos: 22500,
  submitted_snapshot: { quotedTotalCentavos: 20000 },
  accepted_order_id: null,
  created_at: '2026-09-11T00:00:00.000Z',
  updated_at: '2026-09-11T00:00:00.000Z',
}

describe('PendingInbox', () => {
  it('lists pending submissions and accepts selected with the current review hash', async () => {
    withOwnerSession()
    const user = userEvent.setup()
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('action=pending') && !url.includes('action=accept')) {
        return Promise.resolve(new Response(JSON.stringify({ submissions: [pendingRow] }), { status: 200 }))
      }
      if (url.includes('action=accept')) {
        return Promise.resolve(new Response(JSON.stringify({ status: 'accepted', reference: pendingRow.reference }), { status: 200 }))
      }
      return Promise.resolve(new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const onCountChange = vi.fn()
    render(<PendingInbox customers={[]} orders={[]} onCountChange={onCountChange} />)

    expect(await screen.findByText('Synth Mika')).toBeInTheDocument()
    expect(screen.getByText('1 pending')).toBeInTheDocument()
    expect(screen.getByText(/Viber 09170000001/)).toBeInTheDocument()
    expect(screen.getByText('Ref CB-SYNTH01')).toBeInTheDocument()
    expect(screen.getByText(/Total \+₱25\.00 vs submitted ₱200\.00/)).toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: 'Select Synth Mika' }))
    await user.click(screen.getByRole('button', { name: 'Accept selected (1)' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/.netlify/functions/order-submissions?action=accept&id=${pendingRow.id}`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer owner-token' }),
          body: JSON.stringify({ requestHash: pendingRow.review_hash }),
        }),
      )
    })
    await waitFor(() => expect(screen.queryByText('Synth Mika')).not.toBeInTheDocument())
  })

  it('keeps a failed reject in the list with a per-item error', async () => {
    withOwnerSession()
    const user = userEvent.setup()
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('action=pending')) {
        return Promise.resolve(new Response(JSON.stringify({ submissions: [pendingRow] }), { status: 200 }))
      }
      if (url.includes('action=reject')) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'This submission could not be rejected.' }), { status: 409 }))
      }
      return Promise.resolve(new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<PendingInbox customers={[]} orders={[]} />)
    expect(await screen.findByText('Synth Mika')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reject' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This submission could not be rejected.')
    expect(screen.getByText('Synth Mika')).toBeInTheDocument()
  })

  it('saves editor changes with the expected review version and hash', async () => {
    withOwnerSession()
    const user = userEvent.setup()
    const updated = {
      ...pendingRow,
      review_version: 1,
      review_hash: 'd'.repeat(64),
      address_snapshot: 'Synthetic BGC',
      total_centavos: 22500,
    }
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('action=pending')) {
        return Promise.resolve(new Response(JSON.stringify({ submissions: [pendingRow] }), { status: 200 }))
      }
      if (url.includes('action=update')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect(body.expectedReviewVersion).toBe(0)
        expect(body.expectedReviewHash).toBe(pendingRow.review_hash)
        expect(body.idempotencyKey).toBe(pendingRow.idempotency_key)
        return Promise.resolve(new Response(JSON.stringify({
          submission: updated,
          previousTotalCentavos: 22500,
          newTotalCentavos: 22500,
          differenceCentavos: 0,
        }), { status: 200 }))
      }
      return Promise.resolve(new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<PendingInbox customers={[]} orders={[]} />)
    expect(await screen.findByText('Synth Mika')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const address = await screen.findByRole('textbox', { name: 'Address' })
    await user.clear(address)
    await user.type(address, 'Synthetic BGC')
    await user.click(screen.getByRole('button', { name: 'Confirm order' }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/.netlify/functions/order-submissions?action=update&id=${pendingRow.id}`,
        expect.objectContaining({ method: 'POST' }),
      )
    })
  })

  it('shows copyable Viber replies with synthetic fields', async () => {
    withOwnerSession()
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ submissions: [pendingRow] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<PendingInbox customers={[]} orders={[]} />)
    const acceptReply = await screen.findByLabelText('Viber accept reply for Synth Mika')
    const rejectReply = screen.getByLabelText('Viber reject reply for Synth Mika')
    expect(acceptReply).toHaveValue('Hi Synth Mika!\nOrder CB-SYNTH01 is accepted for 2026-09-12.\n1× Matcha Latte L2\nTotal: ₱225.00.\nPlease send your GCash screenshot in Viber.')
    expect(rejectReply).toHaveValue('Hi Synth Mika,\nWe need to decline order CB-SYNTH01.\nPlease message us in Viber so we can sort it out.')
  })

  it('keeps the frozen editor CAS token after a focus refresh and conflicts instead of overwriting', async () => {
    withOwnerSession()
    const user = userEvent.setup()
    const remote = {
      ...pendingRow,
      review_version: 4,
      review_hash: 'e'.repeat(64),
      quote_revision: 'f'.repeat(64),
      address_snapshot: 'Remote Pasig',
    }
    let submissions = [pendingRow]
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      if (url.includes('action=pending')) {
        return Promise.resolve(new Response(JSON.stringify({ submissions }), { status: 200 }))
      }
      if (url.includes('action=update')) {
        return Promise.resolve(new Response(JSON.stringify({
          code: 'REVIEW_STALE',
          error: 'This submission changed on another device. Refresh it before saving.',
          reviewVersion: remote.review_version,
          reviewHash: remote.review_hash,
        }), { status: 409 }))
      }
      return Promise.resolve(new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<PendingInbox customers={[]} orders={[]} />)
    expect(await screen.findByText('Synth Mika')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const address = await screen.findByRole('textbox', { name: 'Address' })
    await user.clear(address)
    await user.type(address, 'Synthetic BGC')

    submissions = [remote]
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(await screen.findByText('Remote Pasig')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Address' })).toHaveValue('Synthetic BGC')

    await user.click(screen.getByRole('button', { name: 'Confirm order' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This submission changed on another device. Refresh it before saving.')

    const updateCalls = fetchMock.mock.calls.filter(([request]) => String(request).includes('action=update'))
    expect(updateCalls).toHaveLength(1)
    const body = JSON.parse(String(updateCalls[0]?.[1]?.body)) as Record<string, unknown>
    expect(body.expectedReviewVersion).toBe(pendingRow.review_version)
    expect(body.expectedReviewHash).toBe(pendingRow.review_hash)
    expect(body.expectedReviewHash).not.toBe(remote.review_hash)
    expect(body.address).toBe('Synthetic BGC')
    expect(body.quoteRevision).toBe(pendingRow.quote_revision)
  })

  it('blocks accept while the editor draft is dirty and accepts with the saved review hash after save', async () => {
    withOwnerSession()
    const user = userEvent.setup()
    const updated = {
      ...pendingRow,
      review_version: 1,
      review_hash: 'd'.repeat(64),
      address_snapshot: 'Synthetic BGC',
    }
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      if (url.includes('action=pending')) {
        return Promise.resolve(new Response(JSON.stringify({ submissions: [pendingRow] }), { status: 200 }))
      }
      if (url.includes('action=update')) {
        return Promise.resolve(new Response(JSON.stringify({
          submission: updated,
          previousTotalCentavos: 22500,
          newTotalCentavos: 22500,
          differenceCentavos: 0,
        }), { status: 200 }))
      }
      if (url.includes('action=accept')) {
        return Promise.resolve(new Response(JSON.stringify({ status: 'accepted', reference: pendingRow.reference }), { status: 200 }))
      }
      return Promise.resolve(new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<PendingInbox customers={[]} orders={[]} />)
    expect(await screen.findByText('Synth Mika')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const address = await screen.findByRole('textbox', { name: 'Address' })
    await user.clear(address)
    await user.type(address, 'Synthetic BGC')
    await user.click(screen.getByRole('checkbox', { name: 'Select Synth Mika' }))
    await user.click(screen.getByRole('button', { name: 'Accept selected (1)' }))

    expect(screen.getByRole('status')).toHaveTextContent('Save or discard unsaved editor changes before accepting.')
    expect(screen.getByRole('alert')).toHaveTextContent('Save or discard them before accepting.')
    expect(fetchMock.mock.calls.filter(([request]) => String(request).includes('action=accept'))).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Confirm order' }))
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([request]) => String(request).includes('action=update'))).toBe(true)
    })
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Address' })).toHaveValue('Synthetic BGC'))

    await user.click(screen.getByRole('button', { name: 'Accept selected (1)' }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/.netlify/functions/order-submissions?action=accept&id=${pendingRow.id}`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ requestHash: updated.review_hash }),
        }),
      )
    })
    await waitFor(() => expect(screen.queryByText('Synth Mika')).not.toBeInTheDocument())
  })

  it('blocks accept when the open editor is missing required fields', async () => {
    withOwnerSession()
    const user = userEvent.setup()
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('action=pending')) {
        return Promise.resolve(new Response(JSON.stringify({ submissions: [pendingRow] }), { status: 200 }))
      }
      if (url.includes('action=accept')) {
        return Promise.resolve(new Response(JSON.stringify({ status: 'accepted', reference: pendingRow.reference }), { status: 200 }))
      }
      return Promise.resolve(new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<PendingInbox customers={[]} orders={[]} />)
    expect(await screen.findByText('Synth Mika')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const name = await screen.findByRole('textbox', { name: 'Customer name' })
    await user.clear(name)
    await user.click(screen.getByRole('checkbox', { name: 'Select Synth Mika' }))
    await user.click(screen.getByRole('button', { name: 'Accept selected (1)' }))

    expect(screen.getByRole('status')).toHaveTextContent('Save or discard unsaved editor changes before accepting.')
    expect(fetchMock.mock.calls.filter(([request]) => String(request).includes('action=accept'))).toHaveLength(0)
  })

  it('reviews an updated quote and resubmits with the new revision after acknowledgement', async () => {
    withOwnerSession()
    const user = userEvent.setup()
    const newRevision = 'e'.repeat(64)
    const updated = {
      ...pendingRow,
      review_version: 1,
      review_hash: 'd'.repeat(64),
      address_snapshot: 'Synthetic BGC',
      quote_revision: newRevision,
      total_centavos: 25000,
    }
    let updates = 0
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('action=pending')) {
        return Promise.resolve(new Response(JSON.stringify({ submissions: [pendingRow] }), { status: 200 }))
      }
      if (url.includes('action=update')) {
        updates += 1
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        if (updates === 1) {
          expect(body.quoteRevision).toBe(pendingRow.quote_revision)
          expect(body.quotedTotalCentavos).toBe(22500)
          expect(body.deliveryDate).toBe(pendingRow.delivery_date)
          expect(body.expectedReviewVersion).toBe(0)
          return Promise.resolve(new Response(JSON.stringify({
            code: 'RECONFIRM_REQUIRED',
            error: 'The edited delivery date or total changed. Review the updated quote.',
            delivery: { deliveryDate: '2026-09-13', deliveryWindowStart: '08:00', deliveryWindowEnd: '09:00' },
            quoteRevision: newRevision,
            quote: { itemsSubtotalCentavos: 25000, thermalBagsTotalCentavos: 0, totalCentavos: 25000 },
            items: [],
            thermalBags: [],
          }), { status: 409 }))
        }
        expect(body.quoteRevision).toBe(newRevision)
        expect(body.quotedTotalCentavos).toBe(25000)
        expect(body.deliveryDate).toBe(pendingRow.delivery_date)
        expect(body.expectedReviewVersion).toBe(0)
        expect(body.expectedReviewHash).toBe(pendingRow.review_hash)
        return Promise.resolve(new Response(JSON.stringify({
          submission: updated,
          previousTotalCentavos: 22500,
          newTotalCentavos: 25000,
          differenceCentavos: 2500,
        }), { status: 200 }))
      }
      return Promise.resolve(new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<PendingInbox customers={[]} orders={[]} />)
    expect(await screen.findByText('Synth Mika')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const address = await screen.findByRole('textbox', { name: 'Address' })
    await user.clear(address)
    await user.type(address, 'Synthetic BGC')
    await user.click(screen.getByRole('button', { name: 'Confirm order' }))

    expect(await screen.findByRole('heading', { name: 'Review updated quote' })).toBeInTheDocument()
    expect(screen.getByText(/New delivery date 2026-09-13 · New total ₱250\.00/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Confirm updated quote' }))

    await waitFor(() => expect(updates).toBe(2))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Review updated quote' })).not.toBeInTheDocument())
  })
})
