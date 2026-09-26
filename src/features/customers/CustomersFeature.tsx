import { ArrowLeft, ChevronRight, Plus, Save, Search, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import type { StorageAdapter, StoredCustomer, StoredOrder } from '../../data/types'
import { OrderEditorModal } from '../order-editor/OrderEditorModal'
import { storedOrderToImportDraft } from '../order-editor/orderDraftMapping'
import { getRelevantDeliveryDate } from '../../domain/delivery-schedule'
import { useDashboardSettings } from '../settings/useDashboardSettings'
import { formatCupNames } from '../import/cup-names'
import { formatPhp } from '../orders/order-display'
import { lifecycleTimestampLines } from '../orders/order-timestamps'
import { loadCustomerProfile, saveCustomerProfile, type CustomerProfile } from './customer-profile'
import { getCustomerSummaries, type CustomerSummary } from './customer-stats'
import { deleteCustomerCascade } from './deleteCustomerCascade'

type CustomersFeatureProps = { adapter: StorageAdapter }

function formatDate(order: StoredOrder | null): string {
  if (!order?.deliveryDate) return 'No delivery date'
  return new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeZone: 'Asia/Manila' })
    .format(new Date(`${order.deliveryDate}T12:00:00+08:00`))
}

function statusLabel(status: StoredOrder['status']): string {
  return status.replaceAll('_', ' ')
}

