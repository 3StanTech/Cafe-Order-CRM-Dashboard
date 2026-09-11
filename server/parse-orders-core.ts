/** Host-neutral Viber order extraction through the free-only OpenRouter API. */

import {
  openRouterApiKey,
  openRouterAppUrl,
  openRouterFallbackModel,
  openRouterModel,
} from './openrouter'

export type CoreResult = { status: number; body: object }

/** Reject raw HTTP bodies larger than this (bytes), before and after materializing. */
export const MAX_RAW_BODY_BYTES = 64 * 1024
/** Reject raw_text longer than this after JSON parsing. */
export const MAX_RAW_TEXT_CHARS = 50_000
/** Bound the complete provider attempt, including an explicit fallback. */
export const OPENROUTER_TIMEOUT_MS = 20_000

export const extractionInstruction = `Extract order structure from the supplied Viber conversation. Return JSON only in this shape:
{"orders":[{"customer_name":null,"items":[{"product_slug":null,"quantity":null,"level":null,"powder":null,"sweetness":null,"cup_names":[]}],"thermal_bags":[{"covered_cup_count":null}],"delivery_date":null,"address":null,"notes":null,"source_confidence":null,"unresolved_fields":[]}]}
Canonical product slugs: matcha-latte, strawberry-matcha, salted-maple-matcha, hojicha-latte, strawberry-hojicha, salted-maple-hojicha.
All drinks use oat milk. Matcha levels are L1, L2, L3. Hojicha levels are L1, L2, L3. Powders are yumeno and mk_isuzu. Sweetness none, light, regular, or extra is permitted only for plain matcha-latte and plain hojicha-latte. Thermal bags cover 1, 2, 3, or 4 cups.
cup_names holds a name per cup when one customer orders for several people ("one for Ana, one for Ben"): at most one name per cup in quantity, in the order mentioned, [] when none are given. Never invent names.
Keep uncertain values null and explain them in unresolved_fields. Ignore monetary claims. Do not add any keys beyond the requested structure.
Relative dates refer to Asia/Manila. The current date is supplied below. When no date is stated, leave delivery_date null so the dashboard can apply its configured next-available delivery day.`

/** Reads a server-only secret without assuming a Node global. */
export function openRouterConfigured(): boolean {
  try {
    return Boolean(openRouterApiKey() && openRouterModel())
  } catch {
    return false
  }
}

/** UTF-8 byte length without Node Buffer dependency (works on serverless and edge). */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

export function isContentLengthOverLimit(contentLengthHeader: string | null | undefined): boolean {
  if (contentLengthHeader == null || contentLengthHeader === '') return false
  const parsed = Number(contentLengthHeader)
  return Number.isFinite(parsed) && parsed > MAX_RAW_BODY_BYTES
}

export function oversizedBodyResult(): CoreResult {
  return { status: 413, body: { error: 'Request body is too large.' } }
}

function currentManilaDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every((key) => keys.has(key))
}

function hasKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return required.every((key) => key in value)
}

function nullableText(value: unknown): boolean { return value === undefined || value === null || typeof value === 'string' }
function nullableIsoDate(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}
function nullableInteger(value: unknown, minimum: number, maximum: number): boolean {
  return value === undefined || value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum)
}

/** Reject provider outputs that are empty, structurally partial, or contain prompt-injected fields. */
export function validateStructuralResponse(value: unknown): value is { orders: Record<string, unknown>[] } {
  if (!isRecord(value) || !onlyKeys(value, ['orders']) || !Array.isArray(value.orders) || value.orders.length === 0) return false
  return value.orders.every((order) => {
    if (!isRecord(order) || !onlyKeys(order, ['customer_name', 'items', 'thermal_bags', 'delivery_date', 'address', 'notes', 'source_confidence', 'unresolved_fields']) || !hasKeys(order, ['customer_name', 'items', 'thermal_bags', 'delivery_date', 'address', 'notes', 'source_confidence', 'unresolved_fields'])) return false
    if (!Array.isArray(order.items) || order.items.length === 0 || !Array.isArray(order.thermal_bags) || !Array.isArray(order.unresolved_fields)) return false
    if (!nullableText(order.customer_name) || !nullableIsoDate(order.delivery_date) || !nullableText(order.address) || !nullableText(order.notes)) return false
    if (!(order.source_confidence === undefined || order.source_confidence === null || (typeof order.source_confidence === 'number' && Number.isFinite(order.source_confidence) && order.source_confidence >= 0 && order.source_confidence <= 1))) return false
    if (!order.unresolved_fields.every((field) => typeof field === 'string')) return false
    if (!order.items.every((item) => {
      if (!isRecord(item) || !onlyKeys(item, ['product_slug', 'quantity', 'level', 'powder', 'sweetness', 'cup_names']) || !hasKeys(item, ['product_slug', 'quantity', 'level', 'powder', 'sweetness', 'cup_names'])) return false
      return nullableText(item.product_slug) && nullableInteger(item.quantity, 1, Number.MAX_SAFE_INTEGER) && nullableInteger(item.level, 1, 3) && nullableText(item.powder) && nullableText(item.sweetness) && Array.isArray(item.cup_names) && item.cup_names.every((name) => typeof name === 'string')
    })) return false
    return order.thermal_bags.every((bag) => isRecord(bag) && onlyKeys(bag, ['covered_cup_count']) && hasKeys(bag, ['covered_cup_count']) && nullableInteger(bag.covered_cup_count, 1, 4))
  })
}

