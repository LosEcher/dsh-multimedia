/**
 * dsh-multimedia — index.mjs (host half)
 *
 * Cordis bundle row `multimedia`:
 *   - Channel store (seed from config, runtime overrides in dataDir/channels.json)
 *   - Job store + background runner (dispatch queue / resume after restart)
 *   - HTTP API under /multimedia (client page + future integrations)
 *   - Agent tools: media_generate / media_list / media_status / media_export
 *
 * Secrets policy: API keys come from env (apiKeyEnv) or the runtime
 * channels.json (0600); never from cordis.patch.yml literals beyond a
 * placeholder, and never returned to the client (masked only).
 */
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, writeFileSync, renameSync, existsSync, copyFileSync, readdirSync, statSync, createReadStream, readFileSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  ChannelStore, JobStore, createJob, channelKey, maskChannel, needsKey,
  expandHome, extForMime, sizeLabel,
} from './lib/core.mjs'
import { createToolDefs } from './lib/tools.mjs'
import { createAdapters } from './lib/adapters.mjs'

const MAX_BODY = 2 * 1024 * 1024

/** 插件版本（/plugins/<id>/status 约定用；读 package.json，失败返回 null）。 */
function pluginVersion() {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? null
  } catch {
    return null
  }
}

function sendJson(res, status, json) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(json))
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) }
      catch (e) { reject(new Error(`invalid JSON body: ${e.message}`)) }
    })
    req.on('error', reject)
  })
}

