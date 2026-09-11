import { openDB, type IDBPDatabase } from 'idb'
import { demoCustomers, demoModifierGroups, demoOrderItems, demoOrders, demoProducts, demoSettings } from '../demo/seed'
import type { OrderConfirmationInput, Setting, StorageAdapter, StorageChange, StorageCollection, StorageEntityByCollection, StorageUnsubscribe, StoredCustomer, StoredModifierGroup, StoredOrder, StoredOrderItem, StoredProduct } from './types'

type LocalRecord = StoredProduct | StoredModifierGroup | StoredCustomer | StoredOrder | StoredOrderItem | Setting
type StoreName = StorageCollection
type ConfirmationRecord = { confirmationKey: string; requestHash: string; orderId: string; createdAt: string }

const databaseName = 'made-by-angela-order-dashboard'
const stores: StoreName[] = ['products', 'modifierGroups', 'customers', 'orders', 'orderItems', 'settings']
const memoryStores = new Map<StoreName, Map<string, LocalRecord>>()
const confirmationStore = 'confirmationKeys'
const memoryConfirmationKeys = new Map<string, ConfirmationRecord>()
let confirmationQueue: Promise<void> = Promise.resolve()

function timestamp(): string { return new Date().toISOString() }
function clone<T>(value: T): T { return structuredClone(value) }

type ConfirmationTransaction = {
  objectStore: (name: string) => {
    get: (key: string) => Promise<unknown>
    getAll: () => Promise<unknown>
    put: (value: unknown) => Promise<unknown>
  }
  abort: () => void
  done: Promise<unknown>
}

async function abortConfirmationTransaction(transaction: ConfirmationTransaction): Promise<void> {
  try {
    transaction.abort()
  } catch {
    // InvalidStateError when the transaction already finished or aborted.
  }
  try {
    await transaction.done
  } catch {
    // AbortError after abort() is expected; the original work error is rethrown by the caller.
  }
}

function normalizeCustomerName(name: string): string {
  return name.trim().toLocaleLowerCase('en-PH').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ')
}
function normalizedPhone(phone: string | null): string { return phone?.replace(/\D/g, '') ?? '' }

function resolveLocalCustomer(
  customers: readonly StoredCustomer[],
  input: OrderConfirmationInput,
): { customer: StoredCustomer; customerChange: 'insert' | 'update' | null } {
  const requestedName = input.customer.name.trim()
  if (!requestedName) throw new Error('Customer name is required for confirmation.')
  let customer = input.customer.id ? customers.find((candidate) => candidate.id === input.customer.id) : undefined
  if (input.customer.id && !customer) throw new Error('The selected customer no longer exists.')

  if (!customer) {
    const matches = customers.filter((candidate) => normalizeCustomerName(candidate.name) === normalizeCustomerName(requestedName))
    if (matches.length === 1) customer = matches[0]
    else if (matches.length > 1) {
      const phone = normalizedPhone(input.customer.phone)
      const phoneMatches = phone ? matches.filter((candidate) => normalizedPhone(candidate.phone) === phone) : []
      if (phoneMatches.length !== 1) throw new Error('Multiple saved customers share this name; resolve the customer before confirming.')
      customer = phoneMatches[0]
    }
  }

  if (!customer) {
    const createdAt = input.order.createdAt || timestamp()
    return {
      customer: { id: crypto.randomUUID(), name: requestedName, phone: input.customer.phone, createdAt, updatedAt: createdAt },
      customerChange: 'insert',
    }
  }

  const requestedPhone = normalizedPhone(input.customer.phone)
  const savedPhone = normalizedPhone(customer.phone)
  if (savedPhone && requestedPhone && savedPhone !== requestedPhone) {
    throw new Error('The saved customer has a different contact number; resolve the customer before confirming.')
  }
  const nextCustomer = {
    ...customer,
    name: requestedName,
    phone: customer.phone ?? input.customer.phone,
    updatedAt: timestamp(),
  }
  const changed = nextCustomer.name !== customer.name || nextCustomer.phone !== customer.phone
  return { customer: nextCustomer, customerChange: changed ? 'update' : null }
}

/**
 * Mirrors `public.set_order_lifecycle_timestamps()` in `supabase/schema.sql`.
 * Storage owns paidAt/deliveredAt; client-supplied values on write are discarded
 * (except INSERT coalesce of an already-set value when status requires one).
 */
