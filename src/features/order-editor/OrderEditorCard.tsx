import { LoaderCircle, Plus, Trash2 } from 'lucide-react'
import { useMemo } from 'react'
import { getRuntimeCatalog } from '../../domain/catalog'
import type { StoredCustomer, StoredOrder } from '../../data/types'
import { applyCustomerMatch } from '../import/customer-matching'
import { validateDraft } from '../import/parser'
import type { ImportDraft } from '../import/types'
import { MAX_CUP_NAME_LENGTH, padCupNames } from '../import/cup-names'
import { formatPhp } from '../orders/order-display'
import { blankBag, blankItem, setCupName, updateItem } from './order-draft-helpers'

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="block text-xs font-bold uppercase tracking-[0.12em] text-[#4A5365]">{children}</label>
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`mt-1 min-h-11 w-full rounded-xl border border-[#4F74C8]/25 bg-white px-3 text-sm text-[#20242f] outline-none transition-colors focus:border-[#4F74C8] focus:ring-2 focus:ring-[#4F74C8]/20 ${props.className ?? ''}`} />
}

function SelectInput(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`mt-1 min-h-11 w-full rounded-xl border border-[#4F74C8]/25 bg-white px-3 text-sm text-[#20242f] outline-none transition-colors focus:border-[#4F74C8] focus:ring-2 focus:ring-[#4F74C8]/20 ${props.className ?? ''}`} />
}

