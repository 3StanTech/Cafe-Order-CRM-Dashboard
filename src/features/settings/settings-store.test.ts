import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRuntimeCatalog, setRuntimeCatalogSettings } from '../../domain/catalog'
import { priceOrder } from '../../domain/pricing'
import { LocalAdapter, resetLocalAdapterMemoryForTests } from '../../data/local-adapter'
import {
  DEFAULT_DASHBOARD_SETTINGS,
  ORDER_DASHBOARD_SETTINGS_KEY,
  loadDashboardSettings,
  parseDashboardSettings,
  saveDashboardSettings,
  type DashboardSettings,
} from './settings-store'

describe('dashboard settings catalog bridge', () => {
  beforeEach(() => { resetLocalAdapterMemoryForTests(); setRuntimeCatalogSettings(null) })
  afterEach(() => setRuntimeCatalogSettings(null))

  it('persists owner settings and applies them to deterministic pricing', async () => {
    const adapter = await LocalAdapter.create()
    const configured: DashboardSettings = {
      ...DEFAULT_DASHBOARD_SETTINGS,
      productBasePrices: { ...DEFAULT_DASHBOARD_SETTINGS.productBasePrices, 'matcha-latte': 21000 },
      gCashNumber: '09171234567',
      openDays: ['tuesday', 'wednesday'],
    }

    await saveDashboardSettings(adapter, configured)
    expect(await adapter.getSetting(ORDER_DASHBOARD_SETTINGS_KEY)).toMatchObject({ value: expect.objectContaining({ gCashNumber: '09171234567', orderCutoff: '20:00' }) })
    expect(priceOrder({ items: [{ productSlug: 'matcha-latte', quantity: 1, modifiers: { level: 2, powder: 'yumeno' } }] }).totals.totalCentavos).toBe(23500)

    await adapter.close()
  })

  it('restores defaults and removes unavailable products from runtime import catalog', async () => {
    const adapter = await LocalAdapter.create()
    await saveDashboardSettings(adapter, { ...DEFAULT_DASHBOARD_SETTINGS, productAvailability: { ...DEFAULT_DASHBOARD_SETTINGS.productAvailability, 'matcha-latte': false } })
    expect(getRuntimeCatalog()['matcha-latte']).toBeUndefined()
    await saveDashboardSettings(adapter, DEFAULT_DASHBOARD_SETTINGS)
    expect((await loadDashboardSettings(adapter)).productBasePrices['matcha-latte']).toBe(20000)
    expect(priceOrder({ items: [{ productSlug: 'matcha-latte', quantity: 1, modifiers: { level: 1, powder: 'yumeno' } }] }).totals.totalCentavos).toBe(20000)
    await adapter.close()
  })

  it('normalizes closed dates: valid ISO only, de-duplicated, sorted, capped', () => {
    const parsed = parseDashboardSettings({ closedDates: ['2026-10-03', 'nope', '2026-02-30', '2026-10-01', '2026-10-03', 7] })
    expect(parsed.closedDates).toEqual(['2026-10-01', '2026-10-03'])
    expect(parseDashboardSettings({}).closedDates).toEqual([])
    const many = Array.from({ length: 80 }, (_, index) => new Date(Date.UTC(2027, 0, 1 + index)).toISOString().slice(0, 10))
    expect(parseDashboardSettings({ closedDates: many }).closedDates).toHaveLength(60)
  })

  it('drops closed dates before today (Manila) when saving and round-trips the rest', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-26T02:00:00Z'))
    try {
      const adapter = await LocalAdapter.create()
      const saved = await saveDashboardSettings(adapter, { ...DEFAULT_DASHBOARD_SETTINGS, closedDates: ['2026-09-25', '2026-09-26', '2026-09-27'] })
      expect(saved.closedDates).toEqual(['2026-09-26', '2026-09-27'])
      expect((await loadDashboardSettings(adapter)).closedDates).toEqual(['2026-09-26', '2026-09-27'])
      await adapter.close()
    } finally {
      vi.useRealTimers()
    }
  })
})
