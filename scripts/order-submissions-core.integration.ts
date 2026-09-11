/**
 * Opt-in integration check for the public order boundary.
 *
 * Run against an isolated Supabase database only:
 *   SUPABASE_TEST_URL=... SUPABASE_TEST_SERVICE_ROLE_KEY=... \
 *   SUPABASE_TEST_NOW=2026-09-07T10:00:00Z \
 *   npx jiti scripts/order-submissions-core.integration.ts
 *
 * The script never prints credentials. It assumes the additive submission
 * migration has already been applied and seeds only synthetic test rows.
 */
import { createClient } from '@supabase/supabase-js'
import { getPublicOrderMenu, submitPublicOrder } from '../server/order-submissions-core'
import crypto from 'node:crypto'

const url = process.env.SUPABASE_TEST_URL
const serviceRoleKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY
const anonymousKey = process.env.SUPABASE_TEST_ANON_KEY
const ownerEmail = process.env.SUPABASE_TEST_OWNER_EMAIL ?? 'angela@madebyangela.local'
const ownerPassword = process.env.SUPABASE_TEST_OWNER_PASSWORD
if (!url || !serviceRoleKey || !anonymousKey || !ownerPassword) throw new Error('Set SUPABASE_TEST_URL, SUPABASE_TEST_SERVICE_ROLE_KEY, SUPABASE_TEST_ANON_KEY, and SUPABASE_TEST_OWNER_PASSWORD for the isolated integration check.')
const host = new URL(url).hostname
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('This integration check only permits a loopback SUPABASE_TEST_URL.')

