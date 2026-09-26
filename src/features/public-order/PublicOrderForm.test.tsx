import { useState } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatPesos } from '../../domain/money'
import {
  type PublicOrderFetch,
  type PublicOrderInput,
  type PublicOrderMenu,
  type PublicOrderProduct,
} from './api'
import { PUBLIC_ORDER_ATTEMPT_STORAGE_KEY, restoredDeliveryDate, type PublicOrderAttempt } from './attempt-recovery'
import { PublicOrderForm } from './PublicOrderForm'

const REVISION_A = 'a'.repeat(64)
const REVISION_B = 'b'.repeat(64)
const ENDPOINT = '/public-order'

function matchaLatte(overrides: Partial<PublicOrderProduct> = {}): PublicOrderProduct {
  return {
    slug: 'matcha-latte',
    name: 'Matcha Latte',
    family: 'matcha',
    flavor: 'plain',
    milk: 'oat_milk',
    basePriceCentavos: 20000,
    modifierGroups: ['matcha_level', 'powder', 'sweetness'],
    levelUpcharges: { 1: 0, 2: 2500, 3: 5000 },
    powderUpcharges: { yumeno: 0, mk_isuzu: 6000 },
    thermalBagPrices: { 1: 2500, 2: 3000, 3: 3500, 4: 3500 },
    sweetnessOptions: ['none', 'light', 'regular', 'extra'],
    ...overrides,
  }
}

function makeMenu(overrides: Partial<PublicOrderMenu> = {}): PublicOrderMenu {
  return {
    business: { name: 'Made by Angela', description: 'Matcha cafe', contact: '09170000000' },
    payment: { method: 'GCash', account: '09171234567', instructions: 'Send GCash screenshot in Viber.' },
    delivery: { deliveryDate: '2026-09-15', deliveryWindowStart: '08:00', deliveryWindowEnd: '09:00' },
    quoteRevision: REVISION_A,
    products: [matchaLatte()],
    ...overrides,
  }
}

function day(deliveryDate: string) {
  return { deliveryDate, deliveryWindowStart: '08:00', deliveryWindowEnd: '09:00' }
}

function menuWithDays(dates: string[], overrides: Partial<PublicOrderMenu> = {}): PublicOrderMenu {
  return makeMenu({ delivery: day(dates[0]), deliveryOptions: dates.map(day), ...overrides })
}

function longDate(value: string): string {
  return new Intl.DateTimeFormat('en-PH', { dateStyle: 'full', timeZone: 'Asia/Manila' }).format(new Date(`${value}T00:00:00.000Z`))
}

function headingDate(): string | null | undefined {
  return document.querySelector('#public-order-heading time')?.getAttribute('datetime')
}

function radioFor(date: string): HTMLInputElement {
  return screen.getAllByRole('radio').find((radio) => (radio as HTMLInputElement).value === date) as HTMLInputElement
}

