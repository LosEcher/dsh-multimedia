/**
 * dsh-multimedia — lib/adapters.mjs
 * Channel adapters: fal.ai (queue API), ElevenLabs (TTS + images), ComfyUI
 * (local, raw workflow JSON). Each exposes { modalities, models, test,
 * generate, resume }. fetchImpl/sleep/log are injectable for tests.
 */
import { extForMime } from './core.mjs'

const DEFAULT_HEADERS = { 'content-type': 'application/json' }

export function createAdapters({ fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} } = {}) {
  /** Small fetch wrapper with timeout + JSON/bytes handling. */
  async function req(url, { headers = {}, method = 'GET', body, json = false, timeoutMs = 60000, raw = false } = {}) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetchImpl(url, {
        method,
        headers: { ...headers },
        body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
        signal: ctrl.signal,
      })
      if (!res.ok) {
        let detail = ''
        try { detail = (await res.text()).slice(0, 500) } catch { /* ignore */ }
        throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`)
      }
      if (raw) return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? '' }
      if (json) return await res.json()
      const text = await res.text()
      try { return JSON.parse(text) } catch { return { __text: text } }
    } finally {
      clearTimeout(timer)
    }
  }

  /* ─────────────────────────── fal.ai ─────────────────────────── */

  function falBody(channel, job) {
    const p = job.params ?? {}
    const base = { seed: p.seed }
    switch (job.modality) {
      case 'image':
        return {
          ...base,
          prompt: job.prompt,
          image_size: p.image_size ?? 'square_hd',
          num_images: p.num_images ?? 1,
          num_inference_steps: p.steps,
          guidance_scale: p.guidance_scale,
          enable_safety_checker: p.enable_safety_checker ?? true,
        }
      case 'video':
        return {
          ...base,
          prompt: job.prompt,
          duration: p.duration ?? 5,
          aspect_ratio: p.aspect_ratio ?? '16:9',
          num_frames: p.num_frames,
          image_size: p.image_size,
          cfg_scale: p.cfg_scale,
          mode: p.mode,
        }
      case 'audio':
      case 'tts':
        // kokoro 用 prompt+voice；playai 等旧模型用 input+voice
        if ((job.model ?? '').includes('kokoro')) return { ...base, prompt: job.prompt, voice: p.voice ?? '' }
        return { ...base, input: job.prompt, voice: p.voice ?? '', voice_id: p.voice_id ?? '' }
      default:
        return { ...base, prompt: job.prompt }
    }
  }

  const falAdapter = {
    modalities: ['image', 'video', 'audio', 'tts'],
    models: async (channel, modality) => {
      const image = [
        { id: 'fal-ai/flux/schnell', label: 'FLUX.1 Schnell（快）' },
        { id: 'fal-ai/flux/dev', label: 'FLUX.1 Dev（质量）' },
        { id: 'fal-ai/recraft-v3', label: 'Recraft V3（设计）' },
      ]
      const video = [
        { id: 'fal-ai/kling-video/v2.1/standard', label: 'Kling 2.1 Standard' },
        { id: 'fal-ai/wan/v2.1/480p', label: 'Wan 2.1 480p（开源）' },
        { id: 'fal-ai/veo3', label: 'Veo 3（Premium，4-8s）' },
      ]
      const audio = [
        { id: 'fal-ai/kokoro', label: 'Kokoro TTS（开源，prompt+voice）' },
        { id: 'fal-ai/playai/tts/v3', label: 'PlayAI TTS v3（input+voice）' },
      ]
      if (modality === 'video') return video
      if (modality === 'audio' || modality === 'tts') return audio
      return image
    },
    test: async (channel) => {
      // 可达性探测：任何 HTTP 响应（含 404/405）都说明端点可达。
      try {
        const res = await fetchImpl(`${channel.baseUrl || 'https://queue.fal.run'}/`, {
          method: 'GET', signal: AbortSignal.timeout(8000),
        })
        return { ok: true, message: `fal.ai 队列端点可达（HTTP ${res.status}；API Key 有效性需真实生成验证）` }
      } catch (e) {
        return { ok: false, message: `不可达：${e.message}` }
      }
    },
    generate: async (channel, job, api) => {
      const model = job.model || 'fal-ai/flux/schnell'
      const base = channel.baseUrl || 'https://queue.fal.run'
      const headers = { ...DEFAULT_HEADERS, Authorization: `Key ${api.channelKey(channel)}` }
      const body = { ...falBody(channel, job), ...(job.params?.extra ?? {}) }
      const started = Date.now()
      log(`[fal] submit ${model} job=${job.id}`)
      const submitted = await req(`${base}/${model}`, { method: 'POST', headers, body, json: true, timeoutMs: 60000 })
      const providerJobId = submitted.request_id ?? submitted.id
      if (!providerJobId) throw new Error(`fal 未返回 request_id：${JSON.stringify(submitted).slice(0, 200)}`)
      // 优先使用响应里返回的 status_url/response_url（部分模型路径特殊）
      const statusUrl = submitted.status_url ?? `${base}/${model}/requests/${providerJobId}/status`
      const resultUrl = submitted.response_url ?? `${base}/${model}/requests/${providerJobId}`
      api.progress?.(job.id, 5, '已提交，排队中…')
      // poll status
      let payload
      for (let i = 0; i < 200; i += 1) {
        await sleep(1500)
        const st = await req(statusUrl, { headers, json: true, timeoutMs: 30000 })
        const status = st.status ?? ''
        if (status === 'COMPLETED') { api.progress?.(job.id, 60, '生成完成，拉取结果…'); break }
        if (status === 'ERROR' || status === 'CANCELLED') {
          throw new Error(`fal 任务失败：${status} ${st.detail ?? ''}`.trim())
        }
        api.progress?.(job.id, 10 + Math.min(45, i), `生成中…(${status})`)
      }
      payload = await req(resultUrl, { headers, json: true, timeoutMs: 60000 })
      api.progress?.(job.id, 75, '下载产物…')
      const urls = collect(payload, job.modality)
      if (!urls.length) throw new Error(`fal 响应中没有可下载产物：${JSON.stringify(payload).slice(0, 300)}`)
      const outputs = []
      for (const u of urls) {
        const saved = await api.saveOutput(job, { kind: u.kind, url: u.url })
        outputs.push(saved)
      }
      return {
        outputs,
        meta: { providerJobId, latencyMs: Date.now() - started, seed: payload.seed ?? body.seed },
      }
    },
    resume: async (channel, job, api) => {
      const model = job.model || 'fal-ai/flux/schnell'
      const base = channel.baseUrl || 'https://queue.fal.run'
      const headers = { ...DEFAULT_HEADERS, Authorization: `Key ${api.channelKey(channel)}` }
      const providerJobId = job.meta?.providerJobId
      if (!providerJobId) throw new Error('fal 任务无 providerJobId，无法恢复')
      let payload
      for (let i = 0; i < 200; i += 1) {
        await sleep(1500)
        const st = await req(`${base}/${model}/requests/${providerJobId}/status`, { headers, json: true, timeoutMs: 30000 })
        const status = st.status ?? ''
        if (status === 'COMPLETED') break
        if (status === 'ERROR' || status === 'CANCELLED') throw new Error(`fal 任务失败：${status}`)
        api.progress?.(job.id, 10 + Math.min(45, i), `恢复轮询…(${status})`)
      }
      payload = await req(`${base}/${model}/requests/${providerJobId}`, { headers, json: true, timeoutMs: 60000 })
      const urls = collect(payload, job.modality)
      const outputs = []
      for (const u of urls) outputs.push(await api.saveOutput(job, { kind: u.kind, url: u.url }))
      return { outputs, meta: { providerJobId } }
    },
  }

  /* ───────────────────────── ElevenLabs ───────────────────────── */

  const elevenlabsAdapter = {
    modalities: ['tts', 'image'],
    models: async (channel, modality) => {
      if (modality === 'image') return [{ id: 'eleven_flux_v2', label: 'Eleven Flux v2（默认）' }]
      // tts: live voice list, cached 5 min
      try {
        const headers = { 'xi-api-key': api.channelKey(channel) }
        const data = await req(`${channel.baseUrl || 'https://api.elevenlabs.io/v1'}/voices`, { headers, json: true, timeoutMs: 10000 })
        const voices = Array.isArray(data?.voices) ? data.voices : []
        return voices.slice(0, 50).map((v) => ({ id: v.voice_id, label: v.name || v.voice_id }))
      } catch {
        return [
          { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel（默认）' },
          { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Sarah' },
        ]
      }
    },
    test: async (channel) => {
      try {
        await req(`${channel.baseUrl || 'https://api.elevenlabs.io/v1'}/user`, {
          headers: { 'xi-api-key': api.channelKey(channel) },
          json: true, timeoutMs: 10000,
        })
        return { ok: true, message: 'ElevenLabs API Key 有效' }
      } catch (e) {
        return { ok: false, message: `鉴权失败：${e.message}` }
      }
    },
    generate: async (channel, job, api) => {
      const base = channel.baseUrl || 'https://api.elevenlabs.io/v1'
      const headers = { 'xi-api-key': api.channelKey(channel) }
      if (job.modality === 'tts') {
        const voice = job.params?.voice ?? channel.voice ?? '21m00Tcm4TlvDq8ikWAM'
        const fmt = job.params?.output_format ?? 'mp3_44100_128'
        const body = {
          text: job.prompt,
          model_id: job.model || 'eleven_multilingual_v2',
          voice_settings: {
            stability: job.params?.stability ?? 0.5,
            similarity_boost: job.params?.similarity_boost ?? 0.75,
            style: job.params?.style ?? 0,
            speaker_boost: job.params?.speaker_boost ?? false,
          },
          ...(job.params?.extra ?? {}),
        }
        const started = Date.now()
        const { buffer, contentType } = await req(
          `${base}/text-to-speech/${voice}?output_format=${fmt}`,
          { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body, raw: true, timeoutMs: 120000 },
        )
        const saved = await api.saveOutput(job, { kind: 'audio', data: buffer, mime: contentType || 'audio/mpeg' })
        return { outputs: [saved], meta: { voice, latencyMs: Date.now() - started } }
      }
      // image — ElevenLabs 已重构为异步 Flows：POST /v1/flows/image → id → 轮询 → content_url（签名 URL ~1h 过期）
      const body = {
        prompt: job.prompt,
        image_size: job.params?.image_size ?? '1024x1024',
        model: job.model || 'eleven_flux_v2',
        ...(typeof job.params?.seed === 'number' ? { seed: job.params.seed } : {}),
        ...(job.params?.extra ?? {}),
      }
      const started = Date.now()
      const submitted = await req(`${base}/flows/image`, {
        method: 'POST', headers: { ...headers, ...DEFAULT_HEADERS }, body, json: true, timeoutMs: 30000,
      })
      const flowId = submitted?.id
      if (!flowId) throw new Error(`ElevenLabs 未返回 flow id：${JSON.stringify(submitted).slice(0, 200)}`)
      api.progress?.(job.id, 10, '已提交，排队中…')
      const payload = await pollFlow(base, headers, flowId, job.id, api)
      const contentUrl = payload?.content_url
      if (!contentUrl) throw new Error(`ElevenLabs flow 无 content_url：${JSON.stringify(payload).slice(0, 300)}`)
      api.progress?.(job.id, 75, '下载产物…')
      const saved = await api.saveOutput(job, { kind: 'image', url: contentUrl, meta: { seed: job.params?.seed } })
      return { outputs: [saved], meta: { providerJobId: flowId, latencyMs: Date.now() - started } }
    },
    resume: async (channel, job, api) => {
      const base = channel.baseUrl || 'https://api.elevenlabs.io/v1'
      const flowId = job.meta?.providerJobId
      if (!flowId) throw new Error('ElevenLabs flow 无 providerJobId，无法恢复')
      const payload = await pollFlow(base, { 'xi-api-key': api.channelKey(channel) }, flowId, job.id, api)
      const contentUrl = payload?.content_url
      if (!contentUrl) throw new Error('ElevenLabs flow 无 content_url')
      const saved = await api.saveOutput(job, { kind: 'image', url: contentUrl })
      return { outputs: [saved], meta: { providerJobId: flowId } }
    },
  }

  /** Poll an ElevenLabs flow until terminal, return payload. */
  async function pollFlow(base, headers, flowId, jobId, api) {
    for (let i = 0; i < 300; i += 1) {
      await sleep(1500)
      const st = await req(`${base}/flows/${flowId}`, { headers, json: true, timeoutMs: 30000 })
      const status = st?.status ?? ''
      if (status === 'succeeded') { api.progress?.(jobId, 60, '生成完成，拉取结果…'); return st }
      if (status === 'failed' || status === 'error') throw new Error(`ElevenLabs flow 失败：${JSON.stringify(st).slice(0, 200)}`)
      api.progress?.(jobId, 10 + Math.min(45, i), `生成中…(${status || 'pending'})`)
    }
    throw new Error('ElevenLabs flow 轮询超时')
  }

  /* ─────────────────────────── ComfyUI ─────────────────────────── */

  const comfyuiAdapter = {
    modalities: ['image', 'video'],
    models: async () => [{ id: '', label: '原始工作流 JSON 模式' }],
    test: async (channel) => {
      try {
        await req(`${channel.baseUrl || 'http://127.0.0.1:8188'}/system_stats`, { json: true, timeoutMs: 8000 })
        return { ok: true, message: 'ComfyUI 可达' }
      } catch (e) {
        return { ok: false, message: `不可达：${e.message}` }
      }
    },
    generate: async (channel, job, api) => {
      const base = channel.baseUrl || 'http://127.0.0.1:8188'
      const workflow = job.params?.workflow
      if (!workflow) throw new Error('ComfyUI 模式需要提供工作流 JSON（params.workflow）')
      let graph
      try { graph = typeof workflow === 'string' ? JSON.parse(workflow) : workflow } catch (e) { throw new Error(`工作流 JSON 解析失败：${e.message}`) }
      const clientId = Math.random().toString(36).slice(2)
      const started = Date.now()
      const submitted = await req(`${base}/prompt`, {
        method: 'POST', headers: DEFAULT_HEADERS, body: { prompt: graph, client_id: clientId }, json: true, timeoutMs: 30000,
      })
      const promptId = submitted?.prompt_id
      if (!promptId) throw new Error(`ComfyUI 未返回 prompt_id：${JSON.stringify(submitted).slice(0, 200)}`)
      api.progress?.(job.id, 10, '已提交，执行中…')
      let history
      for (let i = 0; i < 300; i += 1) {
        await sleep(1500)
        history = await req(`${base}/history/${promptId}`, { json: true, timeoutMs: 30000 })
        const entry = history?.[promptId]
        if (entry?.status?.completed === true) break
        if (entry?.status?.status_str === 'error') throw new Error(`ComfyUI 执行出错：${JSON.stringify(entry.status).slice(0, 200)}`)
        api.progress?.(job.id, 15 + Math.min(50, i), '执行中…')
      }
      const entry = history?.[promptId]
      const outputs = []
      for (const node of Object.values(entry?.outputs ?? {})) {
        for (const img of node?.images ?? []) {
          const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output' })
          const saved = await api.saveOutput(job, { kind: 'image', url: `${base}/view?${q}` })
          outputs.push(saved)
        }
        for (const aud of node?.audio ?? []) {
          const q = new URLSearchParams({ filename: aud.filename, subfolder: aud.subfolder ?? '', type: aud.type ?? 'output' })
          const saved = await api.saveOutput(job, { kind: 'audio', url: `${base}/view?${q}` })
          outputs.push(saved)
        }
      }
      if (!outputs.length) throw new Error(`ComfyUI 历史中没有产物（prompt_id=${promptId}）`)
      return { outputs, meta: { providerJobId: promptId, latencyMs: Date.now() - started } }
    },
    resume: async (channel, job, api) => {
      const base = channel.baseUrl || 'http://127.0.0.1:8188'
      const promptId = job.meta?.providerJobId
      if (!promptId) throw new Error('ComfyUI 任务无 prompt_id，无法恢复')
      const history = await req(`${base}/history/${promptId}`, { json: true, timeoutMs: 30000 })
      const entry = history?.[promptId]
      const outputs = []
      for (const node of Object.values(entry?.outputs ?? {})) {
        for (const img of node?.images ?? []) {
          const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output' })
          outputs.push(await api.saveOutput(job, { kind: 'image', url: `${base}/view?${q}` }))
        }
      }
      if (!outputs.length) throw new Error('ComfyUI 历史中没有产物')
      return { outputs, meta: { providerJobId: promptId } }
    },
  }

  /* helpers shared by adapters */
  function collect(payload, modality) {
    const out = []
    const push = (kind, url) => { if (/^https?:\/\//.test(url)) out.push({ kind, url }) }
    if (!payload || typeof payload !== 'object') return out
    for (const [key, value] of Object.entries(payload)) {
      const k = key.toLowerCase()
      if (typeof value === 'string' && /^https?:\/\//.test(value)) push(k.includes('image') ? 'image' : k.includes('video') ? 'video' : k.includes('audio') ? 'audio' : modality === 'audio' || modality === 'tts' ? 'audio' : 'image', value)
      else if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === 'object' && typeof item.url === 'string') {
            push(k.includes('image') ? 'image' : k.includes('video') ? 'video' : k.includes('audio') ? 'audio' : modality === 'audio' || modality === 'tts' ? 'audio' : 'image', item.url)
          }
        }
      } else if (value && typeof value === 'object' && typeof value.url === 'string') {
        push(k.includes('image') ? 'image' : k.includes('video') ? 'video' : k.includes('audio') ? 'audio' : 'image', value.url)
      }
    }
    return out
  }

  return { fal: falAdapter, elevenlabs: elevenlabsAdapter, comfyui: comfyuiAdapter, _req: req }
}