const client = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
const anonymous = createClient(url, anonymousKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
const owner = createClient(url, anonymousKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
const now = new Date(process.env.SUPABASE_TEST_NOW ?? '2026-09-07T10:00:00Z')
const settings = {
  productBasePrices: { 'matcha-latte': 20000, 'strawberry-matcha': 22000, 'salted-maple-matcha': 22000, 'hojicha-latte': 18000, 'strawberry-hojicha': 20000, 'salted-maple-hojicha': 20000 },
  productAvailability: { 'matcha-latte': true, 'strawberry-matcha': true, 'salted-maple-matcha': true, 'hojicha-latte': true, 'strawberry-hojicha': true, 'salted-maple-hojicha': true },
  matchaLevelUpcharges: { 1: 0, 2: 2500, 3: 5000 }, hojichaLevelUpcharges: { 1: 0, 2: 2000, 3: 4000 },
  powderUpcharges: { yumeno: 0, mk_isuzu: 6000 }, thermalBagPrices: { 1: 2500, 2: 3000, 3: 3500, 4: 3500 },
  openDays: ['tuesday', 'wednesday', 'friday'], orderCutoff: '20:00', deliveryWindowStart: '08:00', deliveryWindowEnd: '09:00',
  gCashNumber: '09171234567', businessName: 'Made by Angela', businessDescription: 'Synthetic integration menu', businessContact: '09171234567',
}

async function must<T>(query: PromiseLike<{ data: T; error: { message: string } | null }>, label: string): Promise<T> {
  const result = await query
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  return result.data
}
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }

const runKey = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
const productNames = [['Matcha Latte', 20000], ['Strawberry Matcha', 22000], ['Salted Maple Matcha', 22000], ['Hojicha Latte', 18000], ['Strawberry Hojicha', 20000], ['Salted Maple Hojicha', 20000]]
const productRows = await must(client.from('products').insert(productNames.map(([name, price]) => ({ name, price_centavos: price, active: true }))).select('id,name'), 'seed products')
await must(client.from('settings').upsert({ key: 'order_dashboard_settings', value: settings }, { onConflict: 'key' }).select('key').single(), 'seed settings')
const users = await must(client.auth.admin.listUsers({ perPage: 100 }), 'list test users')
if (!users.users.some((user) => user.email?.toLowerCase() === ownerEmail.toLowerCase())) await must(client.auth.admin.createUser({ email: ownerEmail, password: ownerPassword, email_confirm: true }), 'seed owner')
await must(owner.auth.signInWithPassword({ email: ownerEmail, password: ownerPassword }), 'owner login')
const menuResult = await getPublicOrderMenu(client, now)
assert(menuResult.status === 200, 'public menu should be available with complete settings')
const menu = menuResult.body as { delivery: { deliveryDate: string }; quoteRevision: string }
assert(menu.quoteRevision.length === 64, 'public menu must expose a quote revision')

const body = {
  customerName: 'Synthetic Customer', customerPhone: '09170000000', address: 'Synthetic address', deliveryDate: menu.delivery.deliveryDate,
  notes: null, items: [{ productSlug: 'matcha-latte', quantity: 1, modifiers: { level: 1, powder: 'yumeno' }, cupNames: ['Ana'] }], thermalBags: [{ coveredCupCount: 1 }],
  quoteRevision: menu.quoteRevision, quotedTotalCentavos: 22500, idempotencyKey: `core-integration-key-${runKey}`,
}
const first = await submitPublicOrder(client, JSON.stringify(body), '198.51.100.10', now)
assert(first.status === 201, `first submission should be created (${first.status})`)
const firstReceipt = first.body as { reference: string; totalCentavos: number; pendingAngelaAcceptance: boolean }
assert(firstReceipt.totalCentavos === 22500 && firstReceipt.pendingAngelaAcceptance, 'receipt should preserve the verified pending quote')
const retry = await submitPublicOrder(client, JSON.stringify(body), '198.51.100.10', now)
assert(retry.status === 200 && (retry.body as { reference: string }).reference === firstReceipt.reference, 'same confirmation key should be idempotent')
const altered = await submitPublicOrder(client, JSON.stringify({ ...body, address: 'Different address' }), '198.51.100.10', now)
assert(altered.status === 409, 'confirmation key reuse with a different payload must be rejected')

const stored = await must(client.from('order_submissions').select('id,request_hash,priced_items,delivery_fee_centavos,total_centavos').eq('reference', firstReceipt.reference).single(), 'read stored submission')
assert(stored.delivery_fee_centavos === 2500 && stored.total_centavos === 22500, 'thermal bag price must be stored in the verified quote')
assert(stored.priced_items.items[0].modifiers.cupNames?.[0] === 'Ana', 'cupNames must survive the core-to-SQL shape')
const accepted = await must(owner.rpc('accept_order_submission', { p_submission_id: stored.id, p_request_hash: stored.request_hash }), 'accept core submission')
const acceptedOrder = await must(client.from('orders').select('id,status,payment_received,total_centavos').eq('id', accepted.order_id).single(), 'read accepted core order')
assert(acceptedOrder.status === 'new' && acceptedOrder.payment_received === false && acceptedOrder.total_centavos === 22500, 'accepted core order must be new and unpaid with the stored total')
const acceptedItem = await must(client.from('order_items').select('modifiers').eq('order_id', acceptedOrder.id).single(), 'read accepted core item')
assert(acceptedItem.modifiers.cupNames?.[0] === 'Ana', 'accepted order must preserve cupNames')

const changedSettings = { ...settings, productBasePrices: { ...settings.productBasePrices, 'matcha-latte': 21000 } }
await must(client.from('settings').update({ value: changedSettings }).eq('key', 'order_dashboard_settings').select('key').single(), 'change settings')
const stale = await submitPublicOrder(client, JSON.stringify({ ...body, idempotencyKey: 'core-stale-key-0001' }), '198.51.100.11', now)
assert(stale.status === 409 && stale.body.code === 'RECONFIRM_REQUIRED', 'changed pricing must require explicit reconfirmation')
assert((stale.body as { quoteRevision: string }).quoteRevision.length === 64, 'reconfirmation must include the current quote revision')

const deniedRead = await anonymous.from('order_submissions').select('id').eq('reference', firstReceipt.reference).single()
assert(deniedRead.error, 'anonymous clients must not read submissions')
const deniedWrite = await anonymous.from('order_submissions').insert({
  request_hash: 'a'.repeat(64), idempotency_key: `anonymous-write-${runKey}`, quote_revision: 'a'.repeat(64),
  customer_name: 'Anonymous', customer_phone: '09170000000', address_snapshot: 'blocked', delivery_date: body.deliveryDate,
  items: body.items, thermal_bags: [], catalog_snapshot: {}, priced_items: { items: [], thermal_bags: [], totals: {} },
  subtotal_centavos: 0, delivery_fee_centavos: 0, total_centavos: 0,
})
assert(deniedWrite.error, 'anonymous clients must not write submissions directly')
void productRows
console.log('public order core integration passed: menu quote, server pricing, reconfirmation, idempotency, SQL round-trip, owner acceptance, and anonymous denial')
