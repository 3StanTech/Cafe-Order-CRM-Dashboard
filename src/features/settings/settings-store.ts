import {
  HOJICHA_LEVEL_UPCHARGES,
  MATCHA_LEVEL_UPCHARGES,
  POWDER_UPCHARGES,
  PRODUCT_CATALOG,
  THERMAL_BAG_PRICES,
  setRuntimeCatalogSettings,
  type RuntimeCatalogSettings,
} from '../../domain/catalog'
import type { MoneyCentavos, Powder, ProductSlug } from '../../domain/contracts'
import { manilaToday } from '../../domain/delivery-schedule'
import type { JsonValue, StorageAdapter } from '../../data/types'

export const ORDER_DASHBOARD_SETTINGS_KEY = 'order_dashboard_settings'

export type OpenDay = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'

export type DashboardSettings = RuntimeCatalogSettings & {
  openDays: OpenDay[]
  /** Specific Manila dates (YYYY-MM-DD) that are closed even on an open weekday. */
  closedDates: string[]
  orderCutoff: string
  deliveryWindowStart: string
  deliveryWindowEnd: string
  gCashNumber: string
  businessName: string
  businessDescription: string
  businessContact: string
}

const productSlugs = Object.keys(PRODUCT_CATALOG) as ProductSlug[]
const openDays: OpenDay[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

export const DEFAULT_DASHBOARD_SETTINGS: DashboardSettings = {
  productBasePrices: Object.fromEntries(productSlugs.map((slug) => [slug, PRODUCT_CATALOG[slug].basePriceCentavos])) as Record<ProductSlug, MoneyCentavos>,
  productAvailability: Object.fromEntries(productSlugs.map((slug) => [slug, true])) as Record<ProductSlug, boolean>,
  matchaLevelUpcharges: { ...MATCHA_LEVEL_UPCHARGES },
  hojichaLevelUpcharges: { ...HOJICHA_LEVEL_UPCHARGES },
  powderUpcharges: { ...POWDER_UPCHARGES },
  thermalBagPrices: { ...THERMAL_BAG_PRICES },
  openDays: ['tuesday', 'wednesday', 'thursday', 'friday', 'sunday'],
  closedDates: [],
  orderCutoff: '20:00',
  deliveryWindowStart: '08:00',
  deliveryWindowEnd: '09:00',
  gCashNumber: '',
  businessName: 'Made by Angela',
  businessDescription: 'Matcha and hojicha delivery',
  businessContact: '',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function centavos(value: unknown, fallback: MoneyCentavos): MoneyCentavos {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function text(value: unknown, fallback: string, maximum = 160): string {
  return typeof value === 'string' ? value.slice(0, maximum) : fallback
}

function time(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback
}

function productPrices(value: unknown): Record<ProductSlug, MoneyCentavos> {
  const source = isRecord(value) ? value : {}
  return Object.fromEntries(productSlugs.map((slug) => [slug, centavos(source[slug], DEFAULT_DASHBOARD_SETTINGS.productBasePrices[slug])])) as Record<ProductSlug, MoneyCentavos>
}

function availability(value: unknown): Record<ProductSlug, boolean> {
  const source = isRecord(value) ? value : {}
  return Object.fromEntries(productSlugs.map((slug) => [slug, typeof source[slug] === 'boolean' ? source[slug] : true])) as Record<ProductSlug, boolean>
}

function levels(value: unknown, fallback: Readonly<Record<1 | 2 | 3, MoneyCentavos>>): Record<1 | 2 | 3, MoneyCentavos> {
  const source = isRecord(value) ? value : {}
  return { 1: centavos(source['1'], fallback[1]), 2: centavos(source['2'], fallback[2]), 3: centavos(source['3'], fallback[3]) }
}

function powders(value: unknown): Record<Powder, MoneyCentavos> {
  const source = isRecord(value) ? value : {}
  return { yumeno: centavos(source.yumeno, POWDER_UPCHARGES.yumeno), mk_isuzu: centavos(source.mk_isuzu, POWDER_UPCHARGES.mk_isuzu) }
}

function thermalBags(value: unknown): Record<1 | 2 | 3 | 4, MoneyCentavos> {
  const source = isRecord(value) ? value : {}
  return { 1: centavos(source['1'], THERMAL_BAG_PRICES[1]), 2: centavos(source['2'], THERMAL_BAG_PRICES[2]), 3: centavos(source['3'], THERMAL_BAG_PRICES[3]), 4: centavos(source['4'], THERMAL_BAG_PRICES[4]) }
}

export const MAX_CLOSED_DATES = 60

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

function closedDates(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter(isIsoDate))].sort().slice(0, MAX_CLOSED_DATES)
}

export function parseDashboardSettings(value: unknown): DashboardSettings {
  const source = isRecord(value) ? value : {}
  const configuredDays = Array.isArray(source.openDays) ? source.openDays.filter((day): day is OpenDay => typeof day === 'string' && openDays.includes(day as OpenDay)) : DEFAULT_DASHBOARD_SETTINGS.openDays
  return {
    productBasePrices: productPrices(source.productBasePrices),
    productAvailability: availability(source.productAvailability),
    matchaLevelUpcharges: levels(source.matchaLevelUpcharges, MATCHA_LEVEL_UPCHARGES),
    hojichaLevelUpcharges: levels(source.hojichaLevelUpcharges, HOJICHA_LEVEL_UPCHARGES),
    powderUpcharges: powders(source.powderUpcharges),
    thermalBagPrices: thermalBags(source.thermalBagPrices),
    openDays: [...new Set(configuredDays)],
    closedDates: closedDates(source.closedDates),
    orderCutoff: time(source.orderCutoff, DEFAULT_DASHBOARD_SETTINGS.orderCutoff),
    deliveryWindowStart: time(source.deliveryWindowStart, DEFAULT_DASHBOARD_SETTINGS.deliveryWindowStart),
    deliveryWindowEnd: time(source.deliveryWindowEnd, DEFAULT_DASHBOARD_SETTINGS.deliveryWindowEnd),
    gCashNumber: text(source.gCashNumber, '', 40),
    businessName: text(source.businessName, DEFAULT_DASHBOARD_SETTINGS.businessName),
    businessDescription: text(source.businessDescription, DEFAULT_DASHBOARD_SETTINGS.businessDescription),
    businessContact: text(source.businessContact, '', 120),
  }
}

export function applyDashboardSettings(settings: DashboardSettings): void {
  setRuntimeCatalogSettings(settings)
}

export async function loadDashboardSettings(adapter: StorageAdapter): Promise<DashboardSettings> {
  const stored = await adapter.getSetting(ORDER_DASHBOARD_SETTINGS_KEY)
  const settings = parseDashboardSettings(stored?.value)
  applyDashboardSettings(settings)
  return settings
}

export async function saveDashboardSettings(adapter: StorageAdapter, settings: DashboardSettings): Promise<DashboardSettings> {
  const parsed = parseDashboardSettings(settings)
  const today = manilaToday(new Date())
  // Past closures can never affect a delivery again; dropping them keeps the list short.
  const clean = { ...parsed, closedDates: parsed.closedDates.filter((date) => date >= today) }
  const now = new Date().toISOString()
  await adapter.setSetting({
    key: ORDER_DASHBOARD_SETTINGS_KEY,
    value: clean as unknown as JsonValue,
    createdAt: now,
    updatedAt: now,
  })
  applyDashboardSettings(clean)
  return clean
}

export const productSettingRows = productSlugs.map((slug) => ({ slug, name: PRODUCT_CATALOG[slug].name }))
export const weekdayRows = openDays.map((day) => ({ day, label: day.slice(0, 1).toUpperCase() + day.slice(1) }))