function applyOrderLifecycleTimestamps(
  next: StoredOrder,
  previous: StoredOrder | null,
): Pick<StoredOrder, 'paidAt' | 'deliveredAt'> {
  const now = timestamp()
  if (previous === null) {
    // INSERT rules
    switch (next.status) {
      case 'new':
        return { paidAt: null, deliveredAt: null }
      case 'paid':
        return { paidAt: next.paidAt ?? now, deliveredAt: null }
      case 'delivered':
        return { paidAt: next.paidAt ?? now, deliveredAt: next.deliveredAt ?? now }
      case 'cancelled':
        return { paidAt: next.paidAt, deliveredAt: null }
      default:
        // LocalAdapter is permissive for invalid statuses (parity divergence vs Postgres).
        return { paidAt: next.paidAt ?? null, deliveredAt: next.deliveredAt ?? null }
    }
  }

  // UPDATE rules — columns are trigger-owned; client-supplied values discarded
  const enteringPaid = previous.status !== 'paid' && next.status === 'paid'
  const enteringDelivered = previous.status !== 'delivered' && next.status === 'delivered'
  const enteringCancelled = previous.status !== 'cancelled' && next.status === 'cancelled'

  if (enteringPaid) {
    return { paidAt: previous.paidAt ?? now, deliveredAt: null }
  }
  if (enteringDelivered) {
    return { paidAt: previous.paidAt ?? now, deliveredAt: previous.deliveredAt ?? now }
  }
  if (enteringCancelled) {
    return { paidAt: previous.paidAt, deliveredAt: null }
  }
  // any other update — preserve old values (ignore client patch of paidAt/deliveredAt)
  return { paidAt: previous.paidAt, deliveredAt: previous.deliveredAt }
}

export class LocalAdapter implements StorageAdapter {
  private readonly database: IDBPDatabase | null
  private readonly channel: BroadcastChannel | null

  private constructor(database: IDBPDatabase | null, channel: BroadcastChannel | null) {
    this.database = database
    this.channel = channel
    this.channel?.addEventListener('message', this.receiveBroadcast)
  }

  static async create(): Promise<LocalAdapter> {
    const database = typeof indexedDB === 'undefined' ? null : await openDB(databaseName, 2, {
      upgrade(db) {
        for (const store of stores) if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' })
        if (!db.objectStoreNames.contains(confirmationStore)) db.createObjectStore(confirmationStore, { keyPath: 'confirmationKey' })
      },
    })
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(databaseName)
    const adapter = new LocalAdapter(database, channel)
    await adapter.seedIfEmpty()
    return adapter
  }

  private readonly listeners = new Set<(change: StorageChange) => void>()
  private closed = false

  private receiveBroadcast = (event: MessageEvent<StorageChange>): void => {
    if (!this.closed && event.data?.collection && event.data.entity) this.notify(event.data)
  }

  private async seedIfEmpty(): Promise<void> {
    if ((await this.listProducts()).length > 0) return
    for (const product of demoProducts) await this.put('products', product, false)
    for (const group of demoModifierGroups) await this.put('modifierGroups', group, false)
    for (const customer of demoCustomers) await this.put('customers', customer, false)
    for (const item of demoOrderItems) await this.put('orderItems', item, false)
    for (const order of demoOrders) await this.put('orders', order, false)
    for (const setting of demoSettings) await this.put('settings', setting, false)
  }

  private async values<C extends StoreName>(store: C): Promise<StorageEntityByCollection[C][]> {
    if (this.database) return (await this.database.getAll(store)).map(clone) as StorageEntityByCollection[C][]
    const entries = memoryStores.get(store) ?? new Map<string, LocalRecord>()
    memoryStores.set(store, entries)
    return [...entries.values()].map(clone) as StorageEntityByCollection[C][]
  }

  private async get<C extends StoreName>(store: C, id: string): Promise<StorageEntityByCollection[C] | null> {
    const value = this.database ? await this.database.get(store, id) : memoryStores.get(store)?.get(id)
    return value ? clone(value) as StorageEntityByCollection[C] : null
  }

  private async put<C extends StoreName>(store: C, entity: StorageEntityByCollection[C], announce = true, operation: 'insert' | 'update' = 'insert'): Promise<StorageEntityByCollection[C]> {
    const saved = clone(entity)
    if (this.database) await this.database.put(store, saved)
    else {
      const entries = memoryStores.get(store) ?? new Map<string, LocalRecord>()
      entries.set(saved.id, saved)
      memoryStores.set(store, entries)
    }
    if (announce) this.emit({ collection: store, operation, entity: saved })
    return clone(saved)
  }

