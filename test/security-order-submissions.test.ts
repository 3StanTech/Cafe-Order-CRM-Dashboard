import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePublicOrderInput } from '../server/order-submissions-core'
import { PUBLIC_ORDER_ENDPOINT } from '../src/features/public-order/api'

const root = resolve(process.cwd())

function walkSource(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'dev-dist') continue
    const full = join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) files.push(...walkSource(full))
    else if (['.ts', '.tsx', '.js', '.mjs'].includes(extname(entry))) files.push(full)
  }
  return files
}

const publicInput = {
  customerName: 'Mika Santos',
  customerPhone: '09171234567',
  address: 'Makati City',
  deliveryDate: '2026-09-08',
  notes: null,
  items: [{ productSlug: 'matcha-latte', quantity: 1, modifiers: { level: 1, powder: 'yumeno' } }],
  thermalBags: [] as { coveredCupCount: 1 | 2 | 3 | 4 }[],
  quoteRevision: 'a'.repeat(64),
  quotedTotalCentavos: 20000,
  idempotencyKey: 'public-order-key-01',
}

describe('public order submission security', () => {
  it('exposes the Netlify public path and never bundles a service-role secret in client source', () => {
    expect(PUBLIC_ORDER_ENDPOINT).toBe('/.netlify/functions/order-submissions')
    for (const file of walkSource(join(root, 'src'))) {
      const text = readFileSync(file, 'utf8')
      expect(text, file).not.toMatch(/SERVICE_ROLE/)
      expect(text, file).not.toMatch(/serviceRoleKey/)
      expect(text, file).not.toMatch(/service_role/)
    }
  })

  it('mentions no-store on the public client fetch and on the HTTP adapter when present', () => {
    const client = readFileSync(join(root, 'src/features/public-order/api.ts'), 'utf8')
    expect(client).toMatch(/cache:\s*'no-store'/)
    const httpAdapter = join(root, 'server/order-submissions-http.ts')
    if (existsSync(httpAdapter)) {
      expect(readFileSync(httpAdapter, 'utf8')).toMatch(/no-store/)
    }
  })

  it('rejects a filled honeypot on parsePublicOrderInput', () => {
    const clean = parsePublicOrderInput({ ...publicInput, honeypot: '' })
    expect(clean).toHaveProperty('input')
    const filled = parsePublicOrderInput({ ...publicInput, honeypot: 'http://spam.test' })
    expect(filled).toEqual({ error: 'The order could not be submitted.' })
    const omitted = parsePublicOrderInput(publicInput)
    expect(omitted).toHaveProperty('input')
  })

  it('rejects a client-supplied deliveryOptions list instead of trusting it', () => {
    const smuggled = parsePublicOrderInput({
      ...publicInput,
      deliveryDate: '2027-01-01',
      deliveryOptions: [{ deliveryDate: '2027-01-01', deliveryWindowStart: '08:00', deliveryWindowEnd: '09:00' }],
    })
    expect(smuggled).toEqual({ error: 'The order form contains an unsupported field.' })
  })
})
