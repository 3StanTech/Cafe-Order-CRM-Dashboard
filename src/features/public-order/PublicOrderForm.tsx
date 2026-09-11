import { Check, Clipboard, LoaderCircle, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DrinkFamily, Powder, ProductSlug, Sweetness } from '../../domain/contracts'
import { formatPesos } from '../../domain/money'
import { MAX_CUPS_PER_ORDER } from '../../domain/pricing'
import {
  getReconfirmation,
  publicOrderErrorMessage,
  submitPublicOrder,
  type PublicOrderDelivery,
  type PublicOrderFetch,
  type PublicOrderMenu,
  type PublicOrderProduct,
  type PublicOrderReceipt,
  type PublicOrderReconfirmation,
} from './api'
import { pricePublicOrder, type PublicOrderDraft } from './quote'
import {
  clearRememberedPublicOrderDetails,
  saveRememberedPublicOrderDetails,
  type RememberedPublicOrderDetails,
} from './storage'

type OrderLine = {
  id: string
  productSlug: ProductSlug
  quantity: number
  level: 1 | 2 | 3
  powder: Powder
  sweetness?: Sweetness
  cupNames: string[]
}

type ThermalBagLine = {
  id: string
  coveredCupCount: 1 | 2 | 3 | 4
}

type ReconfirmState = PublicOrderReconfirmation & { confirmed: boolean }

type LocalReceipt = {
  response: PublicOrderReceipt
  customerName: string
  customerPhone: string
  address: string
  lines: OrderLine[]
  thermalBags: ThermalBagLine[]
  paymentAccount: string
  delivery: PublicOrderDelivery
}

type PublicOrderFormProps = {
  menu: PublicOrderMenu
  endpoint: string
  fetcher: PublicOrderFetch
  storage: Storage | null
  onMenuRevisionChange: (patch: Pick<PublicOrderMenu, 'delivery' | 'quoteRevision'>) => void
}

type FieldErrors = Partial<Record<'customerName' | 'customerPhone' | 'address', string>>

const inputClass = 'mt-1 min-h-11 w-full rounded-xl border border-[#4F74C8]/30 bg-white px-3 text-base text-[#20242F] outline-none transition-colors placeholder:text-[#737B8B] focus:border-[#4F74C8] focus:ring-2 focus:ring-[#4F74C8]/25 disabled:cursor-not-allowed disabled:bg-[#F2F4F9]'
const selectClass = `${inputClass} cursor-pointer`
const cardClass = 'rounded-2xl border border-[#4F74C8]/20 bg-[#FFFDF6] p-4 shadow-sm sm:p-5'

