/**
 * dsh-multimedia — lib/core.mjs
 * Pure helpers (no cordis, no network): config normalization, channel store,
 * job store persistence, URL collection from provider payloads, misc utils.
 * Kept dependency-free so test/run.mjs can exercise it without a host.
 */
import { homedir } from 'node:os'
import { join, resolve, extname, basename, dirname } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export const KNOWN_TYPES = ['fal', 'elevenlabs', 'comfyui', 'pollinations', 'streamelements', 'googletts', 'cloudflare']
export const MODALITIES = ['image', 'video', 'audio', 'tts']
export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'cancelling']

/** 无需 API Key 的渠道类型（免费/本地）。 */
export const NO_KEY_TYPES = ['comfyui', 'pollinations', 'streamelements', 'googletts']
export function needsKey(channel) { return !NO_KEY_TYPES.includes(channel.type) }

/** Expand ~ and make absolute. */
export function expandHome(p) {
  if (typeof p !== 'string' || !p) return join(homedir(), '.dsh', 'multimedia')
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : resolve(p)
}

/** Normalize one channel entry; unknown types kept but flagged. */
export function normalizeChannel(raw, index) {
  const type = typeof raw?.type === 'string' && KNOWN_TYPES.includes(raw.type) ? raw.type : 'fal'
  return {
    id: String(raw?.id ?? `ch-${index}`),
    type,
    label: String(raw?.label ?? type),
    enabled: raw?.enabled !== false,
    apiKeyEnv: String(raw?.apiKeyEnv ?? ''),
    apiKey: String(raw?.apiKey ?? ''),
    baseUrl: String(raw?.baseUrl ?? '').replace(/\/+$/, ''),
    voice: typeof raw?.voice === 'string' ? raw.voice : '',
    extra: raw?.extra && typeof raw.extra === 'object' ? { ...raw.extra } : {},
  }
}

export function normalizeChannels(raw) {
  const list = Array.isArray(raw) ? raw : []
  const seen = new Set()
  const out = []
  list.forEach((c, i) => {
    const n = normalizeChannel(c, i)
    if (seen.has(n.id)) return
    seen.add(n.id)
    out.push(n)
  })
  return out
}

/** Resolve effective api key: env var first, literal fallback. */
export function channelKey(channel) {
  if (channel.apiKeyEnv && process.env[channel.apiKeyEnv]) return process.env[channel.apiKeyEnv]
  return channel.apiKey
}

/** Masked channel view for the client (never leak keys). */
export function maskChannel(c) {
  const key = channelKey(c)
  return {
    id: c.id,
    type: c.type,
    label: c.label,
    enabled: c.enabled,
    apiKeyEnv: c.apiKeyEnv,
    hasKey: !!key,
    keyHint: key ? key.slice(-4) : '',
    baseUrl: c.baseUrl,
    voice: c.voice,
    extra: c.extra,
  }
}

/** Runtime store: seed channels (from config) merged with channels.json (wins). */
export class ChannelStore {
  constructor(dataDir, seedChannels) {
    this.file = join(dataDir, 'channels.json')
    this.seed = normalizeChannels(seedChannels)
    this.runtime = []
    this.load()
  }

  load() {
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
        this.runtime = normalizeChannels(parsed.channels)
      } catch {
        this.runtime = []
      }
    }
  }

  list() {
    const byId = new Map(this.seed.map((c) => [c.id, c]))
    // runtime overrides seed fields (apiKey only when non-empty), adds new ones
    const merged = []
    for (const seed of this.seed) {
      const run = this.runtime.find((r) => r.id === seed.id)
      if (!run) { merged.push({ ...seed }); continue }
      merged.push({
        ...seed,
        ...run,
        apiKey: run.apiKey || seed.apiKey,
        apiKeyEnv: run.apiKeyEnv || seed.apiKeyEnv,
        enabled: typeof run.enabled === 'boolean' ? run.enabled : seed.enabled,
        label: run.label || seed.label,
        baseUrl: run.baseUrl || seed.baseUrl,
      })
    }
    for (const run of this.runtime) if (!merged.some((m) => m.id === run.id)) merged.push({ ...run })
    return merged
  }

  get(id) {
    return this.list().find((c) => c.id === id)
  }

  persist(list) {
    this.runtime = normalizeChannels(list)
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify({ channels: this.runtime }, null, 2), { mode: 0o600 })
  }
}

