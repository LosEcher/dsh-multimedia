/**
 * dsh-multimedia — lib/adapters.mjs
 * Channel adapters: fal.ai (queue API), ElevenLabs (TTS + images), ComfyUI
 * (local, raw workflow JSON). Each exposes { modalities, models, test,
 * generate, resume }. fetchImpl/sleep/log are injectable for tests.
 */
import { extForMime, collectUrls } from './core.mjs'

const DEFAULT_HEADERS = { 'content-type': 'application/json' }

/* ─────────────────────────── xAI (Grok Imagine) ─────────────────────────── */

/**
 * xAI adapter — OpenAI 兼容 REST（https://api.x.ai/v1，Bearer 鉴权）：
 *   - image  生成 /v1/images/generations、编辑 /v1/images/edits（同步，data[].url）
 *   - video  生成 /v1/videos/generations、编辑 /v1/videos/edits、
 *            扩展 /v1/videos/extensions（异步：request_id → 轮询 /v1/videos/{id} 至 done）
 * 模型：grok-imagine-image-2.0 / grok-imagine-video-1.5。
 *
 * 模块级工厂：仅依赖注入的 req/sleep/collect，未来抽独立 dsh-xai 插件可直接复用。
 */
export function createXaiAdapter({ req, sleep, log = () => {}, collect = collectUrls }) {
  const IMAGE_MODELS = [
    { id: 'grok-imagine-image-2.0', label: 'Grok Imagine Image 2.0（默认）' },
  ]
  const VIDEO_MODELS = [
    { id: 'grok-imagine-video-1.5', label: 'Grok Imagine Video 1.5（默认）' },
  ]

  const xaiUrl = (channel) => (channel.baseUrl || 'https://api.x.ai/v1').replace(/\/+$/, '')

  /** 输入素材归一化：http(s) URL 字符串 / data: URI / {url|base64|file_id} 对象。 */
  function inputObject(input) {
    if (!input) throw new Error('编辑/扩展需要输入素材（image/video 参数）')
    if (typeof input === 'string') {
      if (/^https?:\/\//i.test(input)) return { url: input, type: 'image_url' }
      if (input.startsWith('data:')) return { base64: input, type: 'base64' }
      throw new Error(`不支持的输入素材：${String(input).slice(0, 60)}…（支持 http(s) URL 或 data: URI）`)
    }
    if (input && typeof input === 'object' && (input.url || input.base64 || input.file_id)) return input
    throw new Error('输入素材格式错误（应为 URL 字符串或 {url|base64|file_id} 对象）')
  }

  /** 按 action 构建请求体；params.extra 整体透传（含服务端未知字段，如 aspect_ratio）。 */
  function bodyFor(channel, job, action) {
    const p = job.params ?? {}
    const model = job.model || (job.modality === 'video' ? VIDEO_MODELS[0].id : IMAGE_MODELS[0].id)
    const base = { model, prompt: job.prompt, ...(p.extra ?? {}) }
    if (job.modality === 'video') {
      const vid = { ...base }
      if (action === 'edit' || action === 'extend') vid.video = inputObject(p.video)
      if (p.duration) vid.duration = Number(p.duration)
      if (p.aspect_ratio) vid.aspect_ratio = String(p.aspect_ratio)
      if (p.num_frames) vid.num_frames = Number(p.num_frames)
      return vid
    }
    // image（生成/编辑）
    const img = { ...base }
    if (action === 'edit') img.image = inputObject(p.image)
    const n = Number(p.num_images ?? p.n ?? 1)
    if (Number.isFinite(n) && n >= 1 && n <= 4) img.n = Math.floor(n)
    const size = p.image_size || p.size
    if (size) img.size = String(size)
    img.response_format = p.response_format ?? 'url'
    return img
  }

  /** 轮询视频任务直到 done / failed / 超时（5s × 180 ≈ 15min）。 */
  async function pollXaiVideo(base, headers, requestId, jobId, api) {
    for (let i = 0; i < 180; i += 1) {
      await sleep(5000)
      const st = await req(`${base}/videos/${requestId}`, { headers, json: true, timeoutMs: 30000 })
      const status = st?.status ?? ''
      if (status === 'done') return st
      if (status === 'failed' || status === 'error' || status === 'cancelled') {
        const detail = st?.error ?? st?.message ?? ''
        throw new Error(`xAI 视频任务失败：${status}${detail ? ` — ${detail}` : ''}`)
      }
      api.progress?.(jobId, 8 + Math.min(60, i), `生成中…(${status || 'pending'})`)
    }
    throw new Error('xAI 视频任务超时（>15min），可通过 media_status 查询或稍后重试')
  }

  /** 收集结果 URL：优先 data[].url，兼容 video_url/url 顶层字段。 */
  function collectResult(payload, kind) {
    if (Array.isArray(payload?.data) && payload.data.length) return collect({ data: payload.data }, kind)
    if (typeof payload?.video_url === 'string') return [{ kind: 'video', url: payload.video_url }]
    return collect(payload, kind)
  }

  return {
    modalities: ['image', 'video'],
    models: async (channel, modality) => (modality === 'video' ? VIDEO_MODELS : IMAGE_MODELS),
    test: async (channel) => {
      // 自行解析 key（不依赖调用方传入的 api 对象）。
      const key = (channel.apiKeyEnv && process.env[channel.apiKeyEnv]) || channel.apiKey || ''
      if (!key) return { ok: false, message: '未配置 API Key（apiKeyEnv: XAI_API_KEY）' }
      try {
        const data = await req(`${xaiUrl(channel)}/models`, {
          headers: { Authorization: `Bearer ${key}` }, json: true, timeoutMs: 10000,
        })
        const count = Array.isArray(data?.data) ? data.data.length : 0
        return { ok: true, message: `xAI API Key 有效（${count} 个模型可见）` }
      } catch (e) {
        return { ok: false, message: `鉴权失败：${e.message}` }
      }
    },
    generate: async (channel, job, api) => {
      const action = job.params?.action ?? 'generate'
      const model = job.model || (job.modality === 'video' ? VIDEO_MODELS[0].id : IMAGE_MODELS[0].id)
      const base = xaiUrl(channel)
      const headers = { ...DEFAULT_HEADERS, Authorization: `Bearer ${api.channelKey(channel)}` }
      const started = Date.now()

      // 图片生成/编辑：同步端点，直接返回 data[].url
      if (job.modality !== 'video') {
        const endpoint = action === 'edit' ? '/images/edits' : '/images/generations'
        log(`[xai] submit ${action} ${model} job=${job.id}`)
        const payload = await req(`${base}${endpoint}`, {
          method: 'POST', headers, body: bodyFor(channel, job, action), json: true, timeoutMs: 180000,
        })
        const urls = collectResult(payload, 'image')
        if (!urls.length) throw new Error(`xAI 图片响应没有可下载产物：${JSON.stringify(payload).slice(0, 300)}`)
        api.progress?.(job.id, 70, '下载产物…')
        const outputs = []
        for (const u of urls) outputs.push(await api.saveOutput(job, { kind: u.kind, url: u.url }))
        return { outputs, meta: { providerJobId: '', model, action, usage: payload.usage, latencyMs: Date.now() - started } }
      }

      // 视频生成/编辑/扩展：异步 request_id + 轮询
      const endpoint = action === 'edit' ? '/videos/edits' : action === 'extend' ? '/videos/extensions' : '/videos/generations'
      log(`[xai] submit ${action} ${model} job=${job.id}`)
      const submitted = await req(`${base}${endpoint}`, {
        method: 'POST', headers, body: bodyFor(channel, job, action), json: true, timeoutMs: 60000,
      })
      const providerJobId = submitted?.request_id ?? submitted?.id
      if (!providerJobId) throw new Error(`xAI 未返回 request_id：${JSON.stringify(submitted).slice(0, 200)}`)
      api.progress?.(job.id, 5, '已提交，排队中…')
      const payload = await pollXaiVideo(base, headers, providerJobId, job.id, api)
      const urls = collectResult(payload, 'video')
      if (!urls.length) throw new Error(`xAI 视频结果没有可下载产物：${JSON.stringify(payload).slice(0, 300)}`)
      api.progress?.(job.id, 75, '下载产物…')
      const outputs = []
      for (const u of urls) outputs.push(await api.saveOutput(job, { kind: u.kind, url: u.url }))
      return { outputs, meta: { providerJobId, model, action, latencyMs: Date.now() - started } }
    },
    resume: async (channel, job, api) => {
      const providerJobId = job.meta?.providerJobId
      if (!providerJobId) throw new Error('xAI 任务无 providerJobId，无法恢复')
      const base = xaiUrl(channel)
      const headers = { ...DEFAULT_HEADERS, Authorization: `Bearer ${api.channelKey(channel)}` }
      const payload = await pollXaiVideo(base, headers, providerJobId, job.id, api)
      const urls = collectResult(payload, 'video')
      const outputs = []
      for (const u of urls) outputs.push(await api.saveOutput(job, { kind: u.kind, url: u.url }))
      return { outputs, meta: { providerJobId } }
    },
  }
}

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

  /* ─────────────────────── Pollinations（匿名免费，文生图） ─────────────────────── */
  /* 注：legacy text API 已无 openai-audio（404 Model not found），故仅保留 image。 */

  const pollinationsAdapter = {
    modalities: ['image'],
    models: async () => [
      { id: 'flux', label: 'FLUX（默认）' },
      { id: 'turbo', label: 'Turbo（快）' },
      { id: 'floyd', label: 'Floyd' },
      { id: 'gptimage', label: 'GPT Image' },
    ],
    test: async () => {
      try {
        await req('https://image.pollinations.ai/models', { json: true, timeoutMs: 10000 })
        return { ok: true, message: 'Pollinations 可达（匿名免费，无需 Key；限 1 并发/5s）' }
      } catch (e) {
        return { ok: false, message: `不可达：${e.message}` }
      }
    },
    generate: async (channel, job, api) => {
      const started = Date.now()
      const { width, height } = mapSize(job.params?.image_size, job.params)
      const q = new URLSearchParams({
        width: String(width),
        height: String(height),
        model: job.model || 'flux',
        seed: job.params?.seed != null ? String(job.params.seed) : String(Math.floor(Math.random() * 1e9)),
        nologo: 'true',
        private: 'true',
      })
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(job.prompt)}?${q}`
      const { buffer, contentType } = await req(url, { raw: true, timeoutMs: 180000 })
      const saved = await api.saveOutput(job, { kind: 'image', data: buffer, mime: contentType || 'image/jpeg' })
      return { outputs: [saved], meta: { seed: q.get('seed'), latencyMs: Date.now() - started } }
    },
    resume: async () => { throw new Error('Pollinations 为同步接口，无需恢复') },
  }

  /* ────────────────── StreamElements TTS（免费无 Key） ────────────────── */

  const SE_VOICES = ['Brian', 'Amy', 'Emma', 'Joanna', 'Matthew', 'Salli', 'Ivy', 'Justin', 'Kendra', 'Kimberly', 'Joey', 'Geraint', 'Russell', 'Nicole', 'Raveena', 'Aria', 'Ayanda']

  const streamelementsAdapter = {
    modalities: ['tts'],
    models: async () => SE_VOICES.map((v) => ({ id: v, label: v })),
    test: async () => {
      try {
        const { buffer } = await req('https://api.streamelements.com/kappa/v2/speech?voice=Brian&text=test', { raw: true, timeoutMs: 10000 })
        return buffer.length > 0
          ? { ok: true, message: 'StreamElements TTS 可用（免费，无需 Key；文本建议 ≤200 字符）' }
          : { ok: false, message: '空响应' }
      } catch (e) {
        return { ok: false, message: `不可达：${e.message}` }
      }
    },
    generate: async (channel, job, api) => {
      // 2026-08 实测：该端点仅接受单词级文本（含空格/连字符/标点即 401）
      if (/[\s\-_.,，。!?！？]/.test(job.prompt)) {
        throw new Error('StreamElements 端点仅支持单词级文本（多词/标点会 401），请改用 googletts 渠道')
      }
      const started = Date.now()
      const voice = job.params?.voice ?? 'Brian'
      const url = `https://api.streamelements.com/kappa/v2/speech?voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(job.prompt)}`
      const { buffer, contentType } = await req(url, { raw: true, timeoutMs: 60000 })
      const saved = await api.saveOutput(job, { kind: 'audio', data: buffer, mime: contentType || 'audio/mpeg' })
      return { outputs: [saved], meta: { voice, latencyMs: Date.now() - started } }
    },
    resume: async () => { throw new Error('StreamElements 为同步接口，无需恢复') },
  }

  /* ────────────── Google Translate TTS（免费无 Key，中英日韩等） ────────────── */

  const GT_LANGS = [
    { id: 'zh-CN', label: '中文（普通话）' },
    { id: 'zh-TW', label: '中文（台湾）' },
    { id: 'en', label: 'English' },
    { id: 'ja', label: '日本語' },
    { id: 'ko', label: '한국어' },
    { id: 'fr', label: 'Français' },
    { id: 'de', label: 'Deutsch' },
    { id: 'es', label: 'Español' },
    { id: 'ru', label: 'Русский' },
  ]

  const googlettsAdapter = {
    modalities: ['tts'],
    models: async () => GT_LANGS,
    test: async () => {
      try {
        const { buffer } = await req('https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=zh-CN&q=test', { raw: true, timeoutMs: 10000 })
        return buffer.length > 0
          ? { ok: true, message: 'Google TTS 可用（免费，无需 Key；建议文本 ≤200 字符）' }
          : { ok: false, message: '空响应' }
      } catch (e) {
        return { ok: false, message: `不可达：${e.message}` }
      }
    },
    generate: async (channel, job, api) => {
      if (job.prompt.length > 200) throw new Error('Google TTS 单次上限约 200 字符，请分段生成')
      const started = Date.now()
      const lang = job.params?.voice ?? 'zh-CN'
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(job.prompt)}`
      const { buffer, contentType } = await req(url, { raw: true, timeoutMs: 60000 })
      const saved = await api.saveOutput(job, { kind: 'audio', data: buffer, mime: contentType || 'audio/mpeg' })
      return { outputs: [saved], meta: { lang, latencyMs: Date.now() - started } }
    },
    resume: async () => { throw new Error('Google TTS 为同步接口，无需恢复') },
  }

  /* ──────────────────── Cloudflare Workers AI（免费层） ──────────────────── */

  const cloudflareAdapter = {
    modalities: ['image', 'tts'],
    models: async (channel, modality) => {
      if (modality === 'tts') return [{ id: '@cf/myshell-ai/melotts', label: 'MeloTTS（中文语音）' }]
      return [{ id: '@cf/black-forest-labs/flux-1-schnell', label: 'FLUX.1 Schnell' }]
    },
    test: async (channel) => {
      const accountId = channel.extra?.accountId
      if (!accountId) return { ok: false, message: '未配置 accountId（渠道设置「Account ID」）' }
      try {
        await req(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?per_page=1`, {
          headers: { Authorization: `Bearer ${api.channelKey(channel)}` },
          json: true, timeoutMs: 10000,
        })
        return { ok: true, message: 'Cloudflare Workers AI 凭据有效（免费层 10k neurons/天）' }
      } catch (e) {
        return { ok: false, message: `鉴权失败：${e.message}` }
      }
    },
    generate: async (channel, job, api) => {
      const accountId = channel.extra?.accountId
      if (!accountId) throw new Error('未配置 accountId（渠道设置「Account ID」）')
      const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`
      const headers = { Authorization: `Bearer ${api.channelKey(channel)}`, 'content-type': 'application/json' }
      const started = Date.now()
      if (job.modality === 'tts') {
        const model = job.model || '@cf/myshell-ai/melotts'
        const data = await req(`${base}/${model}`, { method: 'POST', headers, body: { text: job.prompt }, json: true, timeoutMs: 120000 })
        const b64 = data?.result?.audio
        if (!b64) throw new Error(`Cloudflare 未返回音频：${JSON.stringify(data).slice(0, 200)}`)
        const saved = await api.saveOutput(job, { kind: 'audio', dataUri: `data:audio/mpeg;base64,${b64}`, mime: 'audio/mpeg' })
        return { outputs: [saved], meta: { model, latencyMs: Date.now() - started } }
      }
      const model = job.model || '@cf/black-forest-labs/flux-1-schnell'
      const { width, height } = mapSize(job.params?.image_size, job.params)
      const data = await req(`${base}/${model}`, {
        method: 'POST', headers, body: { prompt: job.prompt, width, height, steps: job.params?.steps ?? 4 }, json: true, timeoutMs: 120000,
      })
      const b64 = data?.result?.image
      if (!b64) throw new Error(`Cloudflare 未返回图片：${JSON.stringify(data).slice(0, 200)}`)
      const saved = await api.saveOutput(job, { kind: 'image', dataUri: `data:image/png;base64,${b64}`, mime: 'image/png' })
      return { outputs: [saved], meta: { model, latencyMs: Date.now() - started } }
    },
    resume: async () => { throw new Error('Cloudflare 为同步接口，无需恢复') },
  }

  /* helpers shared by adapters */

  /** 把预设尺寸/比例映射为宽高（pollinations / cloudflare 用）。 */
  function mapSize(imageSize, params) {
    if (params?.width && params?.height) return { width: Number(params.width), height: Number(params.height) }
    const table = {
      square_hd: [1024, 1024], square: [512, 512],
      portrait_4_3: [768, 1024], landscape_4_3: [1024, 768],
      '1024x1024': [1024, 1024], '768x1024': [768, 1024], '1024x768': [1024, 768],
      '16:9': [1024, 576], '9:16': [576, 1024], '1:1': [1024, 1024], '4:3': [1024, 768], '3:4': [768, 1024],
    }
    const hit = table[imageSize] ?? [1024, 1024]
    return { width: hit[0], height: hit[1] }
  }
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

  return {
    fal: falAdapter,
    elevenlabs: elevenlabsAdapter,
    comfyui: comfyuiAdapter,
    pollinations: pollinationsAdapter,
    streamelements: streamelementsAdapter,
    googletts: googlettsAdapter,
    cloudflare: cloudflareAdapter,
    xai: createXaiAdapter({ req, sleep, log }),
    _req: req,
  }
}