export function textFromChoice(payload: unknown): { text: string; finishReason?: string } | null {
  if (!isRecord(payload) || payload.error != null || !Array.isArray(payload.choices) || payload.choices.length !== 1) return null
  const choice = payload.choices[0]
  if (!isRecord(choice) || !isRecord(choice.message)) return null
  if (choice.refusal != null || choice.message.refusal != null) return null
  const content = choice.message.content
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter(isRecord).filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text as string).join('')
      : ''
  return text.trim() ? { text: text.trim(), finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined } : null
}

export function parseProviderJson(text: string): unknown {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  return JSON.parse(cleaned)
}

function providerError(status: number): CoreResult {
  if (status === 429) return { status: 429, body: { error: 'OpenRouter free-model quota is busy. Try again shortly.' } }
  if (status >= 500) return { status: 503, body: { error: 'OpenRouter is temporarily unavailable. Try again shortly.' } }
  return { status: 502, body: { error: 'OpenRouter extraction request failed.' } }
}

/** Runs extraction for an already-read request body. Never throws. */
export async function extractOrders(rawBody: string | null | undefined, apiKey = openRouterApiKey()): Promise<CoreResult> {
  if (!apiKey) return { status: 503, body: { error: 'OpenRouter extraction is not configured: set OPENROUTER_API_KEY and a qualified OPENROUTER_MODEL.' } }
  if (rawBody != null && utf8ByteLength(rawBody) > MAX_RAW_BODY_BYTES) return oversizedBodyResult()

  let requestBody: unknown
  try { requestBody = JSON.parse(rawBody ?? '{}') } catch { return { status: 400, body: { error: 'Request body must be JSON.' } } }
  const rawText = isRecord(requestBody) ? requestBody.raw_text : undefined
  if (typeof rawText !== 'string' || !rawText.trim()) return { status: 400, body: { error: 'raw_text must be a nonblank string.' } }
  if (rawText.length > MAX_RAW_TEXT_CHARS) return { status: 413, body: { error: 'raw_text exceeds the maximum length.' } }

  let model: string | undefined
  let fallback: string | undefined
  try {
    model = openRouterModel()
    fallback = openRouterFallbackModel()
  } catch {
    return { status: 503, body: { error: 'OpenRouter extraction is not configured: OPENROUTER_MODEL and OPENROUTER_FALLBACK_MODEL must be pinned free models.' } }
  }
  if (!model) return { status: 503, body: { error: 'OpenRouter extraction is not configured: set a qualified OPENROUTER_MODEL after benchmarking.' } }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS)
  try {
    const requestBody: Record<string, unknown> = {
      model,
      ...(fallback ? { models: [fallback] } : {}),
      messages: [{ role: 'user', content: `${extractionInstruction}\n\nCURRENT DATE (ASIA/MANILA): ${currentManilaDate()}\n\nVIBER CONVERSATION:\n${rawText}` }],
      // A bounded response budget leaves room for several complete orders while
      // keeping the overall request deadline finite.
      max_tokens: 2400,
      response_format: { type: 'json_object' },
      provider: { data_collection: 'deny', sort: 'latency', require_parameters: true },
    }
    const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': openRouterAppUrl(),
        'X-Title': 'Gelly Dashboard',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    })
    if (!upstream.ok) return providerError(upstream.status)
    const payload: unknown = await upstream.json()
    const choice = textFromChoice(payload)
    if (!choice || choice.finishReason !== 'stop') return { status: 502, body: { error: 'OpenRouter returned incomplete extraction data. Try again.' } }
    const parsed = parseProviderJson(choice.text)
    if (!validateStructuralResponse(parsed)) return { status: 502, body: { error: 'OpenRouter returned incomplete or invalid extraction data. Try again.' } }
    return { status: 200, body: parsed }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return { status: 504, body: { error: 'OpenRouter extraction timed out.' } }
    return { status: 502, body: { error: 'OpenRouter returned invalid JSON.' } }
  } finally {
    clearTimeout(timer)
  }
}