  private async remove<C extends StoreName>(store: C, id: string): Promise<StorageEntityByCollection[C] | null> {
    const existing = await this.get(store, id)
    if (!existing) return null
    if (this.database) await this.database.delete(store, id)
    else memoryStores.get(store)?.delete(id)
    this.emit({ collection: store, operation: 'delete', entity: existing })
    return existing
  }

  private emit(change: StorageChange): void {
    if (this.closed) return
    this.notify(change)
    this.channel?.postMessage(change)
  }

  private notify(change: StorageChange): void { for (const listener of this.listeners) listener(clone(change)) }
  private async update<C extends StoreName>(store: C, id: string, patch: Partial<Omit<StorageEntityByCollection[C], 'id' | 'createdAt'>>): Promise<StorageEntityByCollection[C]> {
    const current = await this.get(store, id)
    if (!current) throw new Error(`${store} record ${id} does not exist.`)
    const next = { ...current, ...patch, updatedAt: timestamp() } as StorageEntityByCollection[C]
    return this.put(store, next, true, 'update')
  }

  listProducts = (): Promise<StoredProduct[]> => this.values('products')
  getProduct = (id: string): Promise<StoredProduct | null> => this.get('products', id)
  createProduct = (entity: StoredProduct): Promise<StoredProduct> => this.put('products', entity)
  updateProduct = (id: string, patch: Partial<Omit<StoredProduct, 'id' | 'createdAt'>>): Promise<StoredProduct> => this.update('products', id, patch)
  deleteProduct = async (id: string): Promise<void> => { await this.remove('products', id) }

  listModifierGroups = (): Promise<StoredModifierGroup[]> => this.values('modifierGroups')
  getModifierGroup = (id: string): Promise<StoredModifierGroup | null> => this.get('modifierGroups', id)
  createModifierGroup = (entity: StoredModifierGroup): Promise<StoredModifierGroup> => this.put('modifierGroups', entity)
  updateModifierGroup = (id: string, patch: Partial<Omit<StoredModifierGroup, 'id' | 'createdAt'>>): Promise<StoredModifierGroup> => this.update('modifierGroups', id, patch)
  deleteModifierGroup = async (id: string): Promise<void> => { await this.remove('modifierGroups', id) }

  listCustomers = (): Promise<StoredCustomer[]> => this.values('customers')
  getCustomer = (id: string): Promise<StoredCustomer | null> => this.get('customers', id)
  createCustomer = (entity: StoredCustomer): Promise<StoredCustomer> => this.put('customers', entity)
  updateCustomer = (id: string, patch: Partial<Omit<StoredCustomer, 'id' | 'createdAt'>>): Promise<StoredCustomer> => this.update('customers', id, patch)
  deleteCustomer = async (id: string): Promise<void> => { await this.remove('customers', id) }

  async listOrders(filter?: { deliveryDate?: string }): Promise<StoredOrder[]> {
    const [orders, items] = await Promise.all([this.values('orders'), this.values('orderItems')])
    const joined = orders.map((order) => ({ ...order, items: items.filter((item) => item.orderId === order.id) }))
    if (filter?.deliveryDate === undefined) return joined
    return joined.filter((order) => order.deliveryDate === filter.deliveryDate)
  }
  async getOrder(id: string): Promise<StoredOrder | null> {
    const order = await this.get('orders', id)
    if (!order) return null
    return { ...order, items: await this.listOrderItems(id) }
  }
  async createOrder(order: StoredOrder): Promise<StoredOrder> {
    for (const item of order.items) await this.put('orderItems', item)
    const lifecycle = applyOrderLifecycleTimestamps(order, null)
    return this.put('orders', { ...order, ...lifecycle })
  }

  /**
   * Local parity for the production confirmation RPC. IndexedDB uses one
   * readwrite transaction across every affected store; JS exceptions abort it
   * and wait for `transaction.done` so a queued customer.put cannot commit
   * alone. The memory fallback clones maps, stages every write, then replaces
   * the live maps under the process-wide queue. Notifications emit only after
   * a successful commit.
   */
  async confirmOrderWithResolution(input: OrderConfirmationInput): Promise<StoredOrder> {
    const run = confirmationQueue.then(async () => {
      if (!/^[A-Za-z0-9._:-]{16,100}$/.test(input.confirmationKey) || !/^[0-9a-f]{64}$/i.test(input.requestHash)) {
        throw new Error('A valid durable confirmation key and request hash are required.')
      }
      if (this.database) return this.confirmOrderInDatabase(input)
      return this.confirmOrderInMemory(input)
    })
    confirmationQueue = run.then(() => undefined, () => undefined)
    return run
  }

