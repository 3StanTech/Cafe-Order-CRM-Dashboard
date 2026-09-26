import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalAdapter, resetLocalAdapterMemoryForTests } from '../../data/local-adapter'
import { manilaToday } from '../../domain/delivery-schedule'
import { setRuntimeCatalogSettings } from '../../domain/catalog'
import { SettingsFeature } from './SettingsFeature'
import { loadDashboardSettings } from './settings-store'

function isoPlusDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00.000Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

let adapter: LocalAdapter

beforeEach(async () => {
  resetLocalAdapterMemoryForTests()
  setRuntimeCatalogSettings(null)
  adapter = await LocalAdapter.create()
})

afterEach(async () => {
  await adapter.close()
  setRuntimeCatalogSettings(null)
})

function renderSettings() {
  return render(<MemoryRouter><SettingsFeature adapter={adapter} /></MemoryRouter>)
}

describe('SettingsFeature closed dates', () => {
  it('adds and removes closed dates, then persists them on save', async () => {
    const user = userEvent.setup()
    const today = manilaToday(new Date())
    const first = isoPlusDays(today, 3)
    const second = isoPlusDays(today, 5)
    renderSettings()

    const input = await screen.findByLabelText('Closed date to add')
    await user.type(input, second)
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await user.type(input, first)
    await user.click(screen.getByRole('button', { name: 'Add' }))

    const chips = within(screen.getByRole('group', { name: 'Closed dates' })).getAllByRole('button', { name: /^Reopen / })
    expect(chips).toHaveLength(2)

    await user.click(chips[1])
    await user.click(screen.getByRole('button', { name: 'Save settings' }))

    await waitFor(async () => expect((await loadDashboardSettings(adapter)).closedDates).toEqual([first]))
  })

  it('rejects today, past and duplicate dates with a visible hint', async () => {
    const user = userEvent.setup()
    const today = manilaToday(new Date())
    renderSettings()

    const input = await screen.findByLabelText('Closed date to add')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByRole('status')).toHaveTextContent('Choose a date first.')

    await user.type(input, today)
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByRole('status')).toHaveTextContent('Pick a future date')

    const tomorrow = isoPlusDays(today, 1)
    await user.clear(input)
    await user.type(input, tomorrow)
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await user.type(input, tomorrow)
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByRole('status')).toHaveTextContent('already closed')
    expect(screen.getAllByRole('button', { name: /^Reopen / })).toHaveLength(1)
  })

  it('links to the one-time history import', async () => {
    renderSettings()
    expect(await screen.findByRole('link', { name: 'Import history (one-time)' })).toHaveAttribute('href', '/settings/import-history')
  })
})