function CustomerList({ summaries }: { summaries: readonly CustomerSummary[] }) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return summaries
    return summaries.filter(({ customer, favoriteDrink, addressSummary }) =>
      [customer.name, customer.phone ?? '', favoriteDrink ?? '', addressSummary ?? '']
        .some((value) => value.toLocaleLowerCase().includes(normalized)),
    )
  }, [query, summaries])

  return (
    <section aria-labelledby="customers-heading">
      <div className="motion-fade-up mb-5 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 id="customers-heading" className="text-3xl font-black tracking-tight text-[#20242F]">Customers</h1>
          <p className="mt-1.5 text-sm text-[#4A5365]">Delivery contacts and order history.</p>
        </div>
        <p className="mb-1 shrink-0 text-sm font-semibold text-[#4A5365]">{summaries.length} total</p>
      </div>
      <label className="mb-4 flex min-h-12 items-center gap-2 rounded-2xl border border-[#4F74C8]/30 bg-white px-3 shadow-sm transition-colors focus-within:border-[#4F74C8]" htmlFor="customer-search">
        <Search aria-hidden="true" size={19} className="shrink-0 text-[#4F74C8]" />
        <span className="sr-only">Search customers</span>
        <input
          id="customer-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search name, drink, or address"
          className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-[#4A5365]/70"
        />
      </label>
      <div className="motion-fade-in space-y-3" aria-live="polite">
        {filtered.map((summary) => (
          <Link
            key={summary.customer.id}
            to={`/customers?customer=${encodeURIComponent(summary.customer.id)}`}
            className="flex min-w-0 items-center gap-3 rounded-2xl border border-[#4F74C8]/20 bg-white p-4 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-[#4F74C8]/60 hover:shadow-md active:translate-y-0 motion-safe:transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4F74C8]"
            aria-label={`View ${summary.customer.name}`}
          >
            <span className="grid size-11 shrink-0 place-items-center rounded-full bg-[#4F74C8]/12 text-lg font-black text-[#4F74C8]">{summary.customer.name.slice(0, 1)}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-bold text-[#20242F]">{summary.customer.name}</span>
              <span className="mt-1 block text-sm text-[#4A5365]">{summary.orderCount} non-cancelled {summary.orderCount === 1 ? 'order' : 'orders'} · {summary.favoriteDrink ?? 'No favorite yet'}</span>
              <span className="mt-1 block truncate text-xs text-[#4A5365]">{summary.addressSummary ?? 'No saved address'} · Last: {formatDate(summary.lastOrder)}</span>
            </span>
            <ChevronRight aria-hidden="true" size={20} className="shrink-0 text-[#4F74C8]" />
          </Link>
        ))}
        {filtered.length === 0 && <p className="rounded-2xl border border-dashed border-[#4F74C8]/35 p-5 text-center text-sm text-[#4A5365]">No customers match that search.</p>}
      </div>
    </section>
  )
}

function CustomerDetail({ adapter, summary, orders, customers }: { adapter: StorageAdapter; summary: CustomerSummary; orders: StoredOrder[]; customers: StoredCustomer[] }) {
  const navigate = useNavigate()
  const [profile, setProfile] = useState<CustomerProfile>({ notes: '', address: summary.addressSummary ?? '', preferences: '' })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [name, setName] = useState(summary.customer.name)
  const [phone, setPhone] = useState(summary.customer.phone ?? '')
  const [savingContact, setSavingContact] = useState(false)
  const [contactSaved, setContactSaved] = useState(false)

  const [deleteStep, setDeleteStep] = useState<0 | 1 | 2>(0)
  const [deleting, setDeleting] = useState(false)

  const [repeatOrderOpen, setRepeatOrderOpen] = useState(false)
  const { settings } = useDashboardSettings(adapter)

  const customerOrders = useMemo(
    () => orders.filter((order) => order.customerId === summary.customer.id).sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [orders, summary.customer.id],
  )

  useEffect(() => {
    let active = true
    void loadCustomerProfile(adapter, summary.customer.id)
      .then((stored) => {
        if (active) setProfile({ ...stored, address: stored.address || summary.addressSummary || '' })
      })
      .catch(() => { if (active) setLoadError('Customer details could not be loaded.') })
    return () => { active = false }
  }, [adapter, summary.addressSummary, summary.customer.id])

  useEffect(() => {
    setName(summary.customer.name)
    setPhone(summary.customer.phone ?? '')
  }, [summary.customer.id, summary.customer.name, summary.customer.phone])

  async function handleSave(): Promise<void> {
    setSaving(true)
    setSaved(false)
    try {
      await saveCustomerProfile(adapter, summary.customer.id, profile)
      setSaved(true)
    } catch {
      setLoadError('Customer details could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  async function handleSaveContact(): Promise<void> {
    setSavingContact(true)
    setContactSaved(false)
    try {
      await adapter.updateCustomer(summary.customer.id, { name: name.trim() || summary.customer.name, phone: phone.trim() ? phone.trim() : null })
      setContactSaved(true)
    } catch {
      setLoadError('Customer contact details could not be saved.')
    } finally {
      setSavingContact(false)
    }
  }

  async function handleDeleteCustomer(): Promise<void> {
    setDeleting(true)
    try {
      await deleteCustomerCascade(adapter, summary.customer.id)
      navigate('/customers')
    } catch {
      setLoadError('Customer could not be deleted.')
      setDeleting(false)
      setDeleteStep(0)
    }
  }

  return (
    <section aria-labelledby="customer-name">
      <Link to="/customers" className="mb-5 inline-flex min-h-11 items-center gap-2 rounded-xl px-2 text-sm font-bold text-[#4F74C8] transition-colors duration-200 hover:bg-[#4F74C8]/10">
        <ArrowLeft aria-hidden="true" size={19} /> All customers
      </Link>
      <div className="motion-fade-up rounded-3xl bg-[#4F74C8] p-5 text-white shadow-sm">
        <p className="text-xs font-semibold text-white/75">Customer profile</p>
        <h1 id="customer-name" className="mt-1 break-words text-3xl font-black">{summary.customer.name}</h1>
        <p className="mt-2 text-sm text-white/85">{summary.customer.phone ?? 'No phone number'} · {summary.orderCount} non-cancelled {summary.orderCount === 1 ? 'order' : 'orders'}</p>
        <p className="mt-3 rounded-xl bg-white/15 px-3 py-2 text-sm font-semibold">Favorite drink: {summary.favoriteDrink ?? 'Not enough order data'}</p>
        {summary.lastOrder && (
          <button type="button" onClick={() => setRepeatOrderOpen(true)} className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-white/15 px-4 text-sm font-bold text-white transition duration-200 hover:bg-white/25 active:scale-[0.98] motion-safe:transition-transform">
            <Plus aria-hidden="true" size={16} /> Repeat last order
          </button>
        )}
      </div>

      <div className="motion-fade-in mt-5 space-y-4">
        <section className="rounded-2xl border border-[#4F74C8]/20 bg-white p-4 shadow-sm" aria-labelledby="customer-contact-heading">
          <div className="flex items-center justify-between gap-3">
            <h2 id="customer-contact-heading" className="text-lg font-black">Contact info</h2>
            {contactSaved && <span role="status" className="motion-fade-in text-sm font-bold text-[#356247]">Saved</span>}
          </div>
          <div className="mt-3 space-y-3">
            <label className="block text-sm font-bold text-[#20242F]">Name
              <input value={name} onChange={(event) => setName(event.target.value)} className="mt-1 block w-full rounded-xl border border-[#4F74C8]/30 bg-[#FBF3D5]/35 p-3 font-normal outline-none transition-colors focus:border-[#4F74C8]" placeholder="Customer name" />
            </label>
            <label className="block text-sm font-bold text-[#20242F]">Phone
              <input value={phone} onChange={(event) => setPhone(event.target.value)} className="mt-1 block w-full rounded-xl border border-[#4F74C8]/30 bg-[#FBF3D5]/35 p-3 font-normal outline-none transition-colors focus:border-[#4F74C8]" placeholder="09XXXXXXXXX" />
            </label>
            <button type="button" onClick={() => void handleSaveContact()} disabled={savingContact || !name.trim()} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[#4F74C8] px-4 text-sm font-bold text-white transition duration-200 hover:bg-[#365AA9] active:scale-[0.98] motion-safe:transition-transform disabled:opacity-60 disabled:active:scale-100">
              <Save aria-hidden="true" size={17} /> {savingContact ? 'Saving…' : 'Save contact info'}
            </button>
          </div>
        </section>

        <section className="rounded-2xl border border-[#4F74C8]/20 bg-white p-4 shadow-sm" aria-labelledby="customer-details-heading">
          <div className="flex items-center justify-between gap-3">
            <h2 id="customer-details-heading" className="text-lg font-black">Saved details</h2>
            {saved && <span role="status" className="motion-fade-in text-sm font-bold text-[#356247]">Saved</span>}
          </div>
          <div className="mt-3 space-y-3">
            <label className="block text-sm font-bold text-[#20242F]">Address
              <textarea value={profile.address} onChange={(event) => setProfile({ ...profile, address: event.target.value })} rows={2} className="mt-1 block w-full resize-y rounded-xl border border-[#4F74C8]/30 bg-[#FBF3D5]/35 p-3 font-normal outline-none transition-colors focus:border-[#4F74C8]" placeholder="Delivery address" />
            </label>
            <label className="block text-sm font-bold text-[#20242F]">Notes
              <textarea value={profile.notes} onChange={(event) => setProfile({ ...profile, notes: event.target.value })} rows={3} className="mt-1 block w-full resize-y rounded-xl border border-[#4F74C8]/30 bg-[#FBF3D5]/35 p-3 font-normal outline-none transition-colors focus:border-[#4F74C8]" placeholder="Helpful service notes" />
            </label>
            <label className="block text-sm font-bold text-[#20242F]">Saved preferences
              <textarea value={profile.preferences} onChange={(event) => setProfile({ ...profile, preferences: event.target.value })} rows={2} className="mt-1 block w-full resize-y rounded-xl border border-[#4F74C8]/30 bg-[#FBF3D5]/35 p-3 font-normal outline-none transition-colors focus:border-[#4F74C8]" placeholder="Sweetness, pickup, or delivery preferences" />
            </label>
            <button type="button" onClick={() => void handleSave()} disabled={saving} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[#4F74C8] px-4 text-sm font-bold text-white transition duration-200 hover:bg-[#365AA9] active:scale-[0.98] motion-safe:transition-transform disabled:opacity-60 disabled:active:scale-100">
              <Save aria-hidden="true" size={17} /> {saving ? 'Saving…' : 'Save details'}
            </button>
            {loadError && <p role="alert" className="motion-fade-in text-sm font-semibold text-red-700">{loadError}</p>}
          </div>
        </section>

        <section aria-labelledby="order-history-heading">
          <h2 id="order-history-heading" className="mb-3 text-lg font-black">Order history</h2>
          <div className="space-y-3">
            {customerOrders.map((order) => (
              <article key={order.id} className="rounded-2xl border border-[#4F74C8]/20 bg-white p-4 shadow-sm transition-shadow duration-200 hover:shadow-md">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0"><p className="font-bold">{formatDate(order)}</p><p className="mt-1 text-sm capitalize text-[#4A5365]">{statusLabel(order.status)}</p></div>
                  <p className="shrink-0 font-black text-[#4F74C8]">{formatPhp(order.totalCentavos)}</p>
                </div>
                <ul className="mt-3 space-y-1 text-sm text-[#4A5365]">
                  {order.items.map((item) => <li key={item.id}>{item.quantity}× {item.productName}{formatCupNames(item.modifiers.cupNames) && <span className="text-[#36579E]"> · {formatCupNames(item.modifiers.cupNames)}</span>}</li>)}
                </ul>
                {lifecycleTimestampLines(order).map((line) => (
                  <p key={line} className="mt-1 text-sm text-[#4A5365]">{line}</p>
                ))}
              </article>
            ))}
            {customerOrders.length === 0 && <p className="rounded-2xl border border-dashed border-[#4F74C8]/35 p-4 text-sm text-[#4A5365]">No order history yet.</p>}
          </div>
        </section>

        <section className="rounded-2xl border border-rose-300/60 bg-rose-50 p-4" aria-labelledby="danger-zone-heading">
          <h2 id="danger-zone-heading" className="text-lg font-black text-rose-900">Danger zone</h2>
          <p className="mt-1 text-sm text-rose-800">Deletes this customer and all of their orders permanently.</p>
          {deleteStep === 0 && (
            <button type="button" onClick={() => setDeleteStep(1)} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl border border-rose-400 px-4 text-sm font-bold text-rose-800 transition-colors duration-200 hover:bg-rose-100">
              <Trash2 aria-hidden="true" size={16} /> Delete customer
            </button>
          )}
          {deleteStep === 1 && (
            <div role="alert" className="motion-fade-up mt-3 rounded-xl bg-rose-100 p-3 text-sm text-rose-950">
              <p>Delete {summary.customer.name} and their {customerOrders.length} {customerOrders.length === 1 ? 'order' : 'orders'}? This cannot be undone.</p>
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={() => setDeleteStep(2)} className="rounded-lg bg-rose-700 px-3 py-1.5 font-bold text-white transition duration-200 hover:bg-rose-800 active:scale-[0.97] motion-safe:transition-transform">Continue</button>
                <button type="button" onClick={() => setDeleteStep(0)} className="rounded-lg px-3 py-1.5 font-semibold text-[#36579E] transition-colors duration-200 hover:bg-black/5">Cancel</button>
              </div>
            </div>
          )}
          {deleteStep === 2 && (
            <div role="alert" className="motion-fade-up mt-3 rounded-xl bg-rose-100 p-3 text-sm text-rose-950">
              <p>This is permanent. Delete {summary.customer.name} permanently?</p>
              <div className="mt-2 flex gap-2">
                <button type="button" disabled={deleting} onClick={() => void handleDeleteCustomer()} className="rounded-lg bg-rose-700 px-3 py-1.5 font-bold text-white transition duration-200 hover:bg-rose-800 active:scale-[0.97] motion-safe:transition-transform disabled:opacity-50">Yes, delete permanently</button>
                <button type="button" disabled={deleting} onClick={() => setDeleteStep(0)} className="rounded-lg px-3 py-1.5 font-semibold text-[#36579E] transition-colors duration-200 hover:bg-black/5 disabled:opacity-50">Cancel</button>
              </div>
            </div>
          )}
        </section>
      </div>

      {repeatOrderOpen && summary.lastOrder && (
        <OrderEditorModal
          adapter={adapter}
          customers={customers}
          orders={orders}
          editingOrder={null}
          initialDraft={{ ...storedOrderToImportDraft(summary.lastOrder, summary.customer.name), deliveryDate: getRelevantDeliveryDate(new Date(), settings), rawSource: `Repeat of order ${summary.lastOrder.id}` }}
          title="Repeat last order"
          onClose={() => setRepeatOrderOpen(false)}
          onSaved={() => setRepeatOrderOpen(false)}
        />
      )}
    </section>
  )
}

export function CustomersFeature({ adapter }: CustomersFeatureProps) {
  const [summaries, setSummaries] = useState<CustomerSummary[] | null>(null)
  const [customers, setCustomers] = useState<StoredCustomer[]>([])
  const [orders, setOrders] = useState<StoredOrder[]>([])
  const [error, setError] = useState<string | null>(null)
  const [searchParams] = useSearchParams()
  const customerId = searchParams.get('customer')

  useEffect(() => {
    let active = true
    async function load(): Promise<void> {
      try {
        const [loadedCustomers, loadedOrders] = await Promise.all([adapter.listCustomers(), adapter.listOrders()])
        if (active) {
          setSummaries(getCustomerSummaries(loadedCustomers, loadedOrders))
          setCustomers(loadedCustomers)
          setOrders(loadedOrders)
        }
      } catch {
        if (active) setError('Customers could not be loaded.')
      }
    }
    void load()
    const unsubscribe = adapter.subscribe(() => { void load() })
    return () => { active = false; unsubscribe() }
  }, [adapter])

  if (error) return <p role="alert" className="motion-fade-in rounded-2xl bg-red-50 p-4 font-semibold text-red-700">{error}</p>
  if (!summaries) return <section><h1 className="text-3xl font-black tracking-tight text-[#20242F]">Customers</h1><p className="motion-fade-in pt-4 text-sm font-semibold text-[#4A5365]">Loading customers…</p></section>
  const selected = summaries.find((summary) => summary.customer.id === customerId)
  if (customerId && selected) return <CustomerDetail adapter={adapter} summary={selected} orders={orders} customers={customers} />
  return <CustomerList summaries={summaries} />
}
