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
 * Isolated fixtures may also need explicit `authenticated` table DML grants
 * so invoker RPCs such as `delete_customer_cascade` can run as the owner:
 *   grant select, insert, update, delete on public.customers, public.orders,
 *   public.order_items, public.settings to authenticated;
 *   grant execute on function public.delete_customer_cascade(uuid) to authenticated;
 */
import { createClient } from '@supabase/supabase-js'
import { getPublicOrderMenu, submitPublicOrder, SUBMISSION_RATE_LIMIT } from '../server/order-submissions-core'
import { handleOrderSubmissionsRequest } from '../server/order-submissions-http'
import crypto from 'node:crypto'

const url = process.env.SUPABASE_TEST_URL
const serviceRoleKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY
const anonymousKey = process.env.SUPABASE_TEST_ANON_KEY
const ownerEmail = process.env.SUPABASE_TEST_OWNER_EMAIL ?? 'angela@madebyangela.local'
const ownerPassword = process.env.SUPABASE_TEST_OWNER_PASSWORD
if (!url || !serviceRoleKey || !anonymousKey || !ownerPassword) throw new Error('Set SUPABASE_TEST_URL, SUPABASE_TEST_SERVICE_ROLE_KEY, SUPABASE_TEST_ANON_KEY, and SUPABASE_TEST_OWNER_PASSWORD for the isolated integration check.')
const host = new URL(url).hostname
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('This integration check only permits a loopback SUPABASE_TEST_URL.')
process.env.VITE_SUPABASE_URL = url
process.env.VITE_SUPABASE_ANON_KEY = anonymousKey
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey

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
const session = await owner.auth.getSession()
const accessToken = session.data.session?.access_token
assert(typeof accessToken === 'string' && accessToken.length > 0, 'owner session must include an access token')
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

const stored = await must(client.from('order_submissions').select('id,request_hash,review_hash,priced_items,delivery_fee_centavos,total_centavos').eq('reference', firstReceipt.reference).single(), 'read stored submission')
assert(stored.delivery_fee_centavos === 2500 && stored.total_centavos === 22500, 'thermal bag price must be stored in the verified quote')
assert(stored.priced_items.items[0].modifiers.cupNames?.[0] === 'Ana', 'cupNames must survive the core-to-SQL shape')
assert(typeof stored.review_hash === 'string' && stored.review_hash.length === 64, 'accept compares p_request_hash to the stored review_hash')
const serviceAccept = await client.rpc('accept_order_submission', { p_submission_id: stored.id, p_request_hash: stored.review_hash })
assert(serviceAccept.error, 'service-role accept must fail without an owner uid')
const stillPending = await must(client.from('order_submissions').select('status').eq('id', stored.id).single(), 'read submission after service-role accept')
assert(stillPending.status === 'pending', 'service-role accept must leave the submission pending')

const acceptResponse = await handleOrderSubmissionsRequest(
  new Request(`https://internal.invalid/.netlify/functions/order-submissions?action=accept&id=${stored.id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requestHash: stored.review_hash }),
  }),
  null,
)
assert(acceptResponse.status === 200, `HTTP accept should succeed (${acceptResponse.status})`)
assert(acceptResponse.headers.get('cache-control') === 'no-store', 'HTTP accept must not be cached')
const accepted = await acceptResponse.json() as { order_id?: string }
assert(typeof accepted.order_id === 'string', 'HTTP accept must return the new order id')
const acceptedOrder = await must(client.from('orders').select('id,status,payment_received,total_centavos,customer_id').eq('id', accepted.order_id).single(), 'read accepted HTTP order')
assert(acceptedOrder.status === 'new' && acceptedOrder.payment_received === false && acceptedOrder.total_centavos === 22500, 'accepted HTTP order must be new and unpaid with the stored total')
assert(typeof acceptedOrder.customer_id === 'string', 'accepted HTTP order must reference a customer')
const acceptedItem = await must(client.from('order_items').select('modifiers').eq('order_id', acceptedOrder.id).single(), 'read accepted HTTP item')
assert(acceptedItem.modifiers.cupNames?.[0] === 'Ana', 'accepted order must preserve cupNames')

const rejectSubmit = await submitPublicOrder(client, JSON.stringify({ ...body, idempotencyKey: `core-integration-reject-${runKey}` }), '198.51.100.12', now)
assert(rejectSubmit.status === 201, `second submission should be created for reject (${rejectSubmit.status})`)
const rejectReceipt = rejectSubmit.body as { reference: string }
const storedReject = await must(client.from('order_submissions').select('id,status').eq('reference', rejectReceipt.reference).single(), 'read reject submission')
const rejectResponse = await handleOrderSubmissionsRequest(
  new Request(`https://internal.invalid/.netlify/functions/order-submissions?action=reject&id=${storedReject.id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
  }),
  null,
)
assert(rejectResponse.status === 200, `HTTP reject should succeed (${rejectResponse.status})`)
assert(rejectResponse.headers.get('cache-control') === 'no-store', 'HTTP reject must not be cached')
const rejected = await must(client.from('order_submissions').select('status,accepted_order_id').eq('id', storedReject.id).single(), 'read rejected HTTP submission')
assert(rejected.status === 'rejected' && rejected.accepted_order_id == null, 'HTTP reject must mark the submission rejected without creating an order')

