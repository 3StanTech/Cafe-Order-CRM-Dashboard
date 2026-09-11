/**
 * Offline-safe OpenRouter free-model qualification harness.
 *
 * Does nothing billed unless OPENROUTER_API_KEY is set in the environment.
 * Never prints the key. Never selects paid models or openrouter/auto.
 *
 *   npx --no-install jiti scripts/openrouter-benchmark.ts [--out path]
 *
 * Output path: --out / positional CLI arg, else OPENROUTER_BENCHMARK_OUT, else
 * os.tmpdir()/openrouter-benchmark.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { isPinnedFreeModelId } from '../server/openrouter'
import {
  extractionInstruction,
  OPENROUTER_TIMEOUT_MS,
  parseProviderJson,
  textFromChoice,
  validateStructuralResponse,
} from '../server/parse-orders-core'
import {
  BENCHMARK_CURRENT_DATE,
  openRouterBenchmarkFixtures,
  type BenchmarkFixture,
  type ExpectedItem,
  type ExpectedOrder,
} from '../test/fixtures/import/builder/openrouter-benchmark-fixtures'

export { BENCHMARK_CURRENT_DATE, openRouterBenchmarkFixtures }
export type { BenchmarkFixture, ExpectedItem, ExpectedOrder }

export const TARGET_MEDIAN_MS = 10_000
export const MAX_CANDIDATES = 3
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'
const DEFAULT_OUTPUT_NAME = 'openrouter-benchmark.json'

export type CandidateRun = {
  model: string
  conversation: string
  ok: boolean
  latencyMs: number
  error?: string
}

export type BenchmarkFile = {
  status: 'qualified' | 'unresolved'
  reason: string
  generatedAt: string
  keyPresent: boolean
  networkCalled: boolean
  candidates: string[]
  conversations: number
  targetMedianMs: number
  winner: { model: string; medianMs: number } | null
  results: CandidateRun[]
}

export type OpenRouterModel = {
  id?: unknown
  supported_parameters?: unknown
  architecture?: { output_modalities?: unknown }
}

export type ProviderExtraction =
  | { ok: true; parsed: { orders: Record<string, unknown>[] } }
  | { ok: false; error: string }

export function conversations(): readonly BenchmarkFixture[] {
  return openRouterBenchmarkFixtures
}

function median(values: number[]): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function env(name: string): string | undefined {
  const value = process.env[name]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function trailingScriptArgs(argv: string[]): string[] {
  const index = argv.findIndex((arg) => {
    const normalized = arg.replaceAll('\\', '/')
    return normalized.endsWith('/openrouter-benchmark.ts')
      || normalized.endsWith('/openrouter-benchmark.js')
      || normalized === 'openrouter-benchmark.ts'
      || normalized === 'openrouter-benchmark.js'
  })
  return index >= 0 ? argv.slice(index + 1) : argv.slice(2)
}

export function resolveOutputPath(cliArgs?: string[], envValue = env('OPENROUTER_BENCHMARK_OUT')): string {
  const args = cliArgs ?? trailingScriptArgs(process.argv)
  const eq = args.find((arg) => arg.startsWith('--out='))
  if (eq) {
    const value = eq.slice('--out='.length).trim()
    if (value) return value
  }
  const flagAt = args.indexOf('--out')
  if (flagAt >= 0) {
    const value = args[flagAt + 1]
    if (value && !value.startsWith('-')) return value
  }
  const positional = args.find((arg) => !arg.startsWith('-'))
  if (positional) return positional
  if (envValue && envValue.trim()) return envValue.trim()
  return join(tmpdir(), DEFAULT_OUTPUT_NAME)
}

export function writeResult(payload: BenchmarkFile, outputPath: string): void {
  const parent = dirname(outputPath)
  if (parent) mkdirSync(parent, { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`)
}

function unresolved(reason: string, extras: Partial<BenchmarkFile> = {}): BenchmarkFile {
  return {
    status: 'unresolved',
    reason,
    generatedAt: new Date().toISOString(),
    keyPresent: Boolean(env('OPENROUTER_API_KEY')),
    networkCalled: false,
    candidates: [],
    conversations: conversations().length,
    targetMedianMs: TARGET_MEDIAN_MS,
    winner: null,
    results: [],
    ...extras,
  }
}

function trimmed(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const next = value.trim()
  return next ? next : null
}

function sameStringList(actual: unknown, expected: string[]): boolean {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index])
}

function itemEssentialsMatch(actual: Record<string, unknown>, expected: ExpectedItem): boolean {
  if (actual.product_slug !== expected.product_slug) return false
  if (actual.quantity !== expected.quantity) return false
  if ('level' in expected && actual.level !== expected.level) return false
  if ('powder' in expected && actual.powder !== expected.powder) return false
  if ('sweetness' in expected && actual.sweetness !== expected.sweetness) return false
  return sameStringList(actual.cup_names, expected.cup_names ?? [])
}

function orderEssentialsMatch(actual: Record<string, unknown>, expected: ExpectedOrder): boolean {
  if (trimmed(actual.customer_name) !== expected.customer_name.trim()) return false
  const items = actual.items as Record<string, unknown>[]
  if (items.length !== expected.items.length) return false
  if (!expected.items.every((item, index) => itemEssentialsMatch(items[index], item))) return false
  if ('delivery_date' in expected && (actual.delivery_date ?? null) !== expected.delivery_date) return false
  if ('address' in expected && trimmed(actual.address) !== (expected.address ?? null)) return false
  const expectedBags = expected.thermal_bags ?? []
  const bags = actual.thermal_bags as { covered_cup_count?: unknown }[]
  if (bags.length !== expectedBags.length) return false
  if (!expectedBags.every((bag, index) => bags[index]?.covered_cup_count === bag.covered_cup_count)) return false
  if (expected.unresolved === true && (!Array.isArray(actual.unresolved_fields) || actual.unresolved_fields.length === 0)) return false
  if (expected.unresolved === false && (!Array.isArray(actual.unresolved_fields) || actual.unresolved_fields.length !== 0)) return false
  return true
}

export function essentialFieldsPass(parsed: unknown, fixture: BenchmarkFixture): boolean {
  if (!validateStructuralResponse(parsed)) return false
  const actualOrders = parsed.orders
  if (actualOrders.length !== fixture.expectedOrders.length) return false
  const remaining = actualOrders.map((_, index) => index)
  for (const expected of fixture.expectedOrders) {
    const matchAt = remaining.findIndex((index) => orderEssentialsMatch(actualOrders[index], expected))
    if (matchAt < 0) return false
    remaining.splice(matchAt, 1)
  }
  return remaining.length === 0
}

export function isJsonCapableFree(model: OpenRouterModel): string | null {
  if (typeof model.id !== 'string' || !isPinnedFreeModelId(model.id)) return null
  const parameters = Array.isArray(model.supported_parameters)
    ? model.supported_parameters.filter((value): value is string => typeof value === 'string')
    : []
  const jsonCapable = parameters.includes('response_format') || parameters.includes('structured_outputs')
  return jsonCapable ? model.id : null
}

export function acceptProviderExtraction(payload: unknown): ProviderExtraction {
  const choice = textFromChoice(payload)
  if (!choice) return { ok: false, error: 'refused or incomplete' }
  if (choice.finishReason !== 'stop') {
    return { ok: false, error: choice.finishReason === 'length' ? 'truncated' : 'incomplete finish_reason' }
  }
  let parsed: unknown
  try {
    parsed = parseProviderJson(choice.text)
  } catch {
    return { ok: false, error: 'malformed JSON' }
  }
  if (!validateStructuralResponse(parsed)) return { ok: false, error: 'invalid structure' }
  return { ok: true, parsed }
}

export async function listFreeJsonCandidates(apiKey: string): Promise<string[] | { error: string }> {
  const response = await fetch(OPENROUTER_MODELS_URL, {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
  })
  const raw = await response.arrayBuffer()
  const decoded = new TextDecoder().decode(raw)
  if (!response.ok) return { error: `Live model listing failed (${response.status}).` }
  let payload: unknown
  try {
    payload = JSON.parse(decoded)
  } catch {
    return { error: 'Live model listing returned malformed JSON.' }
  }
  const rows = payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
    ? (payload as { data: OpenRouterModel[] }).data
    : []
  const selected: string[] = []
  for (const row of rows) {
    const id = isJsonCapableFree(row)
    if (!id) continue
    selected.push(id)
    if (selected.length >= MAX_CANDIDATES) break
  }
  return selected
}

export async function runConversation(apiKey: string, model: string, fixture: BenchmarkFixture): Promise<CandidateRun> {
  const started = Date.now()
  if (!isPinnedFreeModelId(model)) {
    return { model, conversation: fixture.name, ok: false, latencyMs: Date.now() - started, error: 'paid or auto model rejected' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS)
  try {
    const response = await fetch(OPENROUTER_CHAT_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://bubu-tracker.netlify.app',
        'X-Title': 'Gelly Dashboard benchmark',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: `${extractionInstruction}\n\nCURRENT DATE (ASIA/MANILA): ${BENCHMARK_CURRENT_DATE}\n\nVIBER CONVERSATION:\n${fixture.text}` }],
        max_tokens: 2400,
        response_format: { type: 'json_object' },
        provider: { data_collection: 'deny', sort: 'latency', require_parameters: true },
      }),
      signal: controller.signal,
    })
    const decoded = new TextDecoder().decode(await response.arrayBuffer())
    if (!response.ok) {
      return { model, conversation: fixture.name, ok: false, latencyMs: Date.now() - started, error: `HTTP ${response.status}` }
    }
    let payload: unknown
    try {
      payload = JSON.parse(decoded)
    } catch {
      return { model, conversation: fixture.name, ok: false, latencyMs: Date.now() - started, error: 'malformed JSON' }
    }
    const accepted = acceptProviderExtraction(payload)
    if (!accepted.ok) {
      return { model, conversation: fixture.name, ok: false, latencyMs: Date.now() - started, error: accepted.error }
    }
    const ok = essentialFieldsPass(accepted.parsed, fixture)
    return {
      model,
      conversation: fixture.name,
      ok,
      latencyMs: Date.now() - started,
      ...(ok ? {} : { error: 'essential fields missing' }),
    }
  } catch (error) {
    const latencyMs = Date.now() - started
    const name = error instanceof Error ? error.name : 'Error'
    return { model, conversation: fixture.name, ok: false, latencyMs, error: name === 'AbortError' ? 'timed out' : 'request failed' }
  } finally {
    clearTimeout(timer)
  }
}

function report(payload: BenchmarkFile, outputPath: string): void {
  console.log(`OpenRouter benchmark ${payload.status}: ${payload.reason}`)
  for (const result of payload.results) {
    const detail = result.error ? ` (${result.error})` : ''
    console.log(`${result.model} | ${result.conversation}: ${result.ok ? 'pass' : 'fail'} ${result.latencyMs}ms${detail}`)
  }
  console.log(`Wrote ${outputPath}`)
}

export async function runBenchmark(argv = process.argv): Promise<BenchmarkFile> {
  const outputPath = resolveOutputPath(trailingScriptArgs(argv))
  const apiKey = env('OPENROUTER_API_KEY')
  const fixtures = conversations()
  if (!apiKey) {
    const payload = unresolved('OPENROUTER_API_KEY is unset; no network calls were made. Readiness stays unresolved until a free model is qualified.')
    writeResult(payload, outputPath)
    report(payload, outputPath)
    return payload
  }

  const listed = await listFreeJsonCandidates(apiKey)
  if (!Array.isArray(listed)) {
    const payload = unresolved(listed.error, { keyPresent: true, networkCalled: true })
    writeResult(payload, outputPath)
    report(payload, outputPath)
    return payload
  }
  if (listed.length === 0) {
    const payload = unresolved('No currently listed JSON-capable :free models passed the pin check. Paid and auto routing were not used.', {
      keyPresent: true,
      networkCalled: true,
    })
    writeResult(payload, outputPath)
    report(payload, outputPath)
    return payload
  }

  const results: CandidateRun[] = []
  for (const model of listed) {
    if (!isPinnedFreeModelId(model)) continue
    for (const fixture of fixtures) {
      results.push(await runConversation(apiKey, model, fixture))
    }
  }

  const byModel = new Map<string, CandidateRun[]>()
  for (const result of results) {
    const bucket = byModel.get(result.model) ?? []
    bucket.push(result)
    byModel.set(result.model, bucket)
  }

  let winner: { model: string; medianMs: number } | null = null
  for (const [model, runs] of byModel) {
    if (runs.length !== fixtures.length || runs.some((run) => !run.ok)) continue
    const medianMs = median(runs.map((run) => run.latencyMs))
    if (!winner || medianMs < winner.medianMs) winner = { model, medianMs }
  }

  const qualified = winner !== null && winner.medianMs < TARGET_MEDIAN_MS
  const payload: BenchmarkFile = {
    status: qualified ? 'qualified' : 'unresolved',
    reason: qualified
      ? `Fastest fully passing free model is ${winner!.model} at median ${Math.round(winner!.medianMs)}ms.`
      : winner
        ? `Fastest fully passing free model is ${winner.model}, but median ${Math.round(winner.medianMs)}ms exceeds the ${TARGET_MEDIAN_MS}ms target.`
        : 'No listed free candidate passed every essential field. Readiness stays unresolved.',
    generatedAt: new Date().toISOString(),
    keyPresent: true,
    networkCalled: true,
    candidates: listed,
    conversations: fixtures.length,
    targetMedianMs: TARGET_MEDIAN_MS,
    winner,
    results,
  }
  writeResult(payload, outputPath)
  report(payload, outputPath)
  return payload
}

const invokedDirectly = process.argv.some((arg) => {
  const normalized = arg.replaceAll('\\', '/')
  return normalized.endsWith('/openrouter-benchmark.ts') || normalized.endsWith('/openrouter-benchmark.js')
})
if (invokedDirectly) {
  await runBenchmark()
}