function localId(prefix: string): string {
  try { return `${prefix}-${globalThis.crypto.randomUUID()}` } catch { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` }
}

function newIdempotencyKey(): string {
  return localId('public-order')
}

function defaultLine(product: PublicOrderProduct): OrderLine {
  const sweetness = product.sweetnessOptions.includes('regular') ? 'regular' : product.sweetnessOptions[0]
  return {
    id: localId('drink'),
    productSlug: product.slug,
    quantity: 1,
    level: 1,
    powder: 'yumeno',
    ...(sweetness ? { sweetness } : {}),
    cupNames: [''],
  }
}

function totalCups(lines: readonly OrderLine[]): number {
  return lines.reduce((total, line) => total + line.quantity, 0)
}

function normalizeQuantity(value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) return 1
  return Math.min(parsed, MAX_CUPS_PER_ORDER)
}

function toDraft(lines: readonly OrderLine[], thermalBags: readonly ThermalBagLine[]): PublicOrderDraft {
  return {
    items: lines.map((line) => ({
      productSlug: line.productSlug,
      quantity: line.quantity,
      modifiers: {
        level: line.level,
        powder: line.powder,
        ...(line.sweetness ? { sweetness: line.sweetness } : {}),
      },
      ...(line.cupNames.some((name) => name.trim()) ? { cupNames: line.cupNames.map((name) => name.trim()).filter(Boolean) } : {}),
    })),
    thermalBags: thermalBags.map(({ coveredCupCount }) => ({ coveredCupCount })),
  }
}

function formatShortDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.valueOf())) return value
  return new Intl.DateTimeFormat('en-PH', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'Asia/Manila' }).format(parsed)
}

function formatLongDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.valueOf())) return value
  return new Intl.DateTimeFormat('en-PH', { dateStyle: 'full', timeZone: 'Asia/Manila' }).format(parsed)
}

function formatTime(value: string): string {
  const [hour, minute] = value.split(':').map(Number)
  if (!Number.isSafeInteger(hour) || !Number.isSafeInteger(minute)) return value
  const suffix = hour >= 12 ? 'PM' : 'AM'
  const twelveHour = hour % 12 || 12
  return minute === 0 ? `${twelveHour} ${suffix}` : `${twelveHour}:${String(minute).padStart(2, '0')} ${suffix}`
}

function formatWindow(delivery: PublicOrderDelivery): string {
  return `${formatTime(delivery.deliveryWindowStart)}–${formatTime(delivery.deliveryWindowEnd)}`
}

function fieldErrorFor(name: keyof FieldErrors, values: { customerName: string; customerPhone: string; address: string }): string | undefined {
  if (name === 'customerName' && !values.customerName.trim()) return 'Name is required.'
  if (name === 'customerPhone' && !values.customerPhone.trim()) return 'Viber number is required.'
  if (name === 'customerPhone' && (!/^[+0-9() .-]{7,40}$/.test(values.customerPhone.trim()) || values.customerPhone.replace(/\D/g, '').length < 7)) return 'Enter a valid Viber contact number.'
  if (name === 'address' && !values.address.trim()) return 'Delivery address is required.'
  return undefined
}

function buildViberMessage(receipt: LocalReceipt): string {
  const lines = receipt.lines.map((line) => {
    const names = line.cupNames.map((name) => name.trim()).filter(Boolean)
    const nameText = names.length ? ` (${names.join(', ')})` : ''
    return `${line.quantity}× ${line.productSlug} · L${line.level}${nameText}`
  }).join('\n')
  return [
    `Order ${receipt.response.reference}`,
    `Name: ${receipt.customerName}`,
    `Viber: ${receipt.customerPhone}`,
    `Delivery: ${formatLongDate(receipt.response.deliveryDate)} · ${formatWindow(receipt.delivery)}`,
    lines,
    `Total: ${formatPesos(receipt.response.totalCentavos)}`,
    'I will send my GCash screenshot in Viber. Payment is pending Angela\'s acceptance.',
  ].join('\n')
}

function levelLabel(family: DrinkFamily, level: 1 | 2 | 3): string {
  return level === 1 ? `L1 · ${family === 'matcha' ? '5g' : '6g'}` : `L${level}`
}

function modifierGroup(product: PublicOrderProduct, group: string): boolean {
  return product.modifierGroups.includes(group as PublicOrderProduct['modifierGroups'][number])
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return <label className="block text-sm font-bold text-[#20242F]"><span>{label}</span>{children}{error && <span className="mt-1 block font-semibold text-red-700" role="alert">{error}</span>}</label>
}

function PublicOrderReceiptView({ receipt, onStartAnother }: { receipt: LocalReceipt; onStartAnother: () => void }) {
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle')
  const copy = async () => {
    if (!navigator.clipboard?.writeText) { setCopyState('failed'); return }
    setCopyState('copying')
    try {
      await navigator.clipboard.writeText(buildViberMessage(receipt))
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  return <div className="public-order-receipt">
    <header className="motion-fade-up">
      <p className="text-xs font-black uppercase tracking-[0.16em] text-[#4F74C8]">Order receipt</p>
      <h1 className="mt-2 text-3xl font-black tracking-tight text-[#20242F] sm:text-4xl">Order submitted</h1>
      <p className="mt-1 text-sm leading-6 text-[#586782]">Angela will review your order.</p>
    </header>
    <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(18rem,.75fr)] lg:items-start">
      <section className={cardClass} aria-labelledby="receipt-reference-heading">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="receipt-reference-heading" className="text-sm font-bold text-[#20242F]">Reference</h2>
          <p className="text-2xl font-black tracking-wide text-[#4F74C8]">{receipt.response.reference}</p>
        </div>
        <dl className="mt-3 divide-y divide-[#4F74C8]/20 text-sm">
          <div className="flex items-start justify-between gap-4 py-3"><dt>Customer</dt><dd className="text-right font-bold">{receipt.customerName}</dd></div>
          <div className="flex items-start justify-between gap-4 py-3"><dt>Delivery</dt><dd className="text-right font-bold"><time dateTime={receipt.response.deliveryDate}>{formatShortDate(receipt.response.deliveryDate)}</time> · {formatWindow(receipt.delivery)}</dd></div>
          {receipt.lines.map((line) => <div key={line.id} className="flex items-start justify-between gap-4 py-3"><dt>{line.quantity}× {line.productSlug} · L{line.level}</dt><dd className="text-right font-bold">{formatPesos(Math.round(receipt.response.totalCentavos * (line.quantity / Math.max(1, totalCups(receipt.lines)))))}</dd></div>)}
          <div className="flex items-start justify-between gap-4 py-3 text-base font-black"><dt>Total</dt><dd>{formatPesos(receipt.response.totalCentavos)}</dd></div>
        </dl>
        <p className="mt-3 rounded-full bg-[#D8F2E1] px-3 py-1.5 text-xs font-bold text-[#24633B]">{receipt.response.pendingAngelaAcceptance ? 'Pending Angela’s acceptance' : `Submission status: ${receipt.response.status}`}</p>
      </section>
      <div className="space-y-4">
        <section className="rounded-2xl border border-[#4F74C8]/15 bg-[#EAF0FF] p-4" aria-labelledby="receipt-payment-heading">
          <h2 id="receipt-payment-heading" className="text-xl font-black text-[#20242F]">Pay through GCash</h2>
          <p className="mt-2 text-sm font-bold text-[#586782]">GCash: {receipt.paymentAccount}</p>
          <p className="mt-1 text-sm leading-5 text-[#586782]">Send your screenshot in Viber after submitting. This receipt does not verify payment.</p>
        </section>
        <button type="button" onClick={() => void copy()} disabled={copyState === 'copying'} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#4F74C8] px-4 font-bold text-white shadow-sm transition-colors hover:bg-[#365AA9] active:scale-[0.98] disabled:cursor-wait disabled:opacity-60 motion-safe:transition-transform">
          {copyState === 'copying' ? <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" size={17} /> : copyState === 'copied' ? <Check aria-hidden="true" size={17} /> : <Clipboard aria-hidden="true" size={17} />}
          {copyState === 'copying' ? 'Copying…' : copyState === 'copied' ? 'Copied Viber message' : 'Copy Viber message'}
        </button>
        {copyState === 'failed' && <p role="alert" className="text-sm font-semibold text-red-700">Copying was unavailable. You can send the details manually in Viber.</p>}
        <button type="button" onClick={onStartAnother} className="min-h-11 w-full rounded-xl border border-[#4F74C8]/30 px-4 text-sm font-bold text-[#365AA9] transition-colors hover:bg-[#4F74C8]/10">Start another order</button>
      </div>
    </div>
  </div>
}

export function PublicOrderForm({ menu, endpoint, fetcher, storage, onMenuRevisionChange }: PublicOrderFormProps) {
  const remembered = useMemo<RememberedPublicOrderDetails | null>(() => {
    if (!storage) return null
    try {
      const raw = storage.getItem('public-order-details-v1')
      if (!raw) return null
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      const value = parsed as Record<string, unknown>
      if (typeof value.customerName !== 'string' || typeof value.customerPhone !== 'string' || typeof value.address !== 'string') return null
      return { customerName: value.customerName, customerPhone: value.customerPhone, address: value.address }
    } catch {
      return null
    }
  }, [storage])
  const [lines, setLines] = useState<OrderLine[]>([])
  const [thermalBags, setThermalBags] = useState<ThermalBagLine[]>([])
  const [customerName, setCustomerName] = useState(remembered?.customerName ?? '')
  const [customerPhone, setCustomerPhone] = useState(remembered?.customerPhone ?? '')
  const [address, setAddress] = useState(remembered?.address ?? '')
  const [notes, setNotes] = useState('')
  const [rememberDetails, setRememberDetails] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [formNotice, setFormNotice] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [reconfirm, setReconfirm] = useState<ReconfirmState | null>(null)
  const [receipt, setReceipt] = useState<LocalReceipt | null>(null)
  const submissionKeyRef = useRef(newIdempotencyKey())
  const submissionAttemptedRef = useRef(false)
  const submittingRef = useRef(false)
  const initializedRef = useRef(false)

  useEffect(() => {
    if (initializedRef.current || menu.products.length === 0) return
    initializedRef.current = true
    setLines([defaultLine(menu.products[0])])
  }, [menu.products])

  useEffect(() => {
    if (!rememberDetails) return
    saveRememberedPublicOrderDetails(storage, { customerName, customerPhone, address })
  }, [address, customerName, customerPhone, rememberDetails, storage])

  const productBySlug = useMemo(() => new Map(menu.products.map((product) => [product.slug, product])), [menu.products])
  const draft = useMemo(() => toDraft(lines, thermalBags), [lines, thermalBags])
  const localQuoteResult = useMemo(() => {
    if (!menu || lines.length === 0) return { quote: null, error: null }
    try { return { quote: pricePublicOrder(draft, menu), error: null } }
    catch (cause) { return { quote: null, error: cause instanceof Error ? cause.message : 'The selected order cannot be priced.' } }
  }, [draft, lines.length, menu])
  const displayTotals = reconfirm?.quote ?? localQuoteResult.quote?.totals ?? null
  const totalCupsInOrder = totalCups(lines)

  const invalidateSubmission = () => {
    if (submissionAttemptedRef.current) {
      submissionKeyRef.current = newIdempotencyKey()
      submissionAttemptedRef.current = false
    }
    setReconfirm(null)
    setFormNotice(null)
    setFormError(null)
  }

  const updateField = (field: keyof FieldErrors, value: string) => {
    invalidateSubmission()
    if (field === 'customerName') setCustomerName(value)
    if (field === 'customerPhone') setCustomerPhone(value)
    if (field === 'address') setAddress(value)
    setFieldErrors((current) => ({ ...current, [field]: undefined }))
  }

  const updateLine = (id: string, patch: Partial<OrderLine>) => {
    invalidateSubmission()
    setLines((current) => current.map((line) => line.id === id ? { ...line, ...patch } : line))
  }

  const updateQuantity = (line: OrderLine, value: string) => {
    const quantity = normalizeQuantity(value)
    updateLine(line.id, { quantity, cupNames: Array.from({ length: quantity }, (_, index) => line.cupNames[index] ?? '') })
  }

  const updateProduct = (line: OrderLine, productSlug: ProductSlug) => {
    const product = productBySlug.get(productSlug)
    if (!product) return
    const sweetness = product.sweetnessOptions.includes('regular') ? 'regular' : product.sweetnessOptions[0]
    updateLine(line.id, { productSlug, level: 1, powder: 'yumeno', ...(sweetness ? { sweetness } : { sweetness: undefined }), cupNames: line.cupNames })
  }

  const addDrink = () => {
    const product = menu.products[0]
    if (!product || totalCupsInOrder >= MAX_CUPS_PER_ORDER) return
    invalidateSubmission()
    setLines((current) => [...current, defaultLine(product)])
  }

  const removeDrink = (id: string) => {
    if (lines.length <= 1) return
    invalidateSubmission()
    setLines((current) => current.filter((line) => line.id !== id))
  }

  const updateCupName = (line: OrderLine, index: number, value: string) => {
    const cupNames = line.cupNames.map((name, nameIndex) => nameIndex === index ? value.slice(0, 40) : name)
    updateLine(line.id, { cupNames })
  }

  const addThermalBag = () => {
    if (thermalBags.length >= totalCupsInOrder || thermalBags.length >= MAX_CUPS_PER_ORDER) return
    invalidateSubmission()
    setThermalBags((current) => [...current, { id: localId('bag'), coveredCupCount: 1 }])
  }

  const updateThermalBag = (id: string, value: string) => {
    invalidateSubmission()
    if (!value) {
      setThermalBags((current) => current.filter((bag) => bag.id !== id))
      return
    }
    const coveredCupCount = Number(value)
    if (![1, 2, 3, 4].includes(coveredCupCount)) return
    setThermalBags((current) => current.map((bag) => bag.id === id ? { ...bag, coveredCupCount: coveredCupCount as ThermalBagLine['coveredCupCount'] } : bag))
  }

  const validate = (): boolean => {
    const values = { customerName, customerPhone, address }
    const errors: FieldErrors = {
      customerName: fieldErrorFor('customerName', values),
      customerPhone: fieldErrorFor('customerPhone', values),
      address: fieldErrorFor('address', values),
    }
    setFieldErrors(errors)
    return !Object.values(errors).some(Boolean)
  }

  const submit = async () => {
    if (submittingRef.current) return
    if (reconfirm && !reconfirm.confirmed) {
      setFormError('Review the updated delivery date and total, then confirm the updated quote before submitting again.')
      return
    }
    if (!validate()) {
      setFormError('Complete the required customer details before submitting.')
      return
    }
    if (!displayTotals || localQuoteResult.error) {
      setFormError(localQuoteResult.error ?? 'Add a valid drink selection before submitting.')
      return
    }
    const delivery = reconfirm?.delivery ?? menu.delivery
    const quoteRevision = reconfirm?.quoteRevision ?? menu.quoteRevision
    const input = {
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim(),
      address: address.trim(),
      deliveryDate: delivery.deliveryDate,
      notes: notes.trim() || null,
      items: draft.items,
      thermalBags: draft.thermalBags,
      quoteRevision,
      quotedTotalCentavos: displayTotals.totalCentavos,
      idempotencyKey: submissionKeyRef.current,
      honeypot: '',
    }
    submissionAttemptedRef.current = true
    submittingRef.current = true
    setSubmitting(true)
    setFormError(null)
    setFormNotice(null)
    try {
      const response = await submitPublicOrder(input, { endpoint, fetcher })
      setReceipt({ response, customerName: customerName.trim(), customerPhone: customerPhone.trim(), address: address.trim(), lines: lines.map((line) => ({ ...line, cupNames: [...line.cupNames] })), thermalBags: thermalBags.map((bag) => ({ ...bag })), paymentAccount: menu.payment.account, delivery })
      setReconfirm(null)
      setFormNotice(null)
    } catch (cause) {
      const fresh = getReconfirmation(cause)
      if (fresh) {
        onMenuRevisionChange({ delivery: fresh.delivery, quoteRevision: fresh.quoteRevision })
        setReconfirm({ ...fresh, confirmed: false })
        setFormError(fresh.error)
      } else {
        setFormError(publicOrderErrorMessage(cause))
      }
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const confirmUpdatedQuote = () => {
    if (!reconfirm) return
    setReconfirm({ ...reconfirm, confirmed: true })
    setFormError(null)
    setFormNotice(`Updated total ${formatPesos(reconfirm.quote.totalCentavos)} for ${formatLongDate(reconfirm.delivery.deliveryDate)} is ready. Submit again when you are ready.`)
  }

  const resetDetails = () => {
    clearRememberedPublicOrderDetails(storage)
    setCustomerName('')
    setCustomerPhone('')
    setAddress('')
    setRememberDetails(false)
    setFieldErrors({})
    setFormNotice('Saved details were cleared from this device.')
    setFormError(null)
  }

  const startAnother = () => {
    const first = menu.products[0]
    if (!first) return
    submissionAttemptedRef.current = false
    submissionKeyRef.current = newIdempotencyKey()
    setReceipt(null)
    setReconfirm(null)
    setLines([defaultLine(first)])
    setThermalBags([])
    setFieldErrors({})
    setFormError(null)
    setFormNotice(null)
  }

  if (receipt) return <PublicOrderReceiptView receipt={receipt} onStartAnother={startAnother} />

  return <form className="public-order-form" onSubmit={(event) => { event.preventDefault(); void submit() }} noValidate>
    <section className="motion-fade-up" aria-labelledby="public-order-heading">
      <p className="text-xs font-black uppercase tracking-[0.16em] text-[#4F74C8]">Order link</p>
      <h1 id="public-order-heading" className="mt-2 text-3xl font-black tracking-tight text-[#20242F] sm:text-4xl">Order for <time dateTime={menu.delivery.deliveryDate}>{formatShortDate(menu.delivery.deliveryDate)}</time></h1>
      <p className="mt-1 text-sm leading-6 text-[#586782]">Delivery is {formatWindow(menu.delivery)}. Place your order before the server cutoff.</p>
    </section>

    {formError && <div role="alert" className="motion-fade-in mt-5 rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-semibold leading-5 text-red-800">{formError}</div>}
    {formNotice && <div role="status" className="motion-fade-in mt-5 flex gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold leading-5 text-emerald-800"><Check aria-hidden="true" className="mt-0.5 shrink-0" size={18} />{formNotice}</div>}
    {reconfirm && <section className="motion-fade-in mt-5 rounded-2xl border-2 border-[#4F74C8]/35 bg-[#EAF0FF] p-4" aria-labelledby="reconfirm-heading">
      <div className="flex items-start gap-3"><RefreshCw aria-hidden="true" className="mt-0.5 shrink-0 text-[#4F74C8]" size={20} /><div><h2 id="reconfirm-heading" className="font-black text-[#20242F]">Review updated order details</h2><p className="mt-1 text-sm leading-5 text-[#465675]">{reconfirm.error}</p><p className="mt-2 text-sm font-bold text-[#20242F]">New delivery: {formatLongDate(reconfirm.delivery.deliveryDate)} · {formatWindow(reconfirm.delivery)}</p><p className="mt-1 text-lg font-black text-[#4F74C8]">New total: {formatPesos(reconfirm.quote.totalCentavos)}</p></div></div>
      {!reconfirm.confirmed && <button type="button" onClick={confirmUpdatedQuote} className="mt-3 min-h-11 w-full rounded-xl bg-[#4F74C8] px-4 text-sm font-bold text-white transition-colors hover:bg-[#365AA9] sm:w-auto">Confirm updated quote</button>}
      {reconfirm.confirmed && <p className="mt-3 text-sm font-bold text-[#24633B]">Updated quote confirmed. Submit again when ready.</p>}
    </section>}

    <section className={`${cardClass} mt-6`} aria-labelledby="drinks-heading">
      <div className="flex items-baseline justify-between gap-3 border-b border-[#4F74C8]/20 pb-3"><h2 id="drinks-heading" className="text-2xl font-black text-[#20242F]">Your drinks</h2><p className="text-xs font-bold text-[#586782]">{totalCupsInOrder} {totalCupsInOrder === 1 ? 'cup' : 'cups'}</p></div>
      <div className="mt-4 space-y-4">
        {lines.map((line, index) => {
          const product = productBySlug.get(line.productSlug)
          if (!product) return <p key={line.id} role="alert" className="rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">This drink is no longer available. Choose another drink.</p>
          const levelGroup = product.family === 'matcha' ? 'matcha_level' : 'hojicha_level'
          return <article key={line.id} className="rounded-xl border border-[#4F74C8]/15 bg-white/70 p-3">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_6rem_minmax(12rem,14rem)] lg:items-end">
              <Field label={`Drink ${index + 1}`}><select aria-label={`Drink ${index + 1}`} className={selectClass} value={line.productSlug} onChange={(event) => updateProduct(line, event.target.value as ProductSlug)}>{menu.products.map((entry) => <option key={entry.slug} value={entry.slug}>{entry.name} · {formatPesos(entry.basePriceCentavos)}</option>)}</select></Field>
              <Field label="Qty"><input aria-label={`Quantity for drink ${index + 1}`} className={inputClass} type="number" min="1" max={MAX_CUPS_PER_ORDER} inputMode="numeric" value={line.quantity} onChange={(event) => updateQuantity(line, event.target.value)} /></Field>
              <Field label="Options"><select aria-label={`Level for drink ${index + 1}`} className={selectClass} value={line.level} onChange={(event) => updateLine(line.id, { level: Number(event.target.value) as 1 | 2 | 3 })}>{modifierGroup(product, levelGroup) && ([1, 2, 3] as const).map((level) => <option key={level} value={level}>{levelLabel(product.family, level)}{product.levelUpcharges[level] ? ` · +${formatPesos(product.levelUpcharges[level])}` : ''}</option>)}</select></Field>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {modifierGroup(product, 'powder') && <Field label="Powder"><select aria-label={`Powder for drink ${index + 1}`} className={selectClass} value={line.powder} onChange={(event) => updateLine(line.id, { powder: event.target.value as Powder })}><option value="yumeno">Yumeno{product.powderUpcharges.yumeno ? ` · +${formatPesos(product.powderUpcharges.yumeno)}` : ''}</option><option value="mk_isuzu">MK Isuzu{product.powderUpcharges.mk_isuzu ? ` · +${formatPesos(product.powderUpcharges.mk_isuzu)}` : ''}</option></select></Field>}
              {modifierGroup(product, 'sweetness') && product.sweetnessOptions.length > 0 && <Field label="Sweetness"><select aria-label={`Sweetness for drink ${index + 1}`} className={selectClass} value={line.sweetness ?? product.sweetnessOptions[0]} onChange={(event) => updateLine(line.id, { sweetness: event.target.value as Sweetness })}>{product.sweetnessOptions.map((sweetness) => <option key={sweetness} value={sweetness}>{sweetness.slice(0, 1).toUpperCase() + sweetness.slice(1)}</option>)}</select></Field>}
            </div>
            <div className="mt-3 border-t border-[#4F74C8]/15 pt-3">
              <p className="text-sm font-bold text-[#20242F]">Cup names <span className="font-normal text-[#586782]">(optional)</span></p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{line.cupNames.map((name, cupIndex) => <label key={`${line.id}-${cupIndex}`} className="text-sm font-semibold text-[#20242F]"><span>Cup {cupIndex + 1}</span><input aria-label={`Cup ${cupIndex + 1} name for drink ${index + 1}`} className={inputClass} maxLength={40} value={name} placeholder="Optional" onChange={(event) => updateCupName(line, cupIndex, event.target.value)} /></label>)}</div>
            </div>
            {lines.length > 1 && <button type="button" onClick={() => removeDrink(line.id)} className="mt-3 inline-flex min-h-11 items-center gap-1 rounded-xl px-2 text-sm font-semibold text-rose-700 transition-colors hover:bg-rose-50"><Trash2 aria-hidden="true" size={16} />Remove drink</button>}
          </article>
        })}
      </div>
      <button type="button" disabled={totalCupsInOrder >= MAX_CUPS_PER_ORDER} onClick={addDrink} className="mt-4 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-[#4F74C8]/35 px-4 text-sm font-bold text-[#365AA9] transition-colors hover:bg-[#4F74C8]/10 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"><Plus aria-hidden="true" size={17} />Add another drink</button>
    </section>

    <section className={`${cardClass} mt-4`} aria-labelledby="customer-heading">
      <h2 id="customer-heading" className="text-lg font-black text-[#20242F]">Your details</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Name" error={fieldErrors.customerName}><input aria-label="Name" aria-invalid={Boolean(fieldErrors.customerName)} className={inputClass} value={customerName} autoComplete="name" onChange={(event) => updateField('customerName', event.target.value)} /></Field>
        <Field label="Viber number" error={fieldErrors.customerPhone}><input aria-label="Viber number" aria-invalid={Boolean(fieldErrors.customerPhone)} className={inputClass} type="tel" inputMode="tel" autoComplete="tel" value={customerPhone} placeholder="09XX XXX XXXX" onChange={(event) => updateField('customerPhone', event.target.value)} /></Field>
        <Field label="Delivery address" error={fieldErrors.address}><input aria-label="Delivery address" aria-invalid={Boolean(fieldErrors.address)} className={inputClass} autoComplete="street-address" value={address} placeholder="Street, barangay, city" onChange={(event) => updateField('address', event.target.value)} /></Field>
        <Field label="Notes (optional)"><textarea aria-label="Notes (optional)" className={`${inputClass} min-h-11 resize-y py-2`} rows={1} maxLength={500} value={notes} placeholder="Anything Angela should know?" onChange={(event) => { invalidateSubmission(); setNotes(event.target.value) }} /></Field>
      </div>
      <label className="mt-4 flex min-h-11 items-center gap-2 text-sm font-semibold text-[#20242F]"><input type="checkbox" checked={rememberDetails} onChange={(event) => setRememberDetails(event.target.checked)} />Remember my details on this device</label>
      <button type="button" onClick={resetDetails} className="mt-2 min-h-11 text-left text-sm font-bold text-[#365AA9] underline underline-offset-2 hover:text-[#20242F]">Reset saved details</button>
    </section>

    <section className={`${cardClass} mt-4`} aria-labelledby="summary-heading">
      <div className="flex items-baseline justify-between gap-4 border-b border-[#4F74C8]/20 pb-3"><h2 id="summary-heading" className="text-base font-black text-[#20242F]">Total · calculated from current menu</h2><p className="text-xl font-black text-[#20242F]">{displayTotals ? formatPesos(displayTotals.totalCentavos) : '—'}</p></div>
      {localQuoteResult.error && <p role="alert" className="mt-3 text-sm font-semibold text-red-700">{localQuoteResult.error}</p>}
      <div className="mt-4">
        <div className="flex items-baseline justify-between gap-3"><h3 className="text-sm font-bold text-[#20242F]">Thermal bags</h3><p className="text-sm text-[#586782]">{displayTotals ? formatPesos(displayTotals.thermalBagsTotalCentavos) : '—'}</p></div>
        <div className="mt-2 space-y-2">{thermalBags.map((bag, index) => <div key={bag.id} className="flex items-end gap-2"><Field label={index === 0 ? 'Thermal bag' : `Thermal bag ${index + 1}`}><select aria-label={index === 0 ? 'Thermal bag' : `Thermal bag ${index + 1}`} className={selectClass} value={bag.coveredCupCount} onChange={(event) => updateThermalBag(bag.id, event.target.value)}>{([1, 2, 3, 4] as const).map((coveredCupCount) => <option key={coveredCupCount} value={coveredCupCount}>{coveredCupCount} {coveredCupCount === 1 ? 'cup' : 'cups'} · {formatPesos(menu.products[0]?.thermalBagPrices[coveredCupCount] ?? 0)}</option>)}</select></Field><button type="button" aria-label={`Remove thermal bag ${index + 1}`} onClick={() => updateThermalBag(bag.id, '')} className="mb-0 min-h-11 rounded-xl px-2 text-[#586782] hover:bg-rose-50 hover:text-rose-700"><Trash2 aria-hidden="true" size={17} /></button></div>)}</div>
        {thermalBags.length === 0 && <p className="mt-1 text-sm text-[#586782]">No bag selected.</p>}
        <button type="button" disabled={thermalBags.length >= totalCupsInOrder || totalCupsInOrder === 0} onClick={addThermalBag} className="mt-2 inline-flex min-h-11 items-center gap-1 rounded-xl px-2 text-sm font-bold text-[#365AA9] transition-colors hover:bg-[#4F74C8]/10 disabled:cursor-not-allowed disabled:opacity-50"><Plus aria-hidden="true" size={16} />Add thermal bag</button>
      </div>
      <div className="mt-5 rounded-xl bg-[#EAF0FF] p-3"><h3 className="font-black text-[#20242F]">{menu.payment.method} payment</h3><p className="mt-1 text-sm font-bold text-[#586782]">{menu.payment.account}</p><p className="mt-1 text-sm leading-5 text-[#586782]">{menu.payment.instructions}</p></div>
      <button type="submit" disabled={submitting || !displayTotals || Boolean(localQuoteResult.error) || Boolean(reconfirm && !reconfirm.confirmed)} className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#4F74C8] px-4 font-bold text-white shadow-sm transition-colors hover:bg-[#365AA9] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 motion-safe:transition-transform">{submitting && <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" size={18} />}{submitting ? 'Submitting order…' : reconfirm && !reconfirm.confirmed ? 'Confirm updated quote above' : 'Review and submit order'}</button>
    </section>
  </form>
}
