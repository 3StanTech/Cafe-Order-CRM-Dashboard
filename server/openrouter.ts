/** Small, dependency-free OpenRouter configuration helpers shared by server routes. */

const PINNED_FREE_MODEL = /^[^/\s]+\/[^/\s]+:free$/

export function isPinnedFreeModelId(modelId: string): boolean {
  const normalized = modelId.trim()
  return PINNED_FREE_MODEL.test(normalized) && !normalized.startsWith('openrouter/auto')
}

export function assertPrimaryModelId(modelId: string): string {
  const normalized = modelId.trim()
  if (!isPinnedFreeModelId(normalized)) {
    throw new Error('OpenRouter parser model must be a pinned free model id ending in :free.')
  }
  return normalized
}

export function assertFallbackModelId(modelId: string): string {
  const normalized = modelId.trim()
  if (!isPinnedFreeModelId(normalized)) {
    throw new Error('OpenRouter parser fallback must be a pinned free model id ending in :free.')
  }
  return normalized
}

function env(name: string): string | undefined {
  const processValue = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name]
  return typeof processValue === 'string' && processValue.trim() ? processValue.trim() : undefined
}

export function openRouterApiKey(): string | undefined {
  return env('OPENROUTER_API_KEY')
}

export function openRouterModel(): string | undefined {
  const configured = env('OPENROUTER_MODEL')
  return configured ? assertPrimaryModelId(configured) : undefined
}

/** One explicit fallback is allowed; an absent fallback keeps the request single-model. */
export function openRouterFallbackModel(): string | undefined {
  const configured = env('OPENROUTER_FALLBACK_MODEL')
  if (!configured) return undefined
  const fallback = assertFallbackModelId(configured)
  return fallback === openRouterModel() ? undefined : fallback
}

export function openRouterAppUrl(): string {
  return env('OPENROUTER_SITE_URL') ?? 'https://bubu-cafe.netlify.app'
}
