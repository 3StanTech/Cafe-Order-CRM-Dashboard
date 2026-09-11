import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { formatPesos } from '../domain/money'
import type { PublicOrderFetch, PublicOrderMenu, PublicOrderProduct } from '../features/public-order/api'
import { PublicOrderPage } from './PublicOrderPage'

const REVISION_A = 'a'.repeat(64)
const REVISION_B = 'b'.repeat(64)
const ENDPOINT = '/public-order'

function matchaLatte(basePriceCentavos: number): PublicOrderProduct {
  return {
    slug: 'matcha-latte',
    name: 'Matcha Latte',
    family: 'matcha',
    flavor: 'plain',
    milk: 'oat_milk',
    basePriceCentavos,
    modifierGroups: ['matcha_level', 'powder', 'sweetness'],
    levelUpcharges: { 1: 0, 2: 2500, 3: 5000 },
    powderUpcharges: { yumeno: 0, mk_isuzu: 6000 },
    thermalBagPrices: { 1: 2500, 2: 3000, 3: 3500, 4: 3500 },
    sweetnessOptions: ['none', 'light', 'regular', 'extra'],
  }
}

function makeMenu(basePriceCentavos: number, quoteRevision: string, deliveryDate: string): PublicOrderMenu {
  return {
    business: { name: 'Made by Angela', description: 'Matcha cafe', contact: '09170000000' },
    payment: { method: 'GCash', account: '09171234567', instructions: 'Send GCash screenshot in Viber.' },
    delivery: { deliveryDate, deliveryWindowStart: '08:00', deliveryWindowEnd: '09:00' },
    quoteRevision,
    products: [matchaLatte(basePriceCentavos)],
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('PublicOrderPage', () => {
  it('replaces the full menu after a 409 instead of patching only the quote revision', async () => {
    const initial = makeMenu(20000, REVISION_A, '2026-09-15')
    const refreshed = makeMenu(25000, REVISION_B, '2026-09-16')
    let menuLoads = 0
    const fetcher = vi.fn<PublicOrderFetch>(async (input) => {
      const url = String(input)
      if (url.includes('action=menu')) {
        menuLoads += 1
        return jsonResponse(200, menuLoads === 1 ? initial : refreshed)
      }
      if (url.includes('action=submit')) {
        return jsonResponse(409, {
          code: 'RECONFIRM_REQUIRED',
          error: 'The quoted total changed. Review the updated total and confirm.',
          delivery: refreshed.delivery,
          quoteRevision: REVISION_B,
          quote: { itemsSubtotalCentavos: 25000, thermalBagsTotalCentavos: 0, totalCentavos: 25000 },
          items: [],
          thermalBags: [],
        })
      }
      throw new Error(`unexpected ${url}`)
    })

    render(<PublicOrderPage endpoint={ENDPOINT} fetcher={fetcher} storage={null} />)
    await screen.findByRole('combobox', { name: 'Drink 1' })
    expect(screen.getByRole('option', { name: `Matcha Latte · ${formatPesos(20000)}` })).toBeInTheDocument()

    const user = userEvent.setup()
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Ana')
    await user.type(screen.getByRole('textbox', { name: 'Viber number' }), '09171234567')
    await user.type(screen.getByRole('textbox', { name: 'Delivery address' }), 'Makati City')
    await user.click(screen.getByRole('button', { name: 'Review and submit order' }))

    await screen.findByRole('heading', { name: 'Review updated order details' })
    await waitFor(() => expect(screen.getByRole('option', { name: `Matcha Latte · ${formatPesos(25000)}` })).toBeInTheDocument())
    expect(screen.queryByRole('option', { name: `Matcha Latte · ${formatPesos(20000)}` })).not.toBeInTheDocument()
    expect(fetcher.mock.calls.filter(([request]) => String(request).includes('action=menu')).length).toBeGreaterThanOrEqual(2)
  })
})
