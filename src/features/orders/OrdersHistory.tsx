import { Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { StorageAdapter, StoredOrder } from '../../data/types'
import { getRelevantDeliveryDate } from '../../domain/delivery-schedule'
import { useDashboardSettings } from '../settings/useDashboardSettings'
import { OrderEditorModal } from '../order-editor/OrderEditorModal'
import { blankImportDraft, storedOrderToImportDraft } from '../order-editor/orderDraftMapping'
import { OrderCard } from './OrderCard'
import { customerFor } from './order-display'
import { operationalStatuses, statusLabels } from './orderLifecycle'
import { useOrderActions } from './useOrderActions'
import { useOrdersData } from './useOrdersData'

type OrdersHistoryProps = { adapter?: StorageAdapter }

type EditorState = { mode: 'create' } | { mode: 'edit'; order: StoredOrder }

export function OrdersHistory({ adapter: providedAdapter }: OrdersHistoryProps) {
  const { adapter, customers, orders, loading, error } = useOrdersData(providedAdapter)
  const { settings } = useDashboardSettings(adapter)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'all' | (typeof operationalStatuses)[number]>('all')
  const [deliveryDate, setDeliveryDate] = useState('')
  const [editorState, setEditorState] = useState<EditorState | null>(null)
  const { busyOrderId, advance, cancel, deleteOrder } = useOrderActions(adapter)

  const visibleOrders = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return orders
      .filter((order) => status === 'all' || order.status === status)
      .filter((order) => !deliveryDate || order.deliveryDate === deliveryDate)
      .filter((order) => {
        if (!normalizedQuery) return true
        const customer = customerFor(customers, order)
        return [customer?.name, customer?.phone, order.addressSnapshot, order.notes, order.id]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }, [customers, deliveryDate, orders, query, status])

  return (
    <section className="min-w-0">
      <header className="motion-fade-up">
        <h1 className="text-3xl font-black tracking-tight text-[#20242F]">Orders</h1>
        <p className="mt-1.5 text-sm text-[#4A5365]">All delivery dates · search, review, and update your order history.</p>
      </header>

      <button
        type="button"
        disabled={!adapter}
        onClick={() => setEditorState({ mode: 'create' })}
        className="mt-4 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#4F74C8] px-4 text-sm font-bold text-white shadow-sm transition duration-200 hover:bg-[#365AA9] active:scale-[0.98] motion-safe:transition-transform disabled:opacity-50 disabled:active:scale-100"
      >
        <Plus size={16} /> New order
      </button>

      <div className="mt-5 grid gap-3 rounded-2xl border border-[#4F74C8]/20 bg-white/60 p-3">
        <label className="grid gap-1 text-sm font-semibold text-[#20242F]">
          Search orders
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Customer, address, or phone" className="min-w-0 rounded-xl border border-[#4F74C8]/30 bg-white px-3 py-2 text-[#20242F] transition-colors focus:border-[#4F74C8]" />
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm font-semibold text-[#20242F]">
            Status
            <select aria-label="Status filter" value={status} onChange={(event) => setStatus(event.target.value as typeof status)} className="rounded-xl border border-[#4F74C8]/30 bg-white px-3 py-2 text-[#20242F] transition-colors focus:border-[#4F74C8]">
              <option value="all">All statuses</option>
              {operationalStatuses.map((value) => <option key={value} value={value}>{statusLabels[value]}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-semibold text-[#20242F]">
            Delivery date
            <input aria-label="Delivery date filter" type="date" value={deliveryDate} onChange={(event) => setDeliveryDate(event.target.value)} className="rounded-xl border border-[#4F74C8]/30 bg-white px-3 py-2 text-[#20242F] transition-colors focus:border-[#4F74C8]" />
          </label>
        </div>
      </div>

      {loading && (
        <div className="mt-6 space-y-3" aria-hidden="true">
          {[0, 1, 2].map((key) => <div key={key} className="h-24 animate-pulse rounded-2xl border border-[#4F74C8]/15 bg-white/60" />)}
          <p className="sr-only" role="status">Loading orders…</p>
        </div>
      )}
      {error && <p role="alert" className="motion-fade-in mt-6 rounded-xl bg-rose-100 p-3 text-sm text-rose-900">{error.message}</p>}
      {!loading && !error && (
        <div className="motion-fade-in mt-5 space-y-3" aria-label="Order history">
          <p className="text-sm font-semibold text-[#4A5365]">{visibleOrders.length} {visibleOrders.length === 1 ? 'order' : 'orders'}</p>
          {visibleOrders.map((order) => (
            <div key={order.id}>
              <p className="mb-1 px-1 text-xs font-bold uppercase tracking-[0.1em] text-[#697386]">{order.deliveryDate ?? 'No delivery date'} · {statusLabels[order.status]}</p>
              <OrderCard order={order} customer={customerFor(customers, order)} busy={busyOrderId === order.id} onAdvance={advance} onCancel={cancel} onEdit={(current) => setEditorState({ mode: 'edit', order: current })} onDelete={deleteOrder} />
            </div>
          ))}
          {visibleOrders.length === 0 && <p className="rounded-xl border border-dashed border-[#4F74C8]/25 bg-white/40 p-4 text-sm text-[#4A5365]">No orders match these filters.</p>}
        </div>
      )}

      {adapter && editorState && (
        <OrderEditorModal
          adapter={adapter}
          customers={customers}
          orders={orders}
          editingOrder={editorState.mode === 'edit' ? editorState.order : null}
          initialDraft={editorState.mode === 'edit' ? storedOrderToImportDraft(editorState.order, customerFor(customers, editorState.order)?.name ?? null) : blankImportDraft(getRelevantDeliveryDate(new Date(), settings))}
          title={editorState.mode === 'edit' ? 'Edit order' : 'New order'}
          onClose={() => setEditorState(null)}
          onSaved={() => setEditorState(null)}
        />
      )}
    </section>
  )
}