function receiptFor(deliveryDate: string, totalCentavos = 20000) {
  return { submitted: true, status: 'pending', reference: 'MBA-2001', deliveryDate, totalCentavos, pendingAngelaAcceptance: true }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function parseSubmit(init?: RequestInit): PublicOrderInput {
  return JSON.parse(String(init?.body)) as PublicOrderInput
}

function isMenuRequest(input: RequestInfo | URL): boolean {
  return String(input).includes('action=menu')
}

function isSubmitRequest(input: RequestInfo | URL): boolean {
  return String(input).includes('action=submit')
}

function StatefulForm({
  initialMenu,
  fetcher,
}: {
  initialMenu: PublicOrderMenu
  fetcher: PublicOrderFetch
}) {
  const [menu, setMenu] = useState(initialMenu)
  return <PublicOrderForm menu={menu} endpoint={ENDPOINT} fetcher={fetcher} storage={null} onMenuRevisionChange={setMenu} />
}

async function fillRequiredDetails() {
  const user = userEvent.setup()
  await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Ana')
  await user.type(screen.getByRole('textbox', { name: 'Viber number' }), '09171234567')
  await user.type(screen.getByRole('textbox', { name: 'Delivery address' }), 'Makati City')
  return user
}

afterEach(() => {
  sessionStorage.clear()
  localStorage.clear()
})

describe('PublicOrderForm', () => {
  it('defaults the remember-details checkbox to unchecked', () => {
    render(<PublicOrderForm menu={makeMenu()} endpoint={ENDPOINT} fetcher={vi.fn()} storage={null} onMenuRevisionChange={vi.fn()} />)
    expect(screen.getByRole('checkbox', { name: 'Remember my details on this device' })).not.toBeChecked()
  })

  it('includes an empty off-screen honeypot on submit', async () => {
    const fetcher = vi.fn<PublicOrderFetch>(async (input, init) => {
      if (isSubmitRequest(input)) {
        const body = parseSubmit(init)
        expect(body.honeypot).toBe('')
        return jsonResponse(200, {
          submitted: true,
          status: 'pending',
          reference: 'MBA-1001',
          deliveryDate: '2026-09-15',
          totalCentavos: 20000,
          pendingAngelaAcceptance: true,
        })
      }
      throw new Error(`unexpected ${String(input)}`)
    })
    render(<PublicOrderForm menu={makeMenu()} endpoint={ENDPOINT} fetcher={fetcher} storage={null} onMenuRevisionChange={vi.fn()} />)
    const honeypot = document.querySelector('input[name="company_website"]')
    expect(honeypot).toBeInstanceOf(HTMLInputElement)
    expect(honeypot).toHaveValue('')
    expect(honeypot).toHaveAttribute('autocomplete', 'off')
    expect(honeypot).toHaveAttribute('tabindex', '-1')
    const user = await fillRequiredDetails()
    await user.click(screen.getByRole('button', { name: 'Review and submit order' }))
    await screen.findByRole('heading', { name: 'Order submitted' })
    expect(fetcher).toHaveBeenCalled()
  })

  it('shows product names and a single total on the receipt, without invented line pesos', async () => {
    const fetcher = vi.fn<PublicOrderFetch>(async (input) => {
      if (isSubmitRequest(input)) {
        return jsonResponse(200, {
          submitted: true,
          status: 'pending',
          reference: 'MBA-1002',
          deliveryDate: '2026-09-15',
          totalCentavos: 40000,
          pendingAngelaAcceptance: true,
        })
      }
      throw new Error(`unexpected ${String(input)}`)
    })
    render(<PublicOrderForm menu={makeMenu()} endpoint={ENDPOINT} fetcher={fetcher} storage={null} onMenuRevisionChange={vi.fn()} />)
    const user = await fillRequiredDetails()
    await user.click(screen.getByRole('button', { name: 'Add another drink' }))
    await user.click(screen.getByRole('button', { name: 'Review and submit order' }))
    const receipt = await screen.findByRole('heading', { name: 'Order submitted' }).then(() => document.querySelector('.public-order-receipt'))
    expect(receipt).toBeTruthy()
    const view = within(receipt as HTMLElement)
    expect(view.getAllByText('1× Matcha Latte · L1')).toHaveLength(2)
    expect(view.queryByText('matcha-latte')).not.toBeInTheDocument()
    expect(view.queryByText(formatPesos(20000))).not.toBeInTheDocument()
    expect(view.getByText(formatPesos(40000))).toBeInTheDocument()
    expect(view.getAllByText(formatPesos(40000))).toHaveLength(1)
    expect(view.getByText('Pending Angela’s acceptance')).toBeInTheDocument()
    expect(view.getByRole('heading', { name: 'Pay through GCash' })).toBeInTheDocument()
    expect(view.getByText('Send your screenshot in Viber. Payment is not verified here.')).toBeInTheDocument()
  })

  it('copies a Viber message that uses product names instead of slugs', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const fetcher = vi.fn<PublicOrderFetch>(async (input) => {
      if (isSubmitRequest(input)) {
        return jsonResponse(200, {
          submitted: true,
          status: 'pending',
          reference: 'MBA-1003',
          deliveryDate: '2026-09-15',
          totalCentavos: 20000,
          pendingAngelaAcceptance: true,
        })
      }
      throw new Error(`unexpected ${String(input)}`)
    })
    render(<PublicOrderForm menu={makeMenu()} endpoint={ENDPOINT} fetcher={fetcher} storage={null} onMenuRevisionChange={vi.fn()} />)
    const user = await fillRequiredDetails()
    await user.click(screen.getByRole('button', { name: 'Review and submit order' }))
    await screen.findByRole('heading', { name: 'Order submitted' })
    const writeSpy = vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText)
    await user.click(screen.getByRole('button', { name: 'Copy Viber message' }))
    await waitFor(() => expect(writeSpy).toHaveBeenCalled())
    const message = writeText.mock.calls[0][0] as string
    expect(message).toContain('Matcha Latte')
    expect(message).not.toContain('matcha-latte')
  })

  it('reloads the full menu after a 409 reconfirm and updates product prices', async () => {
    const refreshed = makeMenu({
      quoteRevision: REVISION_B,
      delivery: { deliveryDate: '2026-09-16', deliveryWindowStart: '08:00', deliveryWindowEnd: '09:00' },
      products: [matchaLatte({ basePriceCentavos: 25000 })],
    })
    const fetcher = vi.fn<PublicOrderFetch>(async (input) => {
      if (isSubmitRequest(input)) {
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
      if (isMenuRequest(input)) return jsonResponse(200, refreshed)
      throw new Error(`unexpected ${String(input)}`)
    })
    render(<StatefulForm initialMenu={makeMenu()} fetcher={fetcher} />)
    expect(screen.getByRole('option', { name: `Matcha Latte · ${formatPesos(20000)}` })).toBeInTheDocument()
    const user = await fillRequiredDetails()
    await user.click(screen.getByRole('button', { name: 'Review and submit order' }))
    await screen.findByRole('heading', { name: 'Review updated order details' })
    await waitFor(() => expect(screen.getByRole('option', { name: `Matcha Latte · ${formatPesos(25000)}` })).toBeInTheDocument())
    expect(fetcher.mock.calls.some(([request]) => isMenuRequest(request))).toBe(true)
  })

  it('reuses the same idempotency key when a failed fetch is retried', async () => {
    let submits = 0
    const fetcher = vi.fn<PublicOrderFetch>(async (input) => {
      if (!isSubmitRequest(input)) throw new Error(`unexpected ${String(input)}`)
      submits += 1
      if (submits === 1) {
        throw new TypeError('Failed to fetch')
      }
      return jsonResponse(200, {
        submitted: true,
        status: 'pending',
        reference: 'MBA-1004',
        deliveryDate: '2026-09-15',
        totalCentavos: 20000,
        pendingAngelaAcceptance: true,
      })
    })
    render(<PublicOrderForm menu={makeMenu()} endpoint={ENDPOINT} fetcher={fetcher} storage={null} onMenuRevisionChange={vi.fn()} />)
    const user = await fillRequiredDetails()
    await user.click(screen.getByRole('button', { name: 'Review and submit order' }))
    await screen.findByRole('alert')
    await user.click(screen.getByRole('button', { name: 'Review and submit order' }))
    await screen.findByRole('heading', { name: 'Order submitted' })
    const posted = fetcher.mock.calls.filter(([request]) => isSubmitRequest(request))
    expect(posted).toHaveLength(2)
    expect(parseSubmit(posted[0][1]).idempotencyKey).toBe(parseSubmit(posted[1][1]).idempotencyKey)
    expect(parseSubmit(posted[0][1])).toEqual(parseSubmit(posted[1][1]))
  })

  it('does not change the idempotency key when fields are edited after a failed attempt', async () => {
    let submits = 0
    const fetcher = vi.fn<PublicOrderFetch>(async (input) => {
      if (!isSubmitRequest(input)) throw new Error(`unexpected ${String(input)}`)
      submits += 1
      if (submits === 1) {
        throw new TypeError('Failed to fetch')
      }
      return jsonResponse(200, {
        submitted: true,
        status: 'pending',
        reference: 'MBA-1005',
        deliveryDate: '2026-09-15',
        totalCentavos: 20000,
        pendingAngelaAcceptance: true,
      })
    })
    render(<PublicOrderForm menu={makeMenu()} endpoint={ENDPOINT} fetcher={fetcher} storage={null} onMenuRevisionChange={vi.fn()} />)
    const user = await fillRequiredDetails()
    await user.click(screen.getByRole('button', { name: 'Review and submit order' }))
    await screen.findByText('Retry the same submission without changing your order.', { exact: false })
    await user.type(screen.getByRole('textbox', { name: 'Name' }), ' Reyes')
    await user.click(screen.getByRole('button', { name: 'Review and submit order' }))
    await screen.findByRole('heading', { name: 'Order submitted' })
    const posted = fetcher.mock.calls.filter(([request]) => isSubmitRequest(request))
    expect(posted).toHaveLength(2)
    expect(parseSubmit(posted[0][1]).idempotencyKey).toBe(parseSubmit(posted[1][1]).idempotencyKey)
    expect(parseSubmit(posted[1][1]).customerName).toBe('Ana')
  })

  it('reuses the same idempotency key after unmount and remount following a failed submit', async () => {
    let submits = 0
    const fetcher = vi.fn<PublicOrderFetch>(async (input) => {
      if (!isSubmitRequest(input)) throw new Error(`unexpected ${String(input)}`)
      submits += 1
      if (submits === 1) throw new TypeError('Failed to fetch')
      return jsonResponse(200, {
        submitted: true,
        status: 'pending',
        reference: 'MBA-1006',
        deliveryDate: '2026-09-15',
        totalCentavos: 20000,
        pendingAngelaAcceptance: true,
      })
    })
    const { unmount } = render(<PublicOrderForm menu={makeMenu()} endpoint={ENDPOINT} fetcher={fetcher} storage={null} onMenuRevisionChange={vi.fn()} />)
    const user = await fillRequiredDetails()
    await user.click(screen.getByRole('button', { name: 'Review and submit order' }))
    await screen.findByText('Retry the same submission without changing your order.', { exact: false })
    expect(sessionStorage.getItem(PUBLIC_ORDER_ATTEMPT_STORAGE_KEY)).toBeTruthy()
    unmount()

    render(<PublicOrderForm menu={makeMenu()} endpoint={ENDPOINT} fetcher={fetcher} storage={null} onMenuRevisionChange={vi.fn()} />)
    expect(screen.getByText('previous submission may have succeeded', { exact: false })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Drink 1' })).toBeDisabled()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Review and submit order' }))
    await screen.findByRole('heading', { name: 'Order submitted' })
    const posted = fetcher.mock.calls.filter(([request]) => isSubmitRequest(request))
    expect(posted).toHaveLength(2)
    expect(parseSubmit(posted[0][1]).idempotencyKey).toBe(parseSubmit(posted[1][1]).idempotencyKey)
    expect(parseSubmit(posted[0][1])).toEqual(parseSubmit(posted[1][1]))
    expect(sessionStorage.getItem(PUBLIC_ORDER_ATTEMPT_STORAGE_KEY)).toBeNull()
  })

  it('clears the session attempt on success without touching remembered details', async () => {
    localStorage.setItem('public-order-details-v1', JSON.stringify({
      customerName: 'Saved Name',
      customerPhone: '09170000000',
      address: 'Quezon City',
    }))
    let submits = 0
    const fetcher = vi.fn<PublicOrderFetch>(async (input) => {
      if (!isSubmitRequest(input)) throw new Error(`unexpected ${String(input)}`)
      submits += 1
      if (submits === 1) throw new TypeError('Failed to fetch')
      return jsonResponse(200, {
        submitted: true,
        status: 'pending',
        reference: 'MBA-1007',
        deliveryDate: '2026-09-15',
        totalCentavos: 20000,
        pendingAngelaAcceptance: true,
      })
    })
    const { unmount } = render(<PublicOrderForm menu={makeMenu()} endpoint={ENDPOINT} fetcher={fetcher} storage={window.localStorage} onMenuRevisionChange={vi.fn()} />)
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Saved Name')
    const user = userEvent.setup()
    await user.clear(screen.getByRole('textbox', { name: 'Name' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Ana')
    await user.click(screen.getByRole('button', { name: 'Review and submit order' }))
    await screen.findByText('Retry the same submission without changing your order.', { exact: false })
    expect(JSON.parse(String(localStorage.getItem('public-order-details-v1'))).customerName).toBe('Saved Name')
    expect(sessionStorage.getItem(PUBLIC_ORDER_ATTEMPT_STORAGE_KEY)).toBeTruthy()
    unmount()

    const remounted = render(<PublicOrderForm menu={makeMenu()} endpoint={ENDPOINT} fetcher={fetcher} storage={window.localStorage} onMenuRevisionChange={vi.fn()} />)
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Ana')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Review and submit order' }))
    await screen.findByRole('heading', { name: 'Order submitted' })
    expect(sessionStorage.getItem(PUBLIC_ORDER_ATTEMPT_STORAGE_KEY)).toBeNull()
    expect(JSON.parse(String(localStorage.getItem('public-order-details-v1'))).customerName).toBe('Saved Name')
    remounted.unmount()

    render(<PublicOrderForm menu={makeMenu()} endpoint={ENDPOINT} fetcher={fetcher} storage={window.localStorage} onMenuRevisionChange={vi.fn()} />)
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Saved Name')
    expect(screen.getByRole('checkbox', { name: 'Remember my details on this device' })).not.toBeChecked()
    expect(sessionStorage.getItem(PUBLIC_ORDER_ATTEMPT_STORAGE_KEY)).toBeNull()
  })

  it('keeps the same idempotency key after 409 reconfirm and submits the updated quote after ack', async () => {
    const refreshed = makeMenu({
      quoteRevision: REVISION_B,
      delivery: { deliveryDate: '2026-09-16', deliveryWindowStart: '08:00', deliveryWindowEnd: '09:00' },
      products: [matchaLatte({ basePriceCentavos: 25000 })],
    })
    let submits = 0
    const fetcher = vi.fn<PublicOrderFetch>(async (input) => {
      if (isSubmitRequest(input)) {
        submits += 1
        if (submits === 1) {
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
        return jsonResponse(200, {
          submitted: true,
          status: 'pending',
          reference: 'MBA-1008',
          deliveryDate: '2026-09-16',
          totalCentavos: 25000,
          pendingAngelaAcceptance: true,
        })
      }
      if (isMenuRequest(input)) return jsonResponse(200, refreshed)
      throw new Error(`unexpected ${String(input)}`)
    })
    render(<StatefulForm initialMenu={makeMenu()} fetcher={fetcher} />)
    const user = await fillRequiredDetails()
    await user.click(screen.getByRole('button', { name: 'Review and submit order' }))
    await screen.findByRole('heading', { name: 'Review updated order details' })
    expect(sessionStorage.getItem(PUBLIC_ORDER_ATTEMPT_STORAGE_KEY)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Confirm updated quote' }))
    await user.click(screen.getByRole('button', { name: 'Review and submit order' }))
    await screen.findByRole('heading', { name: 'Order submitted' })
    const posted = fetcher.mock.calls.filter(([request]) => isSubmitRequest(request))
    expect(posted).toHaveLength(2)
    expect(parseSubmit(posted[0][1]).idempotencyKey).toBe(parseSubmit(posted[1][1]).idempotencyKey)
    expect(parseSubmit(posted[0][1]).quoteRevision).toBe(REVISION_A)
    expect(parseSubmit(posted[1][1]).quoteRevision).toBe(REVISION_B)
    expect(parseSubmit(posted[1][1]).quotedTotalCentavos).toBe(25000)
    expect(parseSubmit(posted[1][1]).deliveryDate).toBe('2026-09-16')
    expect(parseSubmit(posted[1][1]).customerName).toBe('Ana')
    expect(sessionStorage.getItem(PUBLIC_ORDER_ATTEMPT_STORAGE_KEY)).toBeNull()
  })

  it('keeps the same idempotency key when a 409 reports the key was already used for a different order', async () => {
    const fetcher = vi.fn<PublicOrderFetch>(async (input) => {
      if (!isSubmitRequest(input)) throw new Error(`unexpected ${String(input)}`)
      return jsonResponse(409, { error: 'This confirmation key was already used for a different order.' })
    })
    render(<PublicOrderForm menu={makeMenu()} endpoint={ENDPOINT} fetcher={fetcher} storage={null} onMenuRevisionChange={vi.fn()} />)
    const user = await fillRequiredDetails()
    await user.click(screen.getByRole('button', { name: 'Review and submit order' }))
    await screen.findByText('This confirmation key was already used for a different order.')
    await user.click(screen.getByRole('button', { name: 'Review and submit order' }))
    await screen.findByText('This confirmation key was already used for a different order.')
    const posted = fetcher.mock.calls.filter(([request]) => isSubmitRequest(request))
    expect(posted).toHaveLength(2)
    expect(parseSubmit(posted[0][1]).idempotencyKey).toBe(parseSubmit(posted[1][1]).idempotencyKey)
    expect(parseSubmit(posted[0][1])).toEqual(parseSubmit(posted[1][1]))
    expect(screen.queryByRole('heading', { name: 'Order submitted' })).not.toBeInTheDocument()
  })
})

