import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalAdapter, resetLocalAdapterMemoryForTests } from '../../data/local-adapter'
import { demoOrders } from '../../demo/seed'
import { formatLifecycleTimestamp } from '../orders/order-timestamps'
import { canAdvance, canCancel, nextStatus } from '../orders/orderLifecycle'
import { TodayBoard } from './TodayBoard'
import { manilaToday } from '../../domain/delivery-schedule'
import { DEFAULT_DASHBOARD_SETTINGS, saveDashboardSettings } from '../settings/settings-store'

const deliveryDate = '2026-07-16'
let adapters: LocalAdapter[] = []

beforeEach(() => {
  resetLocalAdapterMemoryForTests()
  adapters = []
})

afterEach(async () => {
  await Promise.all(adapters.map((adapter) => adapter.close()))
})

async function createAdapter(): Promise<LocalAdapter> {
  const adapter = await LocalAdapter.create()
  adapters.push(adapter)
  return adapter
}

describe('TodayBoard', () => {
  it('defaults to the run from saved Settings, skipping an owner-closed today', async () => {
    const adapter = await createAdapter()
    const today = manilaToday(new Date())
    const tomorrow = new Date(`${today}T00:00:00.000Z`)
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
    await saveDashboardSettings(adapter, {
      ...DEFAULT_DASHBOARD_SETTINGS,
      openDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
      closedDates: [today],
      deliveryWindowStart: '07:30',
      orderCutoff: '21:00',
    })
    render(<TodayBoard adapter={adapter} />)

    await waitFor(() => expect(screen.getByLabelText('Delivery date')).toHaveValue(tomorrow.toISOString().slice(0, 10)))
    expect(screen.getByText(/7:30 AM–9 AM delivery run · orders close at 9 PM/)).toBeInTheDocument()
  })

  it('scopes orders by the selected delivery date', async () => {
    const adapter = await createAdapter()
    await adapter.updateOrder(demoOrders[1].id, { deliveryDate: '2026-07-17' })
    render(<TodayBoard adapter={adapter} initialDeliveryDate={deliveryDate} />)

    expect(await screen.findByRole('heading', { name: 'Mika Santos' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Paolo Reyes' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Delivery date'), { target: { value: '2026-07-17' } })
    expect(await screen.findByRole('heading', { name: 'Paolo Reyes' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Mika Santos' })).not.toBeInTheDocument()
  })

  it('persists New → Paid → Delivered and records payment automatically', async () => {
    const adapter = await createAdapter()
    await adapter.updateOrder(demoOrders[1].id, { status: 'new', paymentReceived: false })
    const user = userEvent.setup()
    render(<TodayBoard adapter={adapter} initialDeliveryDate={deliveryDate} />)

    const card = await screen.findByRole('heading', { name: 'Paolo Reyes' })
    expect(card).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Mark Paid' }))
    await waitFor(async () => expect(await adapter.getOrder(demoOrders[1].id)).toMatchObject({ status: 'paid', paymentReceived: true }))
    const paoloCard = (await screen.findByRole('heading', { name: 'Paolo Reyes' })).closest('article')!
    await user.click(within(paoloCard).getByRole('button', { name: 'Mark Delivered' }))
    await waitFor(async () => expect((await adapter.getOrder(demoOrders[1].id))?.status).toBe('delivered'))
    expect(within((await screen.findByRole('heading', { name: 'Paolo Reyes' })).closest('article')!).queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument()
  })

  it('blocks invalid lifecycle transitions and makes cancellation terminal', () => {
    expect(nextStatus('delivered')).toBeNull()
    expect(canAdvance({ ...demoOrders[1], status: 'new', paymentReceived: false })).toBe(true)
    expect(canAdvance({ ...demoOrders[1], status: 'paid', paymentReceived: true })).toBe(true)
    for (const status of ['new', 'paid'] as const) expect(canCancel(status)).toBe(true)
    expect(canCancel('delivered')).toBe(false)
    expect(canCancel('cancelled')).toBe(false)
    expect(nextStatus('cancelled')).toBeNull()
  })

  it('cancels a non-delivered order and persists the terminal state', async () => {
    const adapter = await createAdapter()
    await adapter.updateOrder(demoOrders[1].id, { status: 'paid', paymentReceived: true })
    const user = userEvent.setup()
    render(<TodayBoard adapter={adapter} initialDeliveryDate={deliveryDate} />)

    const paoloCard = (await screen.findByRole('heading', { name: 'Paolo Reyes' })).closest('article')!
    await user.click(within(paoloCard).getByRole('button', { name: 'Cancel order' }))
    await waitFor(async () => expect(await adapter.getOrder(demoOrders[1].id)).toMatchObject({ status: 'cancelled', paymentReceived: true }))
    expect(within(await screen.findByRole('heading', { name: 'Paolo Reyes' }).then((heading) => heading.closest('article')!)).queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument()
  })

  it('persists accessible route reordering', async () => {
    const adapter = await createAdapter()
    const user = userEvent.setup()
    render(<TodayBoard adapter={adapter} initialDeliveryDate={deliveryDate} />)

    await user.click(screen.getByRole('button', { name: 'Run list' }))
    await screen.findByRole('heading', { name: 'Delivery run' })
    await user.click(screen.getByRole('button', { name: 'Move Paolo Reyes up' }))
    await waitFor(async () => {
      expect((await adapter.getOrder(demoOrders[1].id))?.routePosition).toBe(1)
      expect((await adapter.getOrder(demoOrders[0].id))?.routePosition).toBe(2)
    })
  })

  it('refreshes when another LocalAdapter session advances an order', async () => {
    const first = await createAdapter()
    const second = await createAdapter()
    render(<TodayBoard adapter={first} initialDeliveryDate={deliveryDate} />)
    expect(await screen.findByRole('button', { name: 'Mark Paid' })).toBeInTheDocument()

    await second.updateOrder(demoOrders[1].id, { status: 'paid', paymentReceived: true })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark Delivered' })).toBeInTheDocument())
  })

  it('creates a manual new order through the shared editor, persisted with engine-priced totals', async () => {
    const adapter = await createAdapter()
    const user = userEvent.setup()
    render(<TodayBoard adapter={adapter} initialDeliveryDate={deliveryDate} />)
    await screen.findByRole('heading', { name: 'Mika Santos' })

    await user.click(screen.getByRole('button', { name: 'New order' }))
    const dialog = await screen.findByRole('dialog', { name: 'New order' })
    await user.type(within(dialog).getByRole('textbox', { name: 'Customer name' }), 'Jenna Cruz')
    await user.type(within(dialog).getByRole('textbox', { name: 'Address' }), 'Taguig City')
    await user.click(within(dialog).getByRole('button', { name: 'Confirm order' }))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New order' })).not.toBeInTheDocument())
    const orders = await adapter.listOrders()
    const created = orders.find((order) => order.addressSnapshot === 'Taguig City')
    expect(created).toBeDefined()
    // The default drink row is one Matcha Latte, level 1, Yumeno — 20000 centavos per the demo catalog.
    // This value is asserted to prove the engine priced it, not any UI-supplied number.
    expect(created!.subtotalCentavos).toBe(20000)
    expect(created!.totalCentavos).toBe(20000)
    expect(created!.deliveryDate).toBe(deliveryDate)
  })

  it('edits an order through the shared editor, reprices via the engine, and leaves no orphan order_items', async () => {
    const adapter = await createAdapter()
    const user = userEvent.setup()
    render(<TodayBoard adapter={adapter} initialDeliveryDate={deliveryDate} />)

    const paoloCard = (await screen.findByRole('heading', { name: 'Paolo Reyes' })).closest('article')!
    await user.click(within(paoloCard).getByRole('button', { name: 'Edit order' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit order' })
    const quantityInput = within(dialog).getByRole('spinbutton', { name: 'Quantity 1' })
    await user.clear(quantityInput)
    await user.type(quantityInput, '3')
    await user.click(within(dialog).getByRole('button', { name: 'Confirm order' }))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit order' })).not.toBeInTheDocument())
    const updated = await adapter.getOrder(demoOrders[1].id)
    expect(updated!.items).toHaveLength(1)
    expect(updated!.items[0].quantity).toBe(3)
    // Strawberry Hojicha level 2 / Yumeno prices to 22000 centavos in the demo catalog; three units reprice to 66000.
    expect(updated!.items[0].lineTotalCentavos).toBe(66000)
    expect(updated!.subtotalCentavos).toBe(66000)
    expect(updated!.totalCentavos).toBe(66000)
    const orderItems = await adapter.listOrderItems(demoOrders[1].id)
    expect(orderItems).toHaveLength(1)
  })

  it('deletes an order after a single confirmation, leaving no orphan order_items', async () => {
    const adapter = await createAdapter()
    const user = userEvent.setup()
    render(<TodayBoard adapter={adapter} initialDeliveryDate={deliveryDate} />)

    const paoloCard = (await screen.findByRole('heading', { name: 'Paolo Reyes' })).closest('article')!
    await user.click(within(paoloCard).getByRole('button', { name: 'Delete order' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Delete this order permanently?')
    await user.click(screen.getByRole('button', { name: 'Confirm delete order' }))

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Paolo Reyes' })).not.toBeInTheDocument())
    expect(await adapter.getOrder(demoOrders[1].id)).toBeNull()
    expect(await adapter.listOrderItems(demoOrders[1].id)).toHaveLength(0)
  })

  it('surfaces storage-generated Paid/Delivered lines after real adapter advances, without rewriting paidAt', async () => {
    const adapter = await createAdapter()
    await adapter.updateOrder(demoOrders[1].id, { status: 'new', paymentReceived: false })
    const user = userEvent.setup()
    render(<TodayBoard adapter={adapter} initialDeliveryDate={deliveryDate} />)

    const heading = await screen.findByRole('heading', { name: 'Paolo Reyes' })
    let card = heading.closest('article')!
    expect(within(card).queryByText(/^Paid /)).not.toBeInTheDocument()

    await user.click(within(card).getByRole('button', { name: 'Mark Paid' }))
    await waitFor(async () => {
      const paid = await adapter.getOrder(demoOrders[1].id)
      expect(paid).toMatchObject({ status: 'paid', paymentReceived: true })
      expect(paid?.paidAt).toEqual(expect.any(String))
      expect(paid?.deliveredAt).toBeNull()
    })

    const paidOrder = (await adapter.getOrder(demoOrders[1].id))!
    const frozenPaidAt = paidOrder.paidAt
    const paidLabel = `Paid ${formatLifecycleTimestamp(frozenPaidAt)}`
    card = (await screen.findByRole('heading', { name: 'Paolo Reyes' })).closest('article')!
    expect(within(card).getByText(paidLabel)).toBeInTheDocument()
    expect(within(card).queryByText(/^Delivered /)).not.toBeInTheDocument()

    await user.click(within(card).getByRole('button', { name: 'Mark Delivered' }))
    await waitFor(async () => {
      const delivered = await adapter.getOrder(demoOrders[1].id)
      expect(delivered?.status).toBe('delivered')
      expect(delivered?.paidAt).toBe(frozenPaidAt)
      expect(delivered?.deliveredAt).toEqual(expect.any(String))
    })

    const deliveredOrder = (await adapter.getOrder(demoOrders[1].id))!
    card = (await screen.findByRole('heading', { name: 'Paolo Reyes' })).closest('article')!
    expect(within(card).getByText(paidLabel)).toBeInTheDocument()
    expect(within(card).getByText(`Delivered ${formatLifecycleTimestamp(deliveredOrder.deliveredAt)}`)).toBeInTheDocument()
  })

  it('advance() never patches paidAt or deliveredAt onto updateOrder', async () => {
    const adapter = await createAdapter()
    await adapter.updateOrder(demoOrders[1].id, { status: 'new', paymentReceived: false })
    const spy = vi.spyOn(adapter, 'updateOrder')
    const user = userEvent.setup()
    render(<TodayBoard adapter={adapter} initialDeliveryDate={deliveryDate} />)

    const card = (await screen.findByRole('heading', { name: 'Paolo Reyes' })).closest('article')!
    await user.click(within(card).getByRole('button', { name: 'Mark Paid' }))
    await waitFor(() => expect(spy).toHaveBeenCalled())

    const patches = spy.mock.calls.map(([, patch]) => patch)
    expect(patches.length).toBeGreaterThan(0)
    for (const patch of patches) {
      expect(patch).not.toHaveProperty('paidAt')
      expect(patch).not.toHaveProperty('deliveredAt')
    }
    // The advance path should still send status (+ paymentReceived for paid).
    expect(patches.some((patch) => patch.status === 'paid' && patch.paymentReceived === true)).toBe(true)
  })
})