export const name = 'dsh-multimedia'
export const inject = ['timer', 'webServer', 'tools']

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const dataDir = config.dataDir
  mkdirSync(join(dataDir, 'results'), { recursive: true })

  const channels = new ChannelStore(dataDir, config.channels)
  const jobs = new JobStore(dataDir)
  const adapters = createAdapters({ log: (msg) => ctx.logger?.info?.(msg) })

  /** api handed to adapters: key resolution, output saving, progress. */
  const api = {
    channelKey,
    progress: (jobId, percent, note) => {
      const j = jobs.get(jobId)
      if (!j) return
      j.progress = Math.max(j.progress ?? 0, Math.min(99, percent))
      j.note = note
      jobs.save()
    },
    /** Persist one output: from url (download), raw buffer, or data uri. */
    saveOutput: async (job, { kind, url, data, dataUri, mime, meta = {} }) => {
      const outDir = join(dataDir, 'results', job.id)
      mkdirSync(outDir, { recursive: true })
      let buffer
      let contentType = mime ?? ''
      if (data) {
        buffer = data
      } else if (dataUri) {
        const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUri)
        buffer = Buffer.from(m ? m[3] : dataUri, m?.[2] ? 'base64' : 'utf8')
        contentType = contentType || m?.[1] || 'image/png'
      } else if (url) {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 120000)
        try {
          const res = await fetch(url, { signal: ctrl.signal })
          if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
          buffer = Buffer.from(await res.arrayBuffer())
          contentType = contentType || res.headers.get('content-type') || ''
        } finally { clearTimeout(timer) }
      } else {
        throw new Error('saveOutput: 无 url/data/dataUri')
      }
      const idx = job.outputs.length
      const ext = extForMime(contentType, url)
      const file = join(outDir, `${idx}${ext}`)
      writeFileSync(file, buffer)
      const output = {
        kind,
        idx,
        url: url ?? '',
        localFile: file,
        fileUrl: `/multimedia/file/${job.id}/${idx}`,
        mime: contentType || 'application/octet-stream',
        size: buffer.length,
        sizeLabel: sizeLabel(buffer.length),
        ...meta,
      }
      job.outputs.push(output)
      jobs.save()
      return output
    },
  }

  /* ─────────────── balance / quota query (adapter.balance) ─────────────── */

  const BALANCE_TTL_MS = 30_000
  const balanceCache = new Map() // channelId -> { at, value }

  /** 查询渠道余额/配额。adapter 未实现 balance() 返回 null；结果缓存 30s，force 绕过。 */
  async function queryBalance(channel, force = false) {
    const adapter = adapters[channel.type]
    if (!adapter?.balance) return null
    if (!channelKey(channel)) return { kind: 'error', message: '未配置 API Key' }
    const hit = balanceCache.get(channel.id)
    if (!force && hit && Date.now() - hit.at < BALANCE_TTL_MS) return hit.value
    let value
    try {
      value = await adapter.balance(channel)
    } catch (e) {
      value = { kind: 'error', message: e?.message ?? String(e) }
    }
    balanceCache.set(channel.id, { at: Date.now(), value })
    return value
  }

  /* ─────────────── job runner ─────────────── */

  const CONCURRENCY = 2
  const running = new Set()

  /** Per-channel concurrency cap (channel.maxConcurrent); default = global. */
  function channelRunningCount(channelId) {
    let n = 0
    for (const id of running) {
      const j = jobs.get(id)
      if (j && j.channelId === channelId) n += 1
    }
    return n
  }

  async function runJob(job) {
    running.add(job.id)
    const channel = channels.get(job.channelId)
    try {
      if (!channel) throw new Error(`渠道不存在：${job.channelId}`)
      if (!channel.enabled) throw new Error(`渠道已停用：${channel.label}`)
      const key = channelKey(channel)
      if (needsKey(channel) && !key) throw new Error(`渠道 ${channel.label} 未配置 API Key（env ${channel.apiKeyEnv || '(字面量)'}）`)
      jobs.update(job.id, { status: 'running', note: '连接渠道…' })
      const adapter = adapters[channel.type]
      if (!adapter) throw new Error(`未知渠道类型：${channel.type}`)
      const result = await adapter.generate(channel, job, api)
      jobs.update(job.id, {
        status: 'succeeded',
        progress: 100,
        outputs: result.outputs ?? [],
        meta: { ...(job.meta ?? {}), ...(result.meta ?? {}) },
        note: '完成',
        error: '',
      })
    } catch (e) {
      jobs.update(job.id, { status: 'failed', error: e?.message ?? String(e), note: '失败' })
      ctx.logger?.warn?.(`[multimedia] job ${job.id} failed: ${e?.message}`)
    } finally {
      running.delete(job.id)
    }
  }

  function dispatch() {
    const queued = jobs.list({ status: 'queued' }).filter((j) => !running.has(j.id))
    for (const job of queued) {
      if (running.size >= CONCURRENCY) break
      const channel = channels.get(job.channelId)
      // Per-channel cap: free/rate-limited providers (e.g. pollinations
      // 1 concurrent / 5s) must not be overwhelmed by the global pool.
      const cap = channel?.maxConcurrent
      if (cap && channelRunningCount(job.channelId) >= cap) continue
      runJob(job)
    }
  }

  async function resumeStale() {
    for (const job of jobs.list({ status: 'running' })) {
      if (running.has(job.id)) continue
      const channel = channels.get(job.channelId)
      if (!channel) { jobs.update(job.id, { status: 'failed', error: '渠道已删除' }); continue }
      const adapter = adapters[channel.type]
      if (!adapter?.resume) { jobs.update(job.id, { status: 'failed', error: '渠道不支持恢复' }); continue }
      running.add(job.id)
      try {
        const result = await adapter.resume(channel, job, api)
        jobs.update(job.id, { status: 'succeeded', progress: 100, outputs: result.outputs ?? [], meta: { ...(job.meta ?? {}), ...(result.meta ?? {}) }, note: '完成（恢复）' })
      } catch (e) {
        jobs.update(job.id, { status: 'failed', error: e?.message ?? String(e) })
      } finally { running.delete(job.id) }
    }
  }

  const t1 = ctx.setInterval(dispatch, 1500)
  const t2 = ctx.setInterval(resumeStale, 6000)

  /* ─────────────── HTTP API ─────────────── */

  /* /plugins/<id>/status —— 2026-08-23 统一约定（与 dsh-dashboards / dsh-scheduler 同构）：
     工具与看板只读这一个信封，不再各插件自造形状。 */
  ctx.webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-multimedia/status',
    handler: (_req, res) => {
      const all = jobs.list({ limit: jobs.cap })
      const list = channels.list()
      return sendJson(res, 200, {
        ok: true,
        plugin: 'dsh-multimedia',
        version: pluginVersion(),
        counts: {
          channels: list.length,
          channelsEnabled: list.filter((c) => c.enabled).length,
          jobs: all.length,
          active: jobs.activeCount(),
          inflight: running.size,
          failed: all.filter((j) => j.status === 'failed').length,
        },
        lastError: null,
        detail: {
          dataDir,
          jobsRetained: jobs.cap,
          withOutputs: all.filter((j) => (j.outputs ?? []).length > 0).length,
        },
      })
    },
  })

  ctx.webServer.register({
    kind: 'prefix',
    path: '/multimedia',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const p = url.pathname
      const method = req.method ?? 'GET'
      try {
        /* channels */
        if (method === 'GET' && (p === '/multimedia' || p === '/multimedia/channels')) {
          return sendJson(res, 200, { channels: channels.list().map(maskChannel) })
        }
        if (method === 'PUT' && p === '/multimedia/channels') {
          const body = await readBody(req)
          const id = String(body.id ?? '')
          const list = channels.list()
          const found = list.find((c) => c.id === id)
          if (!found) return sendJson(res, 404, { error: `渠道不存在：${id}` })
          const patch = body.patch ?? {}
          if (typeof patch.enabled === 'boolean') found.enabled = patch.enabled
          if (typeof patch.label === 'string' && patch.label) found.label = patch.label
          if (typeof patch.baseUrl === 'string' && patch.baseUrl) found.baseUrl = patch.baseUrl.replace(/\/+$/, '')
          if (typeof patch.apiKey === 'string' && patch.apiKey) found.apiKey = patch.apiKey
          if (typeof patch.voice === 'string') found.voice = patch.voice
          if (patch.extra && typeof patch.extra === 'object') found.extra = { ...(found.extra ?? {}), ...patch.extra }
          channels.persist(list)
          return sendJson(res, 200, { ok: true, channel: maskChannel(channels.get(id)) })
        }
        if (method === 'POST' && p === '/multimedia/channels') {
          const body = await readBody(req)
          const list = channels.list()
          if (list.some((c) => c.id === String(body.id ?? ''))) return sendJson(res, 409, { error: `渠道 id 已存在：${body.id}` })
          const next = { id: String(body.id ?? `ch-${Date.now().toString(36)}`), type: body.type ?? 'fal', label: body.label ?? body.type ?? 'fal', enabled: body.enabled !== false, apiKeyEnv: body.apiKeyEnv ?? '', apiKey: body.apiKey ?? '', baseUrl: body.baseUrl ?? '', voice: body.voice ?? '', extra: body.extra ?? {} }
          list.push(next)
          channels.persist(list)
          return sendJson(res, 201, { ok: true, channel: maskChannel(channels.get(next.id)) })
        }
        if (method === 'DELETE' && p === '/multimedia/channels') {
          const id = url.searchParams.get('id') ?? ''
          const list = channels.list().filter((c) => c.id !== id)
          if (list.length === channels.list().length) return sendJson(res, 404, { error: `渠道不存在：${id}` })
          channels.persist(list)
          return sendJson(res, 200, { ok: true })
        }
        if (method === 'POST' && p === '/multimedia/test') {
          const body = await readBody(req)
          const channel = channels.get(String(body.channelId ?? ''))
          if (!channel) return sendJson(res, 404, { error: '渠道不存在' })
          const adapter = adapters[channel.type]
          if (!adapter?.test) return sendJson(res, 400, { error: '该渠道类型不支持连通性测试' })
          const result = await adapter.test(channel)
          return sendJson(res, result.ok ? 200 : 400, result)
        }
        if (method === 'GET' && p === '/multimedia/models') {
          const channel = channels.get(url.searchParams.get('channelId') ?? '')
          if (!channel) return sendJson(res, 404, { error: '渠道不存在' })
          const adapter = adapters[channel.type]
          const list = await adapter?.models?.(channel, url.searchParams.get('modality') ?? 'image')
          return sendJson(res, 200, { models: list ?? [] })
        }
        if (method === 'GET' && p === '/multimedia/balance') {
          const channel = channels.get(url.searchParams.get('channelId') ?? '')
          if (!channel) return sendJson(res, 404, { error: '渠道不存在' })
          const force = url.searchParams.get('force') === '1'
          const balance = await queryBalance(channel, force)
          if (!balance) return sendJson(res, 400, { error: '该渠道不支持余额查询' })
          return sendJson(res, balance.kind === 'error' ? 400 : 200, { balance })
        }

        /* jobs */
        if (method === 'POST' && p === '/multimedia/generate') {
          const body = await readBody(req)
          const channel = channels.get(String(body.channelId ?? ''))
          if (!channel) return sendJson(res, 404, { error: '渠道不存在' })
          if (!channel.enabled) return sendJson(res, 400, { error: `渠道已停用：${channel.label}` })
          const modality = String(body.modality ?? 'image')
          const adapter = adapters[channel.type]
          if (!adapter?.modalities?.includes(modality)) return sendJson(res, 400, { error: `渠道 ${channel.label} 不支持 ${modality}` })
          if (needsKey(channel) && !channelKey(channel)) return sendJson(res, 400, { error: `渠道 ${channel.label} 未配置 API Key` })
          const job = createJob({ channelId: channel.id, modality, prompt: body.prompt ?? '', params: body.params ?? {}, model: body.model ?? '', channelLabel: channel.label })
          jobs.add(job)
          dispatch()
          return sendJson(res, 201, { job: publicJob(job) })
        }
        if (method === 'POST' && p === '/multimedia/cancel') {
          const body = await readBody(req)
          const job = jobs.get(String(body.jobId ?? ''))
          if (!job) return sendJson(res, 404, { error: '任务不存在' })
          if (job.status === 'queued') jobs.update(job.id, { status: 'cancelled', note: '已取消' })
          else if (job.status === 'running') jobs.update(job.id, { status: 'cancelling', note: '取消中…' })
          return sendJson(res, 200, { ok: true, job: publicJob(jobs.get(job.id)) })
        }
        if (method === 'GET' && p === '/multimedia/tasks') {
          const list = jobs.list({
            limit: Number(url.searchParams.get('limit') ?? 100),
            modality: url.searchParams.get('modality') ?? undefined,
            status: url.searchParams.get('status') ?? undefined,
            channelId: url.searchParams.get('channelId') ?? undefined,
          })
          return sendJson(res, 200, { jobs: list.map(publicJob) })
        }
        const taskMatch = /^\/multimedia\/tasks\/([^/]+)$/.exec(p)
        if (method === 'GET' && taskMatch) {
          const job = jobs.get(taskMatch[1])
          if (!job) return sendJson(res, 404, { error: '任务不存在' })
          return sendJson(res, 200, { job: publicJob(job) })
        }
        if (method === 'DELETE' && taskMatch) {
          const job = jobs.remove(taskMatch[1])
          if (!job) return sendJson(res, 404, { error: '任务不存在' })
          return sendJson(res, 200, { ok: true })
        }

        /* files & export */
        const fileMatch = /^\/multimedia\/file\/([^/]+)\/(\d+)$/.exec(p)
        if (method === 'GET' && fileMatch) {
          const job = jobs.get(fileMatch[1])
          const output = job?.outputs?.[Number(fileMatch[2])]
          if (!output?.localFile || !existsSync(output.localFile)) return sendJson(res, 404, { error: '文件不存在' })
          res.writeHead(200, {
            'Content-Type': output.mime ?? 'application/octet-stream',
            'Content-Length': statSync(output.localFile).size,
            'Content-Disposition': `inline; filename="${job.id}-${output.idx}${extForMime(output.mime, output.url)}"`,
            'Cache-Control': 'no-store',
          })
          createReadStream(output.localFile).pipe(res)
          return undefined
        }
        if (method === 'GET' && p === '/multimedia/export') {
          const job = jobs.get(url.searchParams.get('jobId') ?? '')
          const output = job?.outputs?.[Number(url.searchParams.get('idx') ?? 0)]
          if (!output?.localFile || !existsSync(output.localFile)) return sendJson(res, 404, { error: '产物不存在' })
          const destPath = url.searchParams.get('destPath')
          if (!destPath) return sendJson(res, 400, { error: '需要 destPath' })
          const destDir = resolve(destPath)
          mkdirSync(destDir, { recursive: true })
          const name = `${job.id}-${output.idx}${extForMime(output.mime, output.url)}`
          copyFileSync(output.localFile, join(destDir, name))
          return sendJson(res, 200, { ok: true, saved: join(destDir, name) })
        }
        return sendJson(res, 404, { error: `not found: ${method} ${p}` })
      } catch (e) {
        ctx.logger?.warn?.(`[multimedia] api ${method} ${p}: ${e?.message}`)
        return sendJson(res, 500, { error: e?.message ?? String(e) })
      }
    },
  })

  /* ─────────────── agent tools ─────────────── */

  const disposers = []

  function publicJob(job) {
    return {
      id: job.id,
      channelId: job.channelId,
      channelLabel: job.channelLabel,
      modality: job.modality,
      prompt: job.prompt,
      model: job.model,
      params: job.params,
      status: job.status,
      progress: job.progress,
      note: job.note,
      error: job.error,
      outputs: job.outputs.map((o) => ({ ...o, localFile: undefined })),
      meta: {
        latencyMs: job.meta?.latencyMs,
        providerJobId: job.meta?.providerJobId,
        seed: job.meta?.seed,
        voice: job.meta?.voice,
        usage: job.meta?.usage ?? undefined,
      },
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    }
  }

  /** Wait for a job to reach a terminal state (cap ms); abort on exec.signal. */
  async function awaitJob(id, signal, capMs = 90000) {
    const deadline = Date.now() + capMs
    while (Date.now() < deadline) {
      if (signal?.aborted) return jobs.get(id)
      const j = jobs.get(id)
      if (!j) throw new Error(`任务不存在：${id}`)
      if (['succeeded', 'failed', 'cancelled'].includes(j.status)) return j
      await new Promise((r) => setTimeout(r, 1200))
    }
    return jobs.get(id)
  }

  function summarize(job) {
    const lines = [
      `任务 ${job.id}：${job.modality} @ ${job.channelLabel} — ${job.status}`,
      `提示词：${job.prompt.slice(0, 200)}${job.prompt.length > 200 ? '…' : ''}`,
    ]
    if (job.model) lines.push(`模型：${job.model}`)
    if (job.error) lines.push(`错误：${job.error}`)
    for (const o of job.outputs ?? []) {
      lines.push(`产物[${o.idx}] (${o.kind}, ${o.sizeLabel}): ${o.localFile || o.url}`)
    }
    if (job.meta?.latencyMs) lines.push(`耗时：${(job.meta.latencyMs / 1000).toFixed(1)}s`)
    const usage = job.meta?.usage
    if (usage && typeof usage === 'object') {
      const parts = []
      if (typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number') {
        parts.push(`${usage.prompt_tokens}+${usage.completion_tokens} tok`)
      } else if (typeof usage.total_tokens === 'number') {
        parts.push(`${usage.total_tokens} tok`)
      }
      // xAI 的 cost_in_usd_ticks：1e9 ticks = $1（换算系数按 xAI 文档）
      if (typeof usage.cost_in_usd_ticks === 'number') {
        parts.push(`$${(usage.cost_in_usd_ticks / 1e9).toFixed(4)}`)
      }
      if (parts.length) lines.push(`用量：${parts.join('，')}`)
    }
    return lines.join('\n')
  }

  /* ─────────────── agent tools（定义见 lib/tools.mjs，纯模块可预检） ─────────────── */

  for (const def of createToolDefs({ channels, jobs, awaitJob, summarize, dataDir, dispatch, queryBalance })) {
    disposers.push(ctx.tools.register(defineTool(def)))
  }

  ctx.on('dispose', () => {
    clearInterval(t1)
    clearInterval(t2)
    for (const d of disposers) { try { d() } catch { /* ignore */ } }
  })
}

apply.inject = inject

/** Config resolution: defaulting happens here, never inline in schema. */
function resolveConfig(raw) {
  const dataDir = expandHome(raw?.dataDir)
  return {
    dataDir,
    channels: Array.isArray(raw?.channels) ? raw.channels : [],
  }
}