describe('PublicOrderForm delivery day', () => {
  const DAYS = ['2026-09-15', '2026-09-16', '2026-09-18']

  it('defaults to the first offered day, follows the selection in the heading, and submits it', async () => {
    const fetcher = vi.fn<PublicOrderFetch>(async (input, init) => {
      if (isSubmitRequest(input)) return jsonResponse(200, receiptFor(parseSubmit(init).deliveryDate))
      throw new Error(`unexpected ${String(input)}`)
    })
    render(<PublicOrderForm menu={menuWithDays(DAYS)} endpoint={ENDPOINT} fetcher={fetcher} storage={null} onMenuRevisionChange={vi.fn()} />)
    expect(screen.getByRole('group', { name: 'Delivery day' })).toBeInTheDocument()
    expect(screen.getAllByRole('radio').map((radio) => (radio as HTMLInputElement).value)).toEqual(DAYS)
    expect(radioFor('2026-09-15')).toBeChecked()
    expect(headingDate()).toBe('2026-09-15')

    const user = await fillRequiredDetails()
    await user.click(radioFor('2026-09-18'))
    expect(radioFor('2026-09-18')).toBeChecked()
    expect(radioFor('2026-09-15')).not.toBeChecked()
    expect(headingDate()).toBe('2026-09-18')

    await user.click(screen.getByRole('button', { name: 'Review and submit order' }))
    await screen.findByRole('heading', { name: 'Order submitted' })
    const posted = fetcher.mock.calls.filter(([request]) => isSubmitRequest(request))
    expect(parseSubmit(posted[0][1]).deliveryDate).toBe('2026-09-18')
  })

  it('moves between delivery days with the keyboard', async () => {
    render(<PublicOrderForm menu={menuWithDays(DAYS)} endpoint={ENDPOINT} fetcher={vi.fn()} storage={null} onMenuRevisionChange={vi.fn()} />)
    const user = userEvent.setup()
    radioFor('2026-09-15').focus()
    await user.keyboard('{ArrowRight}')
    expect(radioFor('2026-09-16')).toBeChecked()
    expect(headingDate()).toBe('2026-09-16')
  })

  it('keeps the chosen day through a reconfirm while it is still offered', async () => {
    const refreshed = menuWithDays(['2026-09-16', '2026-09-18'], { quoteRevision: REVISION_B })
    let submits = 0
    const fetcher = vi.fn<PublicOrderFetch>(async (input, init) => {
      if (isSubmitRequest(input)) {
        submits += 1
        if (submits === 1) {
          return jsonResponse(409, {
            code: 'RECONFIRM_REQUIRED',
            error: 'The delivery date or total changed. Please review the updated quote before submitting.',
            delivery: refreshed.delivery,
            deliveryOptions: refreshed.deliveryOptions,
            quoteRevision: REVISION_B,
            quote: { itemsSubtotalCentavos: 20000, thermalBagsTotalCentavos: 0, totalCentavos: 20000 },
            items: [],
            thermalBags: [],
          })
        }
        return jsonResponse(200, receiptFor(parseSubmit(init).deliveryDate))
      }
      if (isMenuRequest(input)) return jsonResponse(200, refreshed)
      throw new Error(`unexpected ${String(input)}`)
    })
    render(<StatefulForm initialMenu={menuWithDays(DAYS)} fetcher={fetcher} />)
    const user = await fillRequiredDetails()
    await user.click(radioFor('2026-09-18'))
    await user.click(screen.getByRole('button', { name: 'Review and submit order' }))
    await screen.findByRole('heading', { name: 'Review updated order details' })
    expect(radioFor('2026-09-18')).toBeChecked()
    expect(screen.queryByText('That day is no longer available', { exact: false })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Confirm updated quote' }))
    await user.click(screen.getByRole('button', { name: 'Review and submit order' }))
    await screen.findByRole('heading', { name: 'Order submitted' })
    const posted = fetcher.mock.calls.filter(([request]) => isSubmitRequest(request))
    expect(parseSubmit(posted[1][1]).deliveryDate).toBe('2026-09-18')
    expect(parseSubmit(posted[1][1]).quoteRevision).toBe(REVISION_B)
  })

  it('moves the order to the first offered day when the chosen day is gone', async () => {
    const refreshed = menuWithDays(['2026-09-16', '2026-09-17'], { quoteRevision: REVISION_B })
    let submits = 0
    const fetcher = vi.fn<PublicOrderFetch>(async (input, init) => {
      if (isSubmitRequest(input)) {
        submits += 1
        if (submits === 1) {
          return jsonResponse(409, {
            code: 'RECONFIRM_REQUIRED',
            error: 'The delivery date or total changed. Please review the updated quote before submitting.',
            delivery: refreshed.delivery,
            deliveryOptions: refreshed.deliveryOptions,
            quoteRevision: REVISION_B,
            quote: { itemsSubtotalCentavos: 20000, thermalBagsTotalCentavos: 0, totalCentavos: 20000 },
            items: [],
            thermalBags: [],
          })
        }
        return jsonResponse(200, receiptFor(parseSubmit(init).deliveryDate))
      }
      if (isMenuRequest(input)) return jsonResponse(200, refreshed)
      throw new Error(`unexpected ${String(input)}`)
    })
    render(<StatefulForm initialMenu={menuWithDays(DAYS)} fetcher={fetcher} />)
    const user = await fillRequiredDetails()
    await user.click(radioFor('2026-09-18'))
    await user.click(screen.getByRole('button', { name: 'Review and submit order' }))
    await screen.findByRole('heading', { name: 'Review updated order details' })
    expect(await screen.findByText(`That day is no longer available — we moved your order to ${longDate('2026-09-16')}. Please review before submitting.`)).toBeInTheDocument()
    expect(screen.getAllByRole('radio').map((radio) => (radio as HTMLInputElement).value)).toEqual(['2026-09-16', '2026-09-17'])
    expect(radioFor('2026-09-16')).toBeChecked()
    expect(headingDate()).toBe('2026-09-16')
    await user.click(screen.getByRole('button', { name: 'Confirm updated quote' }))
    await user.click(screen.getByRole('button', { name: 'Review and submit order' }))
    await screen.findByRole('heading', { name: 'Order submitted' })
    const posted = fetcher.mock.calls.filter(([request]) => isSubmitRequest(request))
    expect(parseSubmit(posted[0][1]).deliveryDate).toBe('2026-09-18')
    expect(parseSubmit(posted[1][1]).deliveryDate).toBe('2026-09-16')
  })

  function savedAttempt(deliveryDate: string): PublicOrderAttempt {
    const payload: PublicOrderInput = {
      customerName: 'Ana',
      customerPhone: '09171234567',
      address: 'Makati City',
      deliveryDate,
      notes: null,
      items: [{ productSlug: 'matcha-latte', quantity: 1, modifiers: { level: 1, powder: 'yumeno', sweetness: 'regular' } }],
      thermalBags: [],
      quoteRevision: REVISION_A,
      quotedTotalCentavos: 20000,
      idempotencyKey: 'public-order-restored-key-01',
      honeypot: '',
    }
    return { idempotencyKey: payload.idempotencyKey, payload, uncertain: false, savedAt: Date.now() }
  }

  it('restores the saved delivery day after a reload while it is still offered', () => {
    sessionStorage.setItem(PUBLIC_ORDER_ATTEMPT_STORAGE_KEY, JSON.stringify(savedAttempt('2026-09-16')))
    render(<PublicOrderForm menu={menuWithDays(DAYS)} endpoint={ENDPOINT} fetcher={vi.fn()} storage={null} onMenuRevisionChange={vi.fn()} />)
    expect(radioFor('2026-09-16')).toBeChecked()
    expect(headingDate()).toBe('2026-09-16')
  })

  it('falls back to the first offered day when the saved day is no longer offered', () => {
    sessionStorage.setItem(PUBLIC_ORDER_ATTEMPT_STORAGE_KEY, JSON.stringify(savedAttempt('2026-09-14')))
    render(<PublicOrderForm menu={menuWithDays(DAYS)} endpoint={ENDPOINT} fetcher={vi.fn()} storage={null} onMenuRevisionChange={vi.fn()} />)
    expect(radioFor('2026-09-15')).toBeChecked()
    expect(headingDate()).toBe('2026-09-15')
  })

  it('resolves the restored day from the offered list', () => {
    const options = DAYS.map(day)
    expect(restoredDeliveryDate(savedAttempt('2026-09-18'), options)).toBe('2026-09-18')
    expect(restoredDeliveryDate(savedAttempt('2026-09-20'), options)).toBe('2026-09-15')
    expect(restoredDeliveryDate(null, options)).toBe('2026-09-15')
    expect(restoredDeliveryDate(null, [])).toBeNull()
  })
})
