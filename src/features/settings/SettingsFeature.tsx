import { AlertTriangle, Check, History, LoaderCircle, Save, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ProductSlug } from '../../domain/contracts'
import type { StorageAdapter } from '../../data/types'
import { manilaToday } from '../../domain/delivery-schedule'
import {
  MAX_CLOSED_DATES,
  loadDashboardSettings,
  productSettingRows,
  saveDashboardSettings,
  weekdayRows,
  type DashboardSettings,
  type OpenDay,
} from './settings-store'

function phpInputValue(centavos: number): string { return String(centavos / 100) }
function toCentavos(value: string, fallback: number): number {
  const amount = Number(value)
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : fallback
}

const closedDateFormatter = new Intl.DateTimeFormat('en-PH', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })

function formatClosedDate(date: string): string {
  return closedDateFormatter.format(new Date(`${date}T00:00:00.000Z`))
}

function addDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00.000Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

/** Owner-closed dates override open days on the order form and the Today board. */
function ClosedDatesField({ closedDates, onChange }: { closedDates: readonly string[]; onChange: (closedDates: string[]) => void }) {
  const [draft, setDraft] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  const today = manilaToday(new Date())
  const upcoming = closedDates.filter((date) => date >= today)
  const add = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft)) { setHint('Choose a date first.'); return }
    if (draft <= today) { setHint('Pick a future date — today and past days can’t be closed here.'); return }
    if (upcoming.includes(draft)) { setHint('That date is already closed.'); return }
    if (upcoming.length >= MAX_CLOSED_DATES) { setHint(`You can close up to ${MAX_CLOSED_DATES} dates at a time.`); return }
    onChange([...upcoming, draft].sort())
    setDraft('')
    setHint(null)
  }
  return <fieldset className="mt-4"><legend className="text-sm font-bold text-[#20242F]">Closed dates</legend><p id="closed-dates-help" className="mt-1 text-sm text-[#4A5365]">Closed dates override open days. Customers can’t pick them on the order form.</p><div className="mt-2 flex gap-2"><input aria-label="Closed date to add" aria-describedby="closed-dates-help" className={inputClass} type="date" min={addDays(today, 1)} value={draft} onChange={(event) => { setDraft(event.target.value); setHint(null) }} /><button type="button" onClick={add} className="min-h-11 shrink-0 rounded-xl border border-[#4F74C8]/40 bg-[#EAF0FF] px-4 text-sm font-bold text-[#365AA9] transition-colors hover:bg-[#4F74C8]/10">Add</button></div>{hint && <p role="status" className="mt-2 text-sm font-semibold text-amber-800">{hint}</p>}{upcoming.length > 0 ? <ul className="mt-3 flex flex-wrap gap-2" role="list">{upcoming.map((date) => <li key={date}><button type="button" aria-label={`Reopen ${formatClosedDate(date)}`} onClick={() => onChange(upcoming.filter((entry) => entry !== date))} className="flex min-h-11 items-center gap-1.5 rounded-xl border border-[#4F74C8]/25 bg-[#FBF3D5]/70 px-3 text-sm font-semibold text-[#20242F] transition-colors hover:bg-[#FBF3D5]">{formatClosedDate(date)}<X aria-hidden="true" size={16} /></button></li>)}</ul> : <p className="mt-2 text-sm text-[#4A5365]">No closed dates.</p>}</fieldset>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1 text-sm font-bold text-[#20242F]"><span>{label}</span>{children}</label>
}

const inputClass = 'min-h-11 w-full rounded-xl border border-[#4F74C8]/30 bg-white px-3 text-[#20242F] outline-none transition-colors focus:border-[#4F74C8] focus:ring-2 focus:ring-[#4F74C8]/25'

