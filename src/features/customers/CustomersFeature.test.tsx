import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BrowserRouter } from 'react-router-dom'
import { createInsightsFixture } from '../../../test/fixtures/insights/createInsightsFixture'
import { getRelevantDeliveryDate } from '../../domain/delivery-schedule'
import { DEFAULT_DASHBOARD_SETTINGS } from '../settings/settings-store'
import { CustomersFeature } from './CustomersFeature'
import { loadCustomerProfile } from './customer-profile'

describe('CustomersFeature', () => {
  it('searches customers and persists profile details through StorageAdapter', async () => {
    const adapter = await createInsightsFixture()
    const user = userEvent.setup()
    window.history.pushState({}, '', '/customers')
    render(<BrowserRouter><CustomersFeature adapter={adapter} /></BrowserRouter>)

    await screen.findByRole('heading', { name: 'Customers' })
    await user.type(screen.getByRole('searchbox', { name: 'Search customers' }), 'Ana')
    await user.click(screen.getByRole('link', { name: 'View Ana' }))
    await screen.findByRole('heading', { name: 'Ana' })
    await user.clear(screen.getByRole('textbox', { name: 'Notes' }))
    await user.type(screen.getByRole('textbox', { name: 'Notes' }), 'Prefers a quiet drop-off.')
    await user.click(screen.getByRole('button', { name: 'Save details' }))
    await screen.findByRole('status')
    await waitFor(async () => expect((await adapter.getSetting('customer:customer-ana:profile'))?.value).toMatchObject({ notes: 'Prefers a quiet drop-off.' }))
    await expect(loadCustomerProfile(adapter, 'customer-ana')).resolves.toMatchObject({ notes: 'Prefers a quiet drop-off.', address: 'Makati City', preferences: '' })
    await adapter.close()
  })

  it('edits a customer\'s name and phone through Contact info and persists via updateCustomer', async () => {
    const adapter = await createInsightsFixture()
    const user = userEvent.setup()
    window.history.pushState({}, '', '/customers')
    render(<BrowserRouter><CustomersFeature adapter={adapter} /></BrowserRouter>)

    await screen.findByRole('heading', { name: 'Customers' })
    await user.click(screen.getByRole('link', { name: 'View Ana' }))
    await screen.findByRole('heading', { name: 'Ana' })

    const nameInput = screen.getByRole('textbox', { name: 'Name' })
    await user.clear(nameInput)
    await user.type(nameInput, 'Ana Reyes')
    const phoneInput = screen.getByRole('textbox', { name: 'Phone' })
    await user.clear(phoneInput)
    await user.type(phoneInput, '09991234567')
    await user.click(screen.getByRole('button', { name: 'Save contact info' }))

    await waitFor(async () => expect((await adapter.getCustomer('customer-ana'))?.name).toBe('Ana Reyes'))
    expect((await adapter.getCustomer('customer-ana'))?.phone).toBe('09991234567')
    await adapter.close()
  })

  it('repeats a customer\'s last non-cancelled order into a fresh, engine-priced order', async () => {
    const adapter = await createInsightsFixture()
    const user = userEvent.setup()
    window.history.pushState({}, '', '/customers')
    render(<BrowserRouter><CustomersFeature adapter={adapter} /></BrowserRouter>)

    await screen.findByRole('heading', { name: 'Customers' })
    await user.click(screen.getByRole('link', { name: 'View Ana' }))
    await screen.findByRole('heading', { name: 'Ana' })
    const before = await adapter.listOrders()

    await user.click(screen.getByRole('button', { name: 'Repeat last order' }))
    const dialog = await screen.findByRole('dialog', { name: 'Repeat last order' })
    await user.click(within(dialog).getByRole('button', { name: 'Confirm order' }))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Repeat last order' })).not.toBeInTheDocument())
    const after = await adapter.listOrders()
    expect(after).toHaveLength(before.length + 1)
    const created = after.find((order) => !before.some((existing) => existing.id === order.id))!
    expect(created.customerId).toBe('customer-ana')
    // Ana's most recent non-cancelled order is one Matcha Latte, level 2, Yumeno — 22500 centavos per the
    // fixture catalog. Asserting this proves the engine repriced the repeat, rather than copying the old total.
    expect(created.subtotalCentavos).toBe(22500)
    expect(created.totalCentavos).toBe(22500)
    expect(created.deliveryDate).toBe(getRelevantDeliveryDate(new Date(), DEFAULT_DASHBOARD_SETTINGS))
    await adapter.close()
  })

  it('deletes a customer after double confirmation, cascading to their orders, and returns to the list', async () => {
    const adapter = await createInsightsFixture()
    const user = userEvent.setup()
    window.history.pushState({}, '', '/customers')
    render(<BrowserRouter><CustomersFeature adapter={adapter} /></BrowserRouter>)

    await screen.findByRole('heading', { name: 'Customers' })
    await user.click(screen.getByRole('link', { name: 'View Ana' }))
    await screen.findByRole('heading', { name: 'Ana' })

    await user.click(screen.getByRole('button', { name: 'Delete customer' }))
    expect(screen.getByRole('alert')).toHaveTextContent('This cannot be undone')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByRole('alert')).toHaveTextContent('This is permanent')
    await user.click(screen.getByRole('button', { name: 'Yes, delete permanently' }))

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Customers' })).toBeInTheDocument())
    expect(await adapter.getCustomer('customer-ana')).toBeNull()
    const remainingOrders = await adapter.listOrders()
    expect(remainingOrders.some((order) => order.customerId === 'customer-ana')).toBe(false)
    await adapter.close()
  })
})