/** Job store: in-memory map + jobs.json snapshot (atomic rename). */
export class JobStore {
  constructor(dataDir, cap = 500) {
    this.dir = dataDir
    this.file = join(dataDir, 'jobs.json')
    this.cap = cap
    this.jobs = new Map()
    this.load()
  }

  load() {
    if (!existsSync(this.file)) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      for (const j of parsed.jobs ?? []) {
        if (j && j.id) this.jobs.set(j.id, j)
      }
    } catch { /* corrupt snapshot ignored */ }
  }

  save() {
    mkdirSync(this.dir, { recursive: true })
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify({ jobs: [...this.jobs.values()].slice(-this.cap) }, null, 2))
    renameSync(tmp, this.file)
  }

  add(job) {
    this.jobs.set(job.id, job)
    this.save()
    return job
  }

  get(id) { return this.jobs.get(id) }

  update(id, patch) {
    const j = this.jobs.get(id)
    if (!j) return undefined
    Object.assign(j, patch, { updatedAt: Date.now() })
    this.save()
    return j
  }

  remove(id) {
    const j = this.jobs.get(id)
    this.jobs.delete(id)
    this.save()
    // drop local artifacts (guarded: only under results dir)
    const dir = join(this.dir, 'results', id)
    if (existsSync(dir)) {
      const root = resolve(join(this.dir, 'results'))
      const target = resolve(dir)
      if (target.startsWith(root + '/')) rmSync(target, { recursive: true, force: true })
    }
    return j
  }

  list({ limit = 100, modality, status, channelId } = {}) {
    let out = [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt)
    if (modality) out = out.filter((j) => j.modality === modality)
    if (status) out = out.filter((j) => j.status === status)
    if (channelId) out = out.filter((j) => j.channelId === channelId)
    return out.slice(0, limit)
  }

  activeCount(statuses = ['queued', 'running', 'cancelling']) {
    return [...this.jobs.values()].filter((j) => statuses.includes(j.status)).length
  }
}

/** Create a job record. */
export function createJob({ channelId, modality, prompt, params, model, channelLabel }) {
  return {
    id: randomUUID().slice(0, 8),
    channelId,
    channelLabel: channelLabel ?? channelId,
    modality: MODALITIES.includes(modality) ? modality : 'image',
    prompt: String(prompt ?? ''),
    params: params && typeof params === 'object' ? { ...params } : {},
    model: model ?? '',
    status: 'queued',
    progress: 0,
    error: '',
    outputs: [],
    meta: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/**
 * Collect {url} objects from a provider payload. Kind is inferred from the
 * key name (image/video/audio-ish), falling back to a generic 'file'.
 */
export function collectUrls(payload, preferKind) {
  const out = []
  if (!payload || typeof payload !== 'object') return out
  const push = (key, v) => {
    const k = key.toLowerCase()
    let kind = 'file'
    if (k.includes('image') || k.includes('img')) kind = 'image'
    else if (k.includes('video')) kind = 'video'
    else if (k.includes('audio') || k === 'output' || k.includes('tts')) kind = 'audio'
    if (preferKind && out.length === 0) kind = preferKind
    out.push({ kind, url: v })
  }
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string' && /^https?:\/\//.test(value)) push(key, value)
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && typeof item.url === 'string') push(key, item.url)
      }
    } else if (value && typeof value === 'object' && typeof value.url === 'string') push(key, value.url)
  }
  return out
}

/** Best-effort file extension for a downloaded blob. */
export function extForMime(mime, fallbackUrl) {
  const table = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
    'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg',
    'audio/webm': '.webm', 'application/json': '.json', 'application/octet-stream': '.bin',
  }
  if (table[mime]) return table[mime]
  if (fallbackUrl) {
    const e = extname(new URL(fallbackUrl).pathname)
    if (e && e.length <= 6) return e
  }
  return '.bin'
}

export function sizeLabel(n) {
  if (!Number.isFinite(n)) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function shortId(id) { return String(id).slice(0, 8) }

export { join, basename, statSync }