export function SettingsFeature({ adapter }: { adapter: StorageAdapter }) {
  const [settings, setSettings] = useState<DashboardSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void loadDashboardSettings(adapter).then((loaded) => { if (active) setSettings(loaded) }).catch(() => { if (active) setError('Settings could not be loaded.') })
    const unsubscribe = adapter.subscribe((change) => {
      if (change.collection === 'settings' && 'key' in change.entity && change.entity.key === 'order_dashboard_settings') {
        void loadDashboardSettings(adapter).then((loaded) => { if (active) setSettings(loaded) }).catch(() => undefined)
      }
    })
    return () => { active = false; unsubscribe() }
  }, [adapter])

  if (error) return <p role="alert" className="motion-fade-in rounded-2xl bg-red-50 p-4 font-semibold text-red-700">{error}</p>
  if (!settings) return <section aria-busy="true"><h1 className="text-3xl font-black tracking-tight text-[#20242F]">Settings</h1><p className="motion-fade-in mt-4 text-sm font-semibold text-[#4A5365]">Loading business settings…</p></section>

  const update = (patch: Partial<DashboardSettings>) => { setSettings((current) => current ? { ...current, ...patch } : current); setMessage(null) }
  const updateProduct = (slug: ProductSlug, patch: { price?: string; available?: boolean }) => {
    if (patch.available === false && !window.confirm('Hide this product from the order form and new orders? Existing orders will remain unchanged.')) return
    update({
      productBasePrices: { ...settings.productBasePrices, ...(patch.price === undefined ? {} : { [slug]: toCentavos(patch.price, settings.productBasePrices[slug]) }) },
      productAvailability: { ...settings.productAvailability, ...(patch.available === undefined ? {} : { [slug]: patch.available }) },
    })
  }
  const save = async () => {
    setSaving(true); setError(null); setMessage(null)
    try { setSettings(await saveDashboardSettings(adapter, settings)); setMessage('Saved. New orders, the order form, and delivery days now use these settings.') }
    catch (cause) { setError(`Settings could not be saved. Your changes are still on this screen. (${cause instanceof Error ? cause.message : String(cause)})`) }
    finally { setSaving(false) }
  }
  const updateOpenDay = (day: OpenDay, checked: boolean) => update({ openDays: checked ? [...settings.openDays, day] : settings.openDays.filter((entry) => entry !== day) })

  return <section className="min-w-0 space-y-5" aria-labelledby="settings-heading">
    <header className="motion-fade-up"><h1 id="settings-heading" className="text-3xl font-black tracking-tight text-[#20242F]">Settings</h1><p className="mt-1.5 text-sm leading-6 text-[#4A5365]">Owner controls — menu prices are applied deterministically. Submitted or imported prices are never trusted.</p></header>
    {message && <p role="status" className="motion-fade-in flex gap-2 rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-800"><Check aria-hidden="true" size={18} />{message}</p>}
    {error && <p role="alert" className="motion-fade-in rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-800">{error}</p>}
    <section className="rounded-2xl border border-[#4F74C8]/20 bg-white p-4 shadow-sm"><h2 className="text-lg font-black">Business display</h2><div className="mt-4 grid gap-3"><Field label="Business name"><input className={inputClass} value={settings.businessName} onChange={(event) => update({ businessName: event.target.value })} /></Field><Field label="Short description"><input className={inputClass} value={settings.businessDescription} onChange={(event) => update({ businessDescription: event.target.value })} /></Field><Field label="Owner contact"><input className={inputClass} value={settings.businessContact} onChange={(event) => update({ businessContact: event.target.value })} placeholder="Optional phone or email" /></Field><Field label="GCash number"><input className={inputClass} value={settings.gCashNumber} onChange={(event) => update({ gCashNumber: event.target.value })} placeholder="Owner entry required" inputMode="tel" aria-describedby="gcash-help" /></Field><p id="gcash-help" className={`text-sm ${settings.gCashNumber ? 'text-[#4A5365]' : 'font-semibold text-amber-800'}`}>{settings.gCashNumber ? 'Shown only where your payment instructions use it.' : 'GCash number is blank — owner entry required before sharing payment instructions.'}</p></div></section>
    <section className="rounded-2xl border border-[#4F74C8]/20 bg-white p-4 shadow-sm"><h2 className="text-lg font-black">Fulfillment</h2><fieldset className="mt-4"><legend className="text-sm font-bold text-[#20242F]">Open days</legend><div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">{weekdayRows.map(({ day, label }) => <label key={day} className="flex min-h-11 items-center gap-2 rounded-xl border border-[#4F74C8]/20 px-3 text-sm font-semibold"><input type="checkbox" checked={settings.openDays.includes(day)} onChange={(event) => updateOpenDay(day, event.target.checked)} />{label}</label>)}</div></fieldset><ClosedDatesField closedDates={settings.closedDates} onChange={(closedDates) => update({ closedDates })} /><div className="mt-4 grid gap-3 sm:grid-cols-3"><Field label="Order cutoff (Asia/Manila)"><input className={inputClass} type="time" value={settings.orderCutoff} onChange={(event) => update({ orderCutoff: event.target.value })} /></Field><Field label="Delivery window starts"><input className={inputClass} type="time" value={settings.deliveryWindowStart} onChange={(event) => update({ deliveryWindowStart: event.target.value })} /></Field><Field label="Delivery window ends"><input className={inputClass} type="time" value={settings.deliveryWindowEnd} onChange={(event) => update({ deliveryWindowEnd: event.target.value })} /></Field></div><p className="mt-3 text-sm text-[#4A5365]">Following morning delivery · Asia/Manila</p></section>
    <section className="rounded-2xl border border-[#4F74C8]/20 bg-white p-4 shadow-sm"><h2 className="text-lg font-black">Products</h2><p className="mt-1 text-sm text-[#4A5365]">Turn a product off to remove it from the order form and new orders. This does not change historical orders.</p><div className="mt-4 space-y-3">{productSettingRows.map(({ slug, name }) => <div key={slug} className="grid gap-2 rounded-xl border border-[#4F74C8]/15 p-3 sm:grid-cols-[1fr_9rem_auto] sm:items-end"><Field label={name}><span className="relative block"><span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#4A5365]">₱</span><input aria-label={`${name} base price`} className={`${inputClass} pl-7`} type="number" min="0" step="1" value={phpInputValue(settings.productBasePrices[slug])} onChange={(event) => updateProduct(slug, { price: event.target.value })} /></span></Field><label className="flex min-h-11 items-center gap-2 rounded-xl border border-[#4F74C8]/20 px-3 text-sm font-bold"><input aria-label={`${name} availability`} type="checkbox" checked={settings.productAvailability[slug]} onChange={(event) => updateProduct(slug, { available: event.target.checked })} />Available</label></div>)}</div></section>
    <section className="rounded-2xl border border-[#4F74C8]/20 bg-white p-4 shadow-sm"><h2 className="text-lg font-black">Upcharges</h2><div className="mt-4 grid gap-4 sm:grid-cols-2"><UpchargeGroup title="Matcha levels" values={settings.matchaLevelUpcharges} onChange={(level, value) => update({ matchaLevelUpcharges: { ...settings.matchaLevelUpcharges, [level]: toCentavos(value, settings.matchaLevelUpcharges[level]) } })} /><UpchargeGroup title="Hojicha levels" values={settings.hojichaLevelUpcharges} onChange={(level, value) => update({ hojichaLevelUpcharges: { ...settings.hojichaLevelUpcharges, [level]: toCentavos(value, settings.hojichaLevelUpcharges[level]) } })} /></div><div className="mt-4 grid gap-3 sm:grid-cols-2"><MoneyField label="MK Isuzu powder" value={settings.powderUpcharges.mk_isuzu} onChange={(value) => update({ powderUpcharges: { ...settings.powderUpcharges, mk_isuzu: toCentavos(value, settings.powderUpcharges.mk_isuzu) } })} /><MoneyField label="Yumeno powder" value={settings.powderUpcharges.yumeno} onChange={(value) => update({ powderUpcharges: { ...settings.powderUpcharges, yumeno: toCentavos(value, settings.powderUpcharges.yumeno) } })} /></div></section>
    <section className="rounded-2xl border border-[#4F74C8]/20 bg-white p-4 shadow-sm"><h2 className="text-lg font-black">Thermal bags</h2><div className="mt-4 grid gap-3 sm:grid-cols-3"><MoneyField label="1 cup" value={settings.thermalBagPrices[1]} onChange={(value) => update({ thermalBagPrices: { ...settings.thermalBagPrices, 1: toCentavos(value, settings.thermalBagPrices[1]) } })} /><MoneyField label="2 cups" value={settings.thermalBagPrices[2]} onChange={(value) => update({ thermalBagPrices: { ...settings.thermalBagPrices, 2: toCentavos(value, settings.thermalBagPrices[2]) } })} /><MoneyField label="3–4 cups" value={settings.thermalBagPrices[3]} onChange={(value) => { const amount = toCentavos(value, settings.thermalBagPrices[3]); update({ thermalBagPrices: { ...settings.thermalBagPrices, 3: amount, 4: amount } }) }} /></div></section>
    <button type="button" disabled={saving} onClick={() => void save()} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#4F74C8] px-4 font-bold text-white shadow-sm transition duration-200 hover:bg-[#365aa8] active:scale-[0.98] motion-safe:transition-transform disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100"><Save aria-hidden="true" size={18} />{saving ? <><LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" size={18} />Saving settings…</> : 'Save settings'}</button>
    <p className="flex gap-2 rounded-xl border border-[#4F74C8]/20 bg-[#FBF3D5]/60 p-3 text-sm text-[#4A5365]"><AlertTriangle aria-hidden="true" className="shrink-0 text-[#4F74C8]" size={18} />Pricing changes apply to new orders. Existing orders retain their recorded totals.</p>
    <Link to="/settings/import-history" className="flex min-h-11 items-center justify-center gap-2 rounded-xl text-sm font-semibold text-[#4A5365] underline-offset-4 hover:text-[#365AA9] hover:underline"><History aria-hidden="true" size={16} />Import history (one-time)</Link>
  </section>
}

function MoneyField({ label, value, onChange }: { label: string; value: number; onChange: (value: string) => void }) {
  return <Field label={label}><span className="relative block"><span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#4A5365]">₱</span><input className={`${inputClass} pl-7`} type="number" min="0" step="1" value={phpInputValue(value)} onChange={(event) => onChange(event.target.value)} /></span></Field>
}

function UpchargeGroup({ title, values, onChange }: { title: string; values: Readonly<Record<1 | 2 | 3, number>>; onChange: (level: 1 | 2 | 3, value: string) => void }) {
  return <fieldset><legend className="text-sm font-bold text-[#20242F]">{title}</legend><div className="mt-2 grid grid-cols-3 gap-2">{([1, 2, 3] as const).map((level) => <MoneyField key={level} label={`L${level}`} value={values[level]} onChange={(value) => onChange(level, value)} />)}</div></fieldset>
}