  private async confirmOrderInDatabase(input: OrderConfirmationInput): Promise<StoredOrder> {
    const transaction = this.database!.transaction([...stores, confirmationStore], 'readwrite') as unknown as ConfirmationTransaction
    let committed:
      | { kind: 'existing'; order: StoredOrder }
      | { kind: 'created'; customer: StoredCustomer; customerChange: 'insert' | 'update' | null; items: StoredOrderItem[]; saved: StoredOrder }
      | null = null
    try {
      const confirmations = transaction.objectStore(confirmationStore)
      const existingKey = await confirmations.get(input.confirmationKey) as ConfirmationRecord | undefined
      if (existingKey) {
        if (existingKey.requestHash !== input.requestHash) throw new Error('Confirmation key was already used for another payload.')
        const existingOrder = await transaction.objectStore('orders').get(existingKey.orderId) as StoredOrder | undefined
        if (!existingOrder) throw new Error('Confirmation key points to a deleted order.')
        const existingItems = await transaction.objectStore('orderItems').getAll() as StoredOrderItem[]
        await transaction.done
        committed = {
          kind: 'existing',
          order: { ...clone(existingOrder), items: existingItems.filter((item) => item.orderId === existingOrder.id).map(clone) },
        }
      } else {
        const customerStore = transaction.objectStore('customers')
        const customers = await customerStore.getAll() as StoredCustomer[]
        const { customer, customerChange } = resolveLocalCustomer(customers, input)
        if (customerChange) await customerStore.put(clone(customer))
        const orderId = crypto.randomUUID()
        const createdAt = input.order.createdAt || timestamp()
        const updatedAt = timestamp()
        const items = input.order.items.map((item) => ({ ...item, id: crypto.randomUUID(), orderId, createdAt: updatedAt, updatedAt }))
        const candidate: StoredOrder = {
          ...input.order,
          id: orderId,
          customerId: customer.id,
          status: 'new',
          paymentReceived: false,
          paidAt: null,
          deliveredAt: null,
          items,
          createdAt,
          updatedAt,
        }
        const saved = { ...candidate, ...applyOrderLifecycleTimestamps(candidate, null) }
        await transaction.objectStore('orders').put(clone(saved))
        for (const item of items) await transaction.objectStore('orderItems').put(clone(item))
        await transaction.objectStore(confirmationStore).put({
          confirmationKey: input.confirmationKey,
          requestHash: input.requestHash,
          orderId,
          createdAt: updatedAt,
        } satisfies ConfirmationRecord)
        await transaction.done
        committed = { kind: 'created', customer, customerChange, items, saved }
      }
    } catch (error) {
      await abortConfirmationTransaction(transaction)
      throw error
    }

    if (!committed) throw new Error('Confirmation transaction completed without a result.')
    if (committed.kind === 'existing') return committed.order
    if (committed.customerChange) this.emit({ collection: 'customers', operation: committed.customerChange, entity: committed.customer })
    for (const item of committed.items) this.emit({ collection: 'orderItems', operation: 'insert', entity: item })
    this.emit({ collection: 'orders', operation: 'insert', entity: committed.saved })
    return clone(committed.saved)
  }

