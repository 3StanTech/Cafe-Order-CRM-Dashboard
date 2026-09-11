import type { Customer, DrinkModifiers, MoneyCentavos, Order, OrderItem, OrderStatus, Product } from '../domain/contracts'

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export type ModifierOption = {
  id: string
  label: string
  priceCentavos: number
  default?: boolean
}

/** Persisted `modifier_groups` table row. Distinct from domain `ModifierGroup` (union of catalog group keys). */
export type StoredModifierGroup = {
  id: string
  name: string
  appliesToProductIds: string[]
  options: ModifierOption[]
  allowsMultiple: boolean
  createdAt: string
  updatedAt: string
}

export type StoredProduct = Product & { createdAt: string; updatedAt: string }
export type StoredCustomer = Customer & { updatedAt: string }

/**
 * Persisted per-item modifiers. `cupNames` is a fulfillment label rather than a
 * priced option, so it is kept out of the pricing engine's `DrinkModifiers` and
 * stored alongside it in the same `modifiers` jsonb column — no schema change.
 */
export type StoredItemModifiers = DrinkModifiers & { cupNames?: string[] }

export type StoredOrderItem = Omit<OrderItem, 'unitPriceCentavos' | 'lineTotalCentavos'> & {
  orderId: string
  modifiers: StoredItemModifiers
  unitPriceCentavos: MoneyCentavos
  lineTotalCentavos: MoneyCentavos
  createdAt: string
  updatedAt: string
}

export type StoredOrder = Omit<Order, 'items'> & {
  items: StoredOrderItem[]
  deliveryDate: string | null
  paymentReceived: boolean
  rawSource: string
  addressSnapshot: string | null
  notes: string | null
  routePosition: number | null
  /** ISO 8601; storage-generated. Client writes are ignored. */
  paidAt: string | null
  /** ISO 8601; storage-generated. Client writes are ignored. */
  deliveredAt: string | null
}

/**
 * The customer resolution supplied to the atomic confirmation operation.  A
 * missing id means the server must resolve or create the customer in the same
 * transaction as the order and its items.
 */
export type OrderConfirmationCustomer = {
  id: string | null
  name: string
  phone: string | null
}

/**
 * Durable, idempotent order creation input.  The confirmation key and request
 * hash are persisted by Supabase (and mirrored by LocalAdapter) before a retry
 * can create another customer or order.
 */
export type OrderConfirmationInput = {
  order: StoredOrder
  customer: OrderConfirmationCustomer
  confirmationKey: string
  requestHash: string
}

export type Setting = {
  id: string
  key: string
  value: JsonValue
  createdAt: string
  updatedAt: string
}

export type StorageCollection =
  | 'products'
  | 'modifierGroups'
  | 'customers'
  | 'orders'
  | 'orderItems'
  | 'settings'

export type StorageEntityByCollection = {
  products: StoredProduct
  modifierGroups: StoredModifierGroup
  customers: StoredCustomer
  orders: StoredOrder
  orderItems: StoredOrderItem
  settings: Setting
}

export type StorageChange<C extends StorageCollection = StorageCollection> = {
  collection: C
  operation: 'insert' | 'update' | 'delete'
  entity: StorageEntityByCollection[C]
}

export type StorageUnsubscribe = () => void

export interface StorageAdapter {
  listProducts(): Promise<StoredProduct[]>
  getProduct(id: string): Promise<StoredProduct | null>
  createProduct(product: StoredProduct): Promise<StoredProduct>
  updateProduct(id: string, patch: Partial<Omit<StoredProduct, 'id' | 'createdAt'>>): Promise<StoredProduct>
  deleteProduct(id: string): Promise<void>

  // DORMANT — do not build on these without reading this first.
  // Nothing in the app calls them: no feature, page or hook reads or writes
  // modifier groups, and production `public.modifier_groups` is empty by design.
  // The modifiers actually in use are a fixed union in `src/domain/contracts.ts`,
  // assigned per product in `src/domain/catalog.ts`; each cup's chosen options are
  // stored as jsonb on `order_items.modifiers`. Owner-editable catalog data (prices,
  // availability, upcharges) goes through `getRuntimeCatalog()` and is persisted as
  // JSON in the `settings` table — that is the mechanism to extend for editable
  // modifiers, NOT this table. Writing here would put modifier config in two places
  // with the app honouring only one.
  listModifierGroups(): Promise<StoredModifierGroup[]>
  getModifierGroup(id: string): Promise<StoredModifierGroup | null>
  createModifierGroup(group: StoredModifierGroup): Promise<StoredModifierGroup>
  updateModifierGroup(id: string, patch: Partial<Omit<StoredModifierGroup, 'id' | 'createdAt'>>): Promise<StoredModifierGroup>
  deleteModifierGroup(id: string): Promise<void>

  listCustomers(): Promise<StoredCustomer[]>
  getCustomer(id: string): Promise<StoredCustomer | null>
  createCustomer(customer: StoredCustomer): Promise<StoredCustomer>
  updateCustomer(id: string, patch: Partial<Omit<StoredCustomer, 'id' | 'createdAt'>>): Promise<StoredCustomer>
  deleteCustomer(id: string): Promise<void>
  /**
   * Optional: one-shot customer delete (orders, profile setting, then customer).
   * SupabaseAdapter uses a Postgres RPC when present and falls back to the
   * multi-request path. LocalAdapter omits this so the JS helper stays the
   * observed call sequence in tests.
   */
  deleteCustomerCascade?(customerId: string): Promise<void>

  listOrders(filter?: { deliveryDate?: string }): Promise<StoredOrder[]>
  getOrder(id: string): Promise<StoredOrder | null>
  createOrder(order: StoredOrder): Promise<StoredOrder>
  /**
   * Atomically resolves the customer, creates the order/items, and records a
   * durable retry key.  SupabaseAdapter requires the hand-applied confirmation
   * RPC; it must not fall back to separate writes.
   */
  confirmOrderWithResolution?(input: OrderConfirmationInput): Promise<StoredOrder>
  updateOrder(id: string, patch: Partial<Omit<StoredOrder, 'id' | 'createdAt'>>): Promise<StoredOrder>
  deleteOrder(id: string): Promise<void>

  listOrderItems(orderId?: string): Promise<StoredOrderItem[]>
  getOrderItem(id: string): Promise<StoredOrderItem | null>
  createOrderItem(item: StoredOrderItem): Promise<StoredOrderItem>
  updateOrderItem(id: string, patch: Partial<Omit<StoredOrderItem, 'id' | 'createdAt'>>): Promise<StoredOrderItem>
  deleteOrderItem(id: string): Promise<void>

  listSettings(): Promise<Setting[]>
  getSetting(key: string): Promise<Setting | null>
  setSetting(setting: Omit<Setting, 'id'> & { id?: string }): Promise<Setting>
  deleteSetting(key: string): Promise<void>

  subscribe(listener: (change: StorageChange) => void): StorageUnsubscribe
  close(): Promise<void>
}

export type StorageAdapterEnvironment = {
  supabaseUrl?: string
  supabaseAnonKey?: string
}

export type { Customer, Order, OrderItem, OrderStatus, Product }