export function OrderEditorCard({ draft, customers, orders, confirming, onChange, onConfirm, hideDeliveryDate = false }: {
  draft: ImportDraft
  customers: StoredCustomer[]
  orders: StoredOrder[]
  confirming: boolean
  onChange: (draft: ImportDraft) => void
  onConfirm: () => void
  /** Set when the caller renders its own constrained delivery-day control. */
  hideDeliveryDate?: boolean
}) {
  const catalog = getRuntimeCatalog()
  // `catalog` reads as redundant to the linter, but it is load-bearing.
  // getRuntimeCatalog() returns a fresh object on every call, so naming it here
  // re-runs validateDraft on every render — which is how a price the owner edits
  // in Settings reaches an order editor that is already mounted. Dropping the
  // dependency was tried and reverted; catalog-memo.test.tsx pins the behaviour.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  const validation = useMemo(() => validateDraft(draft), [draft, catalog])
  const mutate = (next: ImportDraft) => onChange(applyCustomerMatch(next, customers, orders))
  return (
    <article className="rounded-2xl border border-[#4F74C8]/20 bg-[#FFFDF6] p-4 shadow-sm">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div><h2 className="font-semibold text-[#20242f]">Editable order draft</h2><p className="mt-0.5 text-xs text-[#4A5365]">Source confidence: {draft.sourceConfidence === null ? 'not supplied' : `${Math.round(draft.sourceConfidence * 100)}%`}</p></div>
        <span className="shrink-0 rounded-full bg-[#4F74C8]/10 px-2.5 py-1 text-xs font-bold text-[#365aa8] transition-colors duration-200">{validation.totalCentavos === null ? 'Needs review' : formatPhp(validation.totalCentavos)}</span>
      </div>
      {validation.errors.length > 0 && <div role="alert" className="motion-fade-in mb-3 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800"><strong>Resolve before confirming</strong><ul className="mt-1 list-disc pl-5">{validation.errors.map((error) => <li key={error}>{error}</li>)}</ul></div>}
      {validation.warnings.map((warning) => <div key={warning} className="motion-fade-in mb-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{warning}</div>)}
      <div className="grid gap-3 sm:grid-cols-2">
        <FieldLabel>Customer name<TextInput aria-label="Customer name" value={draft.customerName ?? ''} onChange={(event) => mutate({ ...draft, customerName: event.target.value || null })} /></FieldLabel>
        <FieldLabel>Matched customer<SelectInput aria-label="Matched customer" value={draft.matchedCustomerId ?? ''} onChange={(event) => onChange({ ...draft, matchedCustomerId: event.target.value || null })}><option value="">Create new customer</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</SelectInput></FieldLabel>
        {!hideDeliveryDate && <FieldLabel>Delivery date<TextInput aria-label="Delivery date" type="date" value={draft.deliveryDate ?? ''} onChange={(event) => onChange({ ...draft, deliveryDate: event.target.value || null })} /></FieldLabel>}
        <FieldLabel>Address<TextInput aria-label="Address" value={draft.address ?? ''} onChange={(event) => onChange({ ...draft, address: event.target.value || null })} /></FieldLabel>
      </div>
      <FieldLabel><span className="mt-3 block">Notes</span><TextInput aria-label="Notes" value={draft.notes ?? ''} onChange={(event) => onChange({ ...draft, notes: event.target.value || null })} /></FieldLabel>
      <div className="mt-5 space-y-3"><div className="flex items-center justify-between"><h3 className="font-semibold">Drinks</h3><button type="button" className="rounded-lg px-2 py-1 text-sm font-semibold text-[#365aa8] transition-colors duration-200 hover:bg-[#4F74C8]/10" onClick={() => onChange({ ...draft, items: [...draft.items, blankItem()] })}><Plus className="mr-1 inline" size={15} />Add drink</button></div>
        {draft.items.map((item, index) => <div key={item.id} className="motion-fade-up rounded-xl border border-[#4F74C8]/15 bg-white p-3">
          <div className="mb-2 flex items-center justify-between"><span className="text-xs font-bold uppercase tracking-wide text-[#4A5365]">Drink {index + 1}{validation.itemTotalsCentavos.has(item.id) ? ` · ${formatPhp(validation.itemTotalsCentavos.get(item.id)!)}` : ''}</span><button type="button" aria-label={`Remove drink ${index + 1}`} className="rounded-lg p-1 text-[#4A5365] transition-colors duration-200 hover:bg-rose-50 hover:text-rose-700" onClick={() => onChange({ ...draft, items: draft.items.filter((entry) => entry.id !== item.id) })}><Trash2 size={16} /></button></div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <FieldLabel>Drink<SelectInput aria-label={`Drink ${index + 1}`} value={item.productSlug ?? ''} onChange={(event) => onChange(updateItem(draft, item.id, { productSlug: event.target.value || null, level: 1, powder: 'yumeno', sweetness: undefined }))}><option value="">Unresolved</option>{item.productSlug && !(item.productSlug in catalog) && <option value={item.productSlug}>Unresolved: {item.productSlug}</option>}{Object.entries(catalog).map(([slug, product]) => <option key={slug} value={slug}>{product.name}</option>)}</SelectInput></FieldLabel>
            <FieldLabel>Qty<TextInput aria-label={`Quantity ${index + 1}`} type="number" min="1" value={item.quantity ?? ''} onChange={(event) => onChange(updateItem(draft, item.id, { quantity: event.target.valueAsNumber || null }))} /></FieldLabel>
            <FieldLabel>Level<SelectInput aria-label={`Level ${index + 1}`} value={item.level ?? ''} onChange={(event) => onChange(updateItem(draft, item.id, { level: event.target.value ? Number(event.target.value) as 1 | 2 | 3 : null }))}><option value="">Unresolved</option><option value="1">L1</option><option value="2">L2</option><option value="3">L3</option></SelectInput></FieldLabel>
            <FieldLabel>Powder<SelectInput aria-label={`Powder ${index + 1}`} value={item.powder ?? ''} onChange={(event) => onChange(updateItem(draft, item.id, { powder: event.target.value === 'mk_isuzu' ? 'mk_isuzu' : event.target.value === 'yumeno' ? 'yumeno' : null }))}><option value="">Unresolved</option><option value="yumeno">Yumeno</option><option value="mk_isuzu">MK Isuzu</option></SelectInput></FieldLabel>
          </div>
          {(item.productSlug === 'matcha-latte' || item.productSlug === 'hojicha-latte' || item.sweetness) && <FieldLabel><span className="mt-2 block">Sweetness</span><SelectInput aria-label={`Sweetness ${index + 1}`} value={item.sweetness ?? ''} onChange={(event) => onChange(updateItem(draft, item.id, { sweetness: event.target.value ? event.target.value as 'none' | 'light' | 'regular' | 'extra' : undefined }))}><option value="">Not requested</option><option value="none">None</option><option value="light">Light</option><option value="regular">Regular</option><option value="extra">Extra</option></SelectInput></FieldLabel>}
          {padCupNames(item.cupNames, item.quantity).length > 0 && <div className="mt-3 border-t border-[#4F74C8]/10 pt-3">
            <span className="block text-xs font-bold uppercase tracking-[0.12em] text-[#4A5365]">Name on each cup <span className="font-semibold normal-case tracking-normal text-[#697386]">· optional</span></span>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {padCupNames(item.cupNames, item.quantity).map((name, cupIndex) => <label key={cupIndex} className="block">
                <span className="block text-[11px] font-semibold text-[#697386]">Cup {cupIndex + 1}</span>
                <TextInput aria-label={`Drink ${index + 1} cup ${cupIndex + 1} name`} maxLength={MAX_CUP_NAME_LENGTH} placeholder="Unnamed" value={name} onChange={(event) => onChange(updateItem(draft, item.id, setCupName(item, cupIndex, event.target.value)))} />
              </label>)}
            </div>
          </div>}
        </div>)}
      </div>
      <div className="mt-5"><div className="flex items-center justify-between"><h3 className="font-semibold">Thermal bags</h3><button type="button" className="rounded-lg px-2 py-1 text-sm font-semibold text-[#365aa8] transition-colors duration-200 hover:bg-[#4F74C8]/10" onClick={() => onChange({ ...draft, thermalBags: [...draft.thermalBags, blankBag()] })}><Plus className="mr-1 inline" size={15} />Add bag</button></div>{draft.thermalBags.map((bag, index) => <div className="motion-fade-up mt-2 flex items-end gap-2" key={bag.id}><FieldLabel>Bag {index + 1} covers<SelectInput aria-label={`Thermal bag ${index + 1}`} value={bag.coveredCupCount ?? ''} onChange={(event) => onChange({ ...draft, thermalBags: draft.thermalBags.map((entry) => entry.id === bag.id ? { ...entry, coveredCupCount: event.target.value ? Number(event.target.value) : null } : entry) })}><option value="">Unresolved</option><option value="1">1 cup</option><option value="2">2 cups</option><option value="3">3 cups</option><option value="4">4 cups</option></SelectInput></FieldLabel><button type="button" aria-label={`Remove thermal bag ${index + 1}`} className="min-h-11 rounded-xl px-2 text-[#4A5365] transition-colors duration-200 hover:bg-rose-50 hover:text-rose-700" onClick={() => onChange({ ...draft, thermalBags: draft.thermalBags.filter((entry) => entry.id !== bag.id) })}><Trash2 size={16} /></button></div>)}</div>
      <button type="button" disabled={confirming || validation.errors.length > 0} onClick={onConfirm} className="mt-5 flex min-h-12 w-full items-center justify-center rounded-xl bg-[#4F74C8] px-4 font-bold text-white shadow-sm transition duration-200 hover:bg-[#365AA9] active:scale-[0.98] motion-safe:transition-transform disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100">{confirming && <LoaderCircle className="mr-2 motion-safe:animate-spin" size={17} />}Confirm order</button>
    </article>
  )
}