  private async confirmOrderInMemory(input: OrderConfirmationInput): Promise<StoredOrder> {
    const existingKey = memoryConfirmationKeys.get(input.confirmationKey)
    if (existingKey) {
      if (existingKey.requestHash !== input.requestHash) throw new Error('Confirmation key was already used for another payload.')
      const existingOrder = await this.getOrder(existingKey.orderId)
      if (!existingOrder) throw new Error('Confirmation key points to a deleted order.')
      return existingOrder
    }
    const customers = await this.listCustomers()
    const { customer, customerChange } = resolveLocalCustomer(customers, input)
    const orderId = crypto.randomUUID()
    const createdAt = input.order.createdAt || timestamp()
    const updatedAt = timestamp()
    const items = input.order.items.map((item) => ({ ...item, id: crypto.randomUUID(), orderId, createdAt: updatedAt, updatedAt }))
    const candidate: StoredOrder = {
      ...input.order,
      id: orderId,
      customerId: customer.id,
      status: 'new',
      paymentReceived: false,
      paidAt: null,
      deliveredAt: null,
      items,
      createdAt,
      updatedAt,
    }
    const saved = { ...candidate, ...applyOrderLifecycleTimestamps(candidate, null) }

    const previousCustomers = memoryStores.get('customers')
    const previousOrders = memoryStores.get('orders')
    const previousItems = memoryStores.get('orderItems')
    const previousKeys = new Map(memoryConfirmationKeys)
    const stagedCustomers = new Map(previousCustomers ?? [])
    const stagedOrders = new Map(previousOrders ?? [])
    const stagedItems = new Map(previousItems ?? [])

    try {
      if (customerChange) stagedCustomers.set(customer.id, clone(customer))
      stagedOrders.set(saved.id, clone(saved))
      for (const item of items) stagedItems.set(item.id, clone(item))
      if (customerChange) memoryStores.set('customers', stagedCustomers)
      memoryStores.set('orders', stagedOrders)
      memoryStores.set('orderItems', stagedItems)
      memoryConfirmationKeys.set(input.confirmationKey, {
        confirmationKey: input.confirmationKey,
        requestHash: input.requestHash,
        orderId,
        createdAt: updatedAt,
      })
    } catch (error) {
      if (previousCustomers) memoryStores.set('customers', previousCustomers)
      else memoryStores.delete('customers')
      if (previousOrders) memoryStores.set('orders', previousOrders)
      else memoryStores.delete('orders')
      if (previousItems) memoryStores.set('orderItems', previousItems)
      else memoryStores.delete('orderItems')
      memoryConfirmationKeys.clear()
      for (const [key, record] of previousKeys) memoryConfirmationKeys.set(key, record)
      throw error
    }

    if (customerChange) this.emit({ collection: 'customers', operation: customerChange, entity: customer })
    for (const item of items) this.emit({ collection: 'orderItems', operation: 'insert', entity: item })
    this.emit({ collection: 'orders', operation: 'insert', entity: saved })
    return clone(saved)
  }

  async updateOrder(id: string, patch: Partial<Omit<StoredOrder, 'id' | 'createdAt'>>): Promise<StoredOrder> {
    const current = await this.get('orders', id)
    if (!current) throw new Error(`orders record ${id} does not exist.`)
    const merged = { ...current, ...patch, updatedAt: timestamp() } as StoredOrder
    const lifecycle = applyOrderLifecycleTimestamps(merged, current)
    return this.put('orders', { ...merged, ...lifecycle }, true, 'update')
  }
  async deleteOrder(id: string): Promise<void> {
    for (const item of await this.listOrderItems(id)) await this.remove('orderItems', item.id)
    await this.remove('orders', id)
  }

  async listOrderItems(orderId?: string): Promise<StoredOrderItem[]> {
    const items = await this.values('orderItems')
    return orderId ? items.filter((item) => item.orderId === orderId) : items
  }
  getOrderItem = (id: string): Promise<StoredOrderItem | null> => this.get('orderItems', id)
  createOrderItem = (entity: StoredOrderItem): Promise<StoredOrderItem> => this.put('orderItems', entity)
  updateOrderItem = (id: string, patch: Partial<Omit<StoredOrderItem, 'id' | 'createdAt'>>): Promise<StoredOrderItem> => this.update('orderItems', id, patch)
  deleteOrderItem = async (id: string): Promise<void> => { await this.remove('orderItems', id) }

  listSettings = (): Promise<Setting[]> => this.values('settings')
  async getSetting(key: string): Promise<Setting | null> { return (await this.listSettings()).find((setting) => setting.key === key) ?? null }
  async setSetting(setting: Omit<Setting, 'id'> & { id?: string }): Promise<Setting> {
    const current = await this.getSetting(setting.key)
    return this.put('settings', { ...setting, id: current?.id ?? setting.id ?? crypto.randomUUID(), updatedAt: timestamp() }, true, current ? 'update' : 'insert')
  }
  async deleteSetting(key: string): Promise<void> { const setting = await this.getSetting(key); if (setting) await this.remove('settings', setting.id) }

  subscribe(listener: (change: StorageChange) => void): StorageUnsubscribe {
    if (this.closed) throw new Error('Storage adapter is closed.')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.listeners.clear()
    this.channel?.removeEventListener('message', this.receiveBroadcast)
    this.channel?.close()
    this.database?.close()
  }
}

export function resetLocalAdapterMemoryForTests(): void {
  memoryStores.clear()
  memoryConfirmationKeys.clear()
  confirmationQueue = Promise.resolve()
}