const concurrentSubmit = await submitPublicOrder(client, JSON.stringify({ ...body, idempotencyKey: `core-integration-concurrent-${runKey}` }), '198.51.100.13', now)
assert(concurrentSubmit.status === 201, `concurrent-accept submission should be created (${concurrentSubmit.status})`)
const concurrentReceipt = concurrentSubmit.body as { reference: string }
const concurrentRow = await must(client.from('order_submissions').select('id,review_hash').eq('reference', concurrentReceipt.reference).single(), 'read concurrent submission')
const concurrentRequest = () => handleOrderSubmissionsRequest(
  new Request(`https://internal.invalid/.netlify/functions/order-submissions?action=accept&id=${concurrentRow.id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requestHash: concurrentRow.review_hash }),
  }),
  null,
)
const [concurrentA, concurrentB] = await Promise.all([concurrentRequest(), concurrentRequest()])
assert(concurrentA.status === 200 && concurrentB.status === 200, `concurrent HTTP accepts must both resolve (${concurrentA.status}/${concurrentB.status})`)
const concurrentBodies = [await concurrentA.json(), await concurrentB.json()] as { order_id?: string }[]
assert(typeof concurrentBodies[0].order_id === 'string' && concurrentBodies[0].order_id === concurrentBodies[1].order_id, 'concurrent accepts must return the same order id')
const concurrentOrders = await must(client.from('orders').select('id').eq('id', concurrentBodies[0].order_id), 'count concurrent accepted orders')
assert(Array.isArray(concurrentOrders) && concurrentOrders.length === 1, 'concurrent accepts must not create two orders')

const tombstoneSubmit = await submitPublicOrder(client, JSON.stringify({
  ...body,
  customerName: `Synthetic Tombstone ${runKey}`,
  idempotencyKey: `core-integration-tombstone-${runKey}`,
}), '198.51.100.15', now)
assert(tombstoneSubmit.status === 201, `tombstone submission should be created (${tombstoneSubmit.status})`)
const tombstoneReceipt = tombstoneSubmit.body as { reference: string }
const tombstoneRow = await must(client.from('order_submissions').select('id,review_hash').eq('reference', tombstoneReceipt.reference).single(), 'read tombstone submission')
const tombstoneAccept = await handleOrderSubmissionsRequest(
  new Request(`https://internal.invalid/.netlify/functions/order-submissions?action=accept&id=${tombstoneRow.id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requestHash: tombstoneRow.review_hash }),
  }),
  null,
)
assert(tombstoneAccept.status === 200, `tombstone accept should succeed (${tombstoneAccept.status})`)
const tombstoneAccepted = await tombstoneAccept.json() as { order_id?: string }
assert(typeof tombstoneAccepted.order_id === 'string', 'tombstone accept must create an operational order')
const tombstoneOrder = await must(client.from('orders').select('id,customer_id').eq('id', tombstoneAccepted.order_id).single(), 'read tombstone order')
await must(client.from('orders').delete().eq('id', tombstoneOrder.id).select('id'), 'delete tombstone operational order')
const tombstone = await must(client.from('order_submissions').select('status,accepted_order_id').eq('id', tombstoneRow.id).single(), 'read tombstoned submission')
assert(tombstone.status === 'accepted' && tombstone.accepted_order_id == null, 'deleting the accepted order must null the submission reference without changing accepted status')
const resurrect = await handleOrderSubmissionsRequest(
  new Request(`https://internal.invalid/.netlify/functions/order-submissions?action=accept&id=${tombstoneRow.id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requestHash: tombstoneRow.review_hash }),
  }),
  null,
)
assert(resurrect.status === 200, `tombstone retry should return the prior accepted result (${resurrect.status})`)
const resurrectBody = await resurrect.json() as { order_id?: string | null }
assert(resurrectBody.order_id == null, 'tombstone retry must not resurrect the deleted order')
const missingOrder = await client.from('orders').select('id').eq('id', tombstoneOrder.id).maybeSingle()
assert(!missingOrder.error && missingOrder.data == null, 'deleted operational order must stay deleted')
const cascade = await owner.rpc('delete_customer_cascade', { p_customer_id: tombstoneOrder.customer_id })
assert(!cascade.error, `owner delete_customer_cascade must still run after the accepted order is gone (${cascade.error?.code ?? 'ok'})`)
const missingCustomer = await client.from('customers').select('id').eq('id', tombstoneOrder.customer_id).maybeSingle()
assert(!missingCustomer.error && missingCustomer.data == null, 'customer cascade must remove the synthetic customer')

const casSubmit = await submitPublicOrder(client, JSON.stringify({ ...body, idempotencyKey: `core-integration-cas-${runKey}` }), '198.51.100.14', now)
assert(casSubmit.status === 201, `CAS submission should be created (${casSubmit.status})`)
const casReceipt = casSubmit.body as { reference: string }
const casRow = await must(client.from('order_submissions').select('id,review_hash,review_version,idempotency_key').eq('reference', casReceipt.reference).single(), 'read CAS submission')
const staleHash = 'e'.repeat(64)
assert(staleHash !== casRow.review_hash, 'CAS probe must use a hash that is not the current review hash')
const casUpdate = await handleOrderSubmissionsRequest(
  new Request(`https://internal.invalid/.netlify/functions/order-submissions?action=update&id=${casRow.id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      ...body,
      idempotencyKey: casRow.idempotency_key,
      expectedReviewVersion: casRow.review_version,
      expectedReviewHash: staleHash,
    }),
  }),
  null,
)
assert(casUpdate.status === 409, `owner update CAS mismatch must conflict (${casUpdate.status})`)
const casBody = await casUpdate.json() as { code?: string }
assert(casBody.code === 'REVIEW_STALE', 'owner update CAS mismatch must return REVIEW_STALE')
const casUnchanged = await must(client.from('order_submissions').select('review_hash,review_version,address_snapshot').eq('id', casRow.id).single(), 'read CAS submission after mismatch')
assert(casUnchanged.review_hash === casRow.review_hash && casUnchanged.review_version === casRow.review_version, 'CAS mismatch must not write a new review revision')

const rateIp = '198.51.100.80'
let limited: { status: number } | null = null
for (let attempt = 0; attempt < SUBMISSION_RATE_LIMIT + 1; attempt += 1) {
  const result = await submitPublicOrder(client, JSON.stringify({ ...body, idempotencyKey: `core-integration-rate-${runKey}-${attempt}` }), rateIp, now)
  if (result.status === 429) {
    limited = result
    assert(attempt === SUBMISSION_RATE_LIMIT, `hashed-IP rate limit should trip on attempt ${SUBMISSION_RATE_LIMIT + 1}, not ${attempt + 1}`)
    break
  }
  assert(result.status === 201, `rate-limit attempt ${attempt + 1} should insert before the cap (${result.status})`)
}
assert(limited?.status === 429, 'hashed-IP rate limit must return 429 after the per-window cap')

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
console.log('public order core integration passed: menu quote, server pricing, reconfirmation, idempotency, SQL round-trip, service-role accept denial, HTTP owner accept/reject, concurrent accept, tombstone, owner update CAS, hashed-IP rate limit, and anonymous denial')
