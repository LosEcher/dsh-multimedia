/**
 * dsh-multimedia — '多媒体' tab view: 生成 / 作品库 / 渠道设置。
 * 数据面全部走同源 /multimedia API（host 半包），API Key 永不落到客户端。
 * 设计参照 LobeHub/fal/ElevenLabs/Civitai 等平台的多媒体生成页面惯例：
 * 模态切换 → 渠道/模型选择 → 参数面板 → 任务队列（进度/取消）→ 作品库网格 → 预览/导出。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import styles from './multimedia.module.css'

/* ── types ── */

interface Channel {
  id: string; type: string; label: string; enabled: boolean
  hasKey: boolean; keyHint: string; apiKeyEnv: string; baseUrl: string; voice: string
  extra?: Record<string, unknown>
}
interface Output { idx: number; kind: string; url: string; fileUrl: string; mime: string; size: number; sizeLabel: string; seed?: number; voice?: string }
interface Job {
  id: string; channelId: string; channelLabel: string; modality: string
  prompt: string; model: string; params: Record<string, unknown>
  status: string; progress: number; note?: string; error?: string
  outputs: Output[]; meta?: Record<string, unknown>; createdAt: number; updatedAt: number
}
interface ModelOption { id: string; label: string }

const MODALITIES = [
  { id: 'image', label: '图片' },
  { id: 'video', label: '视频' },
  { id: 'tts', label: '语音' },
] as const
type Modality = typeof MODALITIES[number]['id']

/** 渠道 × 模态能力矩阵（与 host lib/adapters.mjs 保持一致）。 */
const CAPABILITY: Record<string, Modality[]> = {
  fal: ['image', 'video', 'tts'],
  elevenlabs: ['tts', 'image'],
  comfyui: ['image', 'video'],
  pollinations: ['image'],
  streamelements: ['tts'],
  googletts: ['tts'],
  cloudflare: ['image', 'tts'],
  xai: ['image', 'video'],
  zenmux: ['image', 'video', 'tts'],
}

/** 无需 API Key 的渠道类型（免费/本地），不显示「未配置 Key」提示。 */
const NO_KEY_TYPES = ['comfyui', 'pollinations', 'streamelements', 'googletts']

const IMAGE_SIZES = [
  { id: 'square_hd', label: '方形 1024×1024' },
  { id: 'square', label: '方形 512×512' },
  { id: 'portrait_4_3', label: '竖版 4:3' },
  { id: 'landscape_4_3', label: '横版 4:3' },
  { id: '1024x1024', label: 'ElevenLabs 1024×1024' },
  { id: '768x1024', label: 'ElevenLabs 768×1024' },
  { id: '1024x768', label: 'ElevenLabs 1024×768' },
]
const VIDEO_DURATIONS = [5, 10]
const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4']
const TTS_FORMATS = ['mp3_44100_128', 'mp3_22050_96', 'pcm_16000', 'pcm_24000', 'pcm_44100', 'ulaw_8000']

/* ── helpers ── */

async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...init })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string })?.error ?? `HTTP ${res.status}`)
  return data as T
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function statusBadge(status: string): string {
  switch (status) {
    case 'succeeded': return styles.mmBadgeOk
    case 'failed': return styles.mmBadgeErr
    case 'queued': case 'running': case 'cancelling': return styles.mmBadgeWarn
    default: return styles.mmBadgeInfo
  }
}

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中', running: '生成中', succeeded: '已完成', failed: '失败', cancelled: '已取消', cancelling: '取消中',
}

/* ── component ── */

export function MultimediaTab(_props: ConvViewProps) {
  const [tab, setTab] = useState<'generate' | 'gallery' | 'channels'>('generate')
  const [channels, setChannels] = useState<Channel[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [modality, setModality] = useState<Modality>('image')
  const [channelId, setChannelId] = useState('')
  const [models, setModels] = useState<ModelOption[]>([])
  const [model, setModel] = useState('')
  const [prompt, setPrompt] = useState('')
  const [workflow, setWorkflow] = useState('')
  const [imageSize, setImageSize] = useState('square_hd')
  const [numImages, setNumImages] = useState(1)
  const [steps, setSteps] = useState('')
  const [guidance, setGuidance] = useState('')
  const [seed, setSeed] = useState('')
  const [duration, setDuration] = useState(5)
  const [aspect, setAspect] = useState('16:9')
  const [numFrames, setNumFrames] = useState('')
  const [voice, setVoice] = useState('')
  const [stability, setStability] = useState(0.5)
  const [similarity, setSimilarity] = useState(0.75)
  const [ttsFormat, setTtsFormat] = useState('mp3_44100_128')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [preview, setPreview] = useState<Job | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [exportPath, setExportPath] = useState('')
  const [galleryFilter, setGalleryFilter] = useState<'all' | Modality>('all')
  const [testMsg, setTestMsg] = useState<Record<string, string>>({})
  const [channelForms, setChannelForms] = useState<Record<string, { baseUrl: string; apiKey: string; voice: string }>>({})
  const [newChannel, setNewChannel] = useState({ id: '', type: 'fal', label: '' })
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const notify = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 3200)
  }, [])

  const hasActiveRef = useRef(false)

  const refreshJobs = useCallback(async () => {
    try {
      const list = (await api<{ jobs: Job[] }>('/multimedia/tasks?limit=60')).jobs ?? []
      hasActiveRef.current = list.some((j) => ['queued', 'running', 'cancelling'].includes(j.status))
      setJobs(list)
    } catch { /* silent poll */ }
  }, [])

  const refreshChannels = useCallback(async () => {
    try { setChannels((await api<{ channels: Channel[] }>('/multimedia/channels')).channels ?? []) } catch { /* silent */ }
  }, [])

  // 轮询门控：仅当存在进行中任务或停留在作品库 tab 时轮询（减少无效请求）
  const tabRef = useRef(tab)
  tabRef.current = tab
  useEffect(() => {
    refreshChannels()
    refreshJobs()
    const t = setInterval(() => {
      if (hasActiveRef.current || tabRef.current === 'gallery') refreshJobs()
    }, 2000)
    return () => clearInterval(t)
  }, [refreshChannels, refreshJobs])

  // 灯箱 Esc 关闭
  useEffect(() => {
    if (!preview) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPreview(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview])

  const capableChannels = useMemo(
    () => channels.filter((c) => c.enabled && (CAPABILITY[c.type] ?? []).includes(modality)),
    [channels, modality],
  )

  // 模态/渠道变化 → 校正选择 + 拉模型列表
  useEffect(() => {
    setChannelId((cur) => {
      if (capableChannels.some((c) => c.id === cur)) return cur
      return capableChannels[0]?.id ?? ''
    })
  }, [capableChannels, modality])

  const activeChannel = channels.find((c) => c.id === channelId)

  useEffect(() => {
    if (!activeChannel) { setModels([]); setModel(''); return }
    let cancelled = false
    api<{ models: ModelOption[] }>(`/multimedia/models?channelId=${encodeURIComponent(activeChannel.id)}&modality=${modality}`)
      .then((d) => { if (!cancelled) { setModels(d.models ?? []); setModel((cur) => (d.models?.some((m) => m.id === cur) ? cur : (d.models?.[0]?.id ?? ''))) } })
      .catch(() => { if (!cancelled) { setModels([]); setModel('') } })
    return () => { cancelled = true }
  }, [activeChannel?.id, modality]) // eslint-disable-line react-hooks/exhaustive-deps

  const activeJobs = useMemo(() => jobs.filter((j) => ['queued', 'running', 'cancelling'].includes(j.status)), [jobs])

  /* ── actions ── */

  const buildParams = useCallback((): Record<string, unknown> => {
    const p: Record<string, unknown> = {}
    if (modality === 'image') {
      p.image_size = imageSize
      p.num_images = numImages
      if (steps) p.steps = Number(steps)
      if (guidance) p.guidance_scale = Number(guidance)
      if (seed) p.seed = Number(seed)
    } else if (modality === 'video') {
      p.duration = duration
      p.aspect_ratio = aspect
      if (numFrames) p.num_frames = Number(numFrames)
      if (seed) p.seed = Number(seed)
    } else {
      if (voice) p.voice = voice
      p.stability = stability
      p.similarity_boost = similarity
      p.output_format = ttsFormat
    }
    if (activeChannel?.type === 'comfyui' && workflow.trim()) p.workflow = workflow.trim()
    return p
  }, [modality, imageSize, numImages, steps, guidance, seed, duration, aspect, numFrames, voice, stability, similarity, ttsFormat, activeChannel, workflow])

  async function generate() {
    if (!activeChannel || !prompt.trim()) return
    setBusy(true); setError('')
    try {
      const body = {
        channelId: activeChannel.id,
        modality,
        prompt: prompt.trim(),
        model,
        params: buildParams(),
      }
      await api('/multimedia/generate', { method: 'POST', body: JSON.stringify(body) })
      notify(`已提交：${activeChannel.label} · ${MODALITIES.find((m) => m.id === modality)?.label}`)
      setPrompt('')
      await refreshJobs()
    } catch (e) {
      setError((e as Error).message)
    } finally { setBusy(false) }
  }

  async function cancelJob(id: string) {
    try { await api('/multimedia/cancel', { method: 'POST', body: JSON.stringify({ jobId: id }) }); await refreshJobs() } catch { /* ignore */ }
  }

  async function removeJob(id: string) {
    try { await api(`/multimedia/tasks/${id}`, { method: 'DELETE' }); setConfirmDelete(null); setPreview(null); await refreshJobs() } catch { /* ignore */ }
  }

  async function copy(text: string, label: string) {
    try { await navigator.clipboard.writeText(text); notify(`${label}已复制`) } catch { notify('复制失败') }
  }

  async function exportOutput(job: Job, idx: number) {
    const dest = exportPath.trim() || undefined
    if (!dest) { notify('请先填写目标目录'); return }
    try {
      const r = await api<{ saved?: string }>(`/multimedia/export?jobId=${job.id}&idx=${idx}&destPath=${encodeURIComponent(dest)}`)
      notify(`已导出：${r.saved}`)
    } catch (e) { notify(`导出失败：${(e as Error).message}`) }
  }

  async function toggleChannel(id: string, enabled: boolean) {
    try { await api('/multimedia/channels', { method: 'PUT', body: JSON.stringify({ id, patch: { enabled } }) }); await refreshChannels() } catch { /* ignore */ }
  }

  async function saveChannel(id: string) {
    const f = channelForms[id]
    if (!f) return
    const patch: Record<string, unknown> = {}
    if (f.baseUrl && f.baseUrl !== channels.find((c) => c.id === id)?.baseUrl) patch.baseUrl = f.baseUrl
    if (f.apiKey) patch.apiKey = f.apiKey
    if (f.voice !== undefined) patch.voice = f.voice
    if (f.accountId !== undefined && f.accountId !== channels.find((c) => c.id === id)?.extra?.accountId) patch.extra = { accountId: f.accountId }
    if (!Object.keys(patch).length) { notify('没有需要保存的改动'); return }
    try {
      await api('/multimedia/channels', { method: 'PUT', body: JSON.stringify({ id, patch }) })
      notify('渠道已保存')
      setChannelForms((m) => ({ ...m, [id]: { ...m[id], apiKey: '' } }))
      await refreshChannels()
    } catch (e) { notify(`保存失败：${(e as Error).message}`) }
  }

  async function testChannel(id: string) {
    setTestMsg((m) => ({ ...m, [id]: '测试中…' }))
    try {
      const r = await api<{ message: string }>('/multimedia/test', { method: 'POST', body: JSON.stringify({ channelId: id }) })
      setTestMsg((m) => ({ ...m, [id]: `✅ ${r.message}` }))
    } catch (e) {
      setTestMsg((m) => ({ ...m, [id]: `❌ ${(e as Error).message}` }))
    }
  }

  async function addChannel() {
    if (!newChannel.id.trim() || !newChannel.type) return
    try {
      await api('/multimedia/channels', {
        method: 'POST',
        body: JSON.stringify({ id: newChannel.id.trim(), type: newChannel.type, label: newChannel.label.trim() || newChannel.id.trim() }),
      })
      setNewChannel({ id: '', type: 'fal', label: '' })
      notify('渠道已添加')
      await refreshChannels()
    } catch (e) { notify(`添加失败：${(e as Error).message}`) }
  }

  async function removeChannel(id: string) {
    try { await api(`/multimedia/channels?id=${encodeURIComponent(id)}`, { method: 'DELETE' }); setConfirmDelete(null); await refreshChannels() } catch { /* ignore */ }
  }

  function regen(job: Job) {
    setTab('generate')
    setModality((job.modality as Modality) ?? 'image')
    setChannelId(job.channelId)
    setModel(job.model)
    setPrompt(job.prompt)
    const p = job.params ?? {}
    if (typeof p.image_size === 'string') setImageSize(p.image_size)
    if (typeof p.num_images === 'number') setNumImages(p.num_images)
    if (typeof p.steps === 'number') setSteps(String(p.steps))
    if (typeof p.guidance_scale === 'number') setGuidance(String(p.guidance_scale))
    if (typeof p.seed === 'number') setSeed(String(p.seed))
    if (typeof p.duration === 'number') setDuration(p.duration)
    if (typeof p.aspect_ratio === 'string') setAspect(p.aspect_ratio)
    if (typeof p.voice === 'string') setVoice(p.voice)
    setPreview(null)
  }

  /* ── render helpers ── */

  const renderMedia = (out: Output) => {
    if (out.kind === 'video' || /video\//.test(out.mime)) {
      return <video className={styles.mmMedia} src={out.fileUrl} controls preload="metadata" />
    }
    if (out.kind === 'audio' || /audio\//.test(out.mime)) {
      return <div style={{ padding: '12px 0' }}><audio src={out.fileUrl} controls style={{ width: '100%' }} /></div>
    }
    return <img className={styles.mmMedia} src={out.fileUrl} alt="生成结果" />
  }

  const renderTileMedia = (out: Output | undefined) => {
    if (!out) return <div className={styles.mmThumb} />
    if (out.kind === 'video' || /video\//.test(out.mime)) return <video className={styles.mmThumb} src={out.fileUrl} muted preload="metadata" />
    if (out.kind === 'audio' || /audio\//.test(out.mime)) return <div className={styles.mmThumb} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>🔊</div>
    return <img className={styles.mmThumb} src={out.fileUrl} alt="结果缩略图" loading="lazy" />
  }

  /* ── sections ── */

  const renderGenerate = () => (
    <div className={styles.mmCard}>
      <h3 className={styles.mmTitle}>生成</h3>

      <div className={styles.mmRow}>
        <span className={styles.mmRowLabel}>模态</span>
        {MODALITIES.map((m) => (
          <button key={m.id} className={`${styles.mmBtn} ${modality === m.id ? styles.mmBtnPrimary : ''}`} onClick={() => setModality(m.id)}>{m.label}</button>
        ))}
      </div>

      <div className={styles.mmRow}>
        <span className={styles.mmRowLabel}>渠道</span>
        <select className={styles.mmSelect} value={channelId} onChange={(e) => setChannelId(e.target.value)}>
          {capableChannels.map((c) => <option key={c.id} value={c.id}>{c.label}（{c.type}）</option>)}
        </select>
        {models.length > 0 && (
          <>
            <span className={styles.mmRowLabel}>模型</span>
            <select className={styles.mmSelect} value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </>
        )}
        {activeChannel && !activeChannel.hasKey && !NO_KEY_TYPES.includes(activeChannel.type) && (
          <span className={`${styles.mmBadge} ${styles.mmBadgeErr}`}>未配置 API Key</span>
        )}
      </div>

      <div className={styles.mmRow} style={{ alignItems: 'flex-start' }}>
        <span className={styles.mmRowLabel}>提示词</span>
        <textarea
          className={styles.mmTextarea}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={modality === 'tts' ? '输入要朗读的文本…' : '描述你想生成的画面…'}
        />
      </div>

      {activeChannel?.type === 'comfyui' && (
        <div className={styles.mmRow} style={{ alignItems: 'flex-start' }}>
          <span className={styles.mmRowLabel}>工作流</span>
          <textarea
            className={styles.mmTextarea}
            value={workflow}
            onChange={(e) => setWorkflow(e.target.value)}
            placeholder='ComfyUI 工作流 JSON（{"3":{"inputs":{...}},…}）'
            style={{ minHeight: 140, fontFamily: 'var(--dsw-font-family, ui-monospace, monospace)' }}
          />
        </div>
      )}

      {modality === 'image' && (
        <div className={styles.mmRow}>
          <span className={styles.mmRowLabel}>尺寸</span>
          <select className={styles.mmSelect} value={imageSize} onChange={(e) => setImageSize(e.target.value)}>
            {IMAGE_SIZES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <span className={styles.mmRowLabel}>数量</span>
          <input type="number" min={1} max={4} className={styles.mmInput} style={{ width: 60 }} value={numImages} onChange={(e) => setNumImages(Math.max(1, Math.min(4, Number(e.target.value) || 1)))} />
          <span className={styles.mmRowLabel}>步数</span>
          <input type="number" className={styles.mmInput} style={{ width: 70 }} placeholder="默认" value={steps} onChange={(e) => setSteps(e.target.value)} />
          <span className={styles.mmRowLabel}>CFG</span>
          <input type="number" step="0.5" className={styles.mmInput} style={{ width: 70 }} placeholder="默认" value={guidance} onChange={(e) => setGuidance(e.target.value)} />
          <span className={styles.mmRowLabel}>Seed</span>
          <input type="number" className={styles.mmInput} style={{ width: 100 }} placeholder="随机" value={seed} onChange={(e) => setSeed(e.target.value)} />
        </div>
      )}

      {modality === 'video' && (
        <div className={styles.mmRow}>
          <span className={styles.mmRowLabel}>时长</span>
          {VIDEO_DURATIONS.map((d) => (
            <button key={d} className={`${styles.mmBtn} ${duration === d ? styles.mmBtnPrimary : ''}`} onClick={() => setDuration(d)}>{d}s</button>
          ))}
          <span className={styles.mmRowLabel}>比例</span>
          <select className={styles.mmSelect} value={aspect} onChange={(e) => setAspect(e.target.value)}>
            {ASPECT_RATIOS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <span className={styles.mmRowLabel}>帧数</span>
          <input type="number" className={styles.mmInput} style={{ width: 80 }} placeholder="默认" value={numFrames} onChange={(e) => setNumFrames(e.target.value)} />
          <span className={styles.mmRowLabel}>Seed</span>
          <input type="number" className={styles.mmInput} style={{ width: 100 }} placeholder="随机" value={seed} onChange={(e) => setSeed(e.target.value)} />
        </div>
      )}

      {modality === 'tts' && (
        <div className={styles.mmRow}>
          <span className={styles.mmRowLabel}>音色</span>
          <select className={styles.mmSelect} value={voice} onChange={(e) => setVoice(e.target.value)}>
            <option value="">渠道默认</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          {activeChannel?.type === 'elevenlabs' && (
            <>
              <span className={styles.mmRowLabel}>稳定度</span>
              <input type="range" min={0} max={1} step={0.05} value={stability} onChange={(e) => setStability(Number(e.target.value))} />
              <span className={styles.mmHint}>{stability.toFixed(2)}</span>
              <span className={styles.mmRowLabel}>相似度</span>
              <input type="range" min={0} max={1} step={0.05} value={similarity} onChange={(e) => setSimilarity(Number(e.target.value))} />
              <span className={styles.mmHint}>{similarity.toFixed(2)}</span>
            </>
          )}
          <span className={styles.mmRowLabel}>格式</span>
          <select className={styles.mmSelect} value={ttsFormat} onChange={(e) => setTtsFormat(e.target.value)}>
            {TTS_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
      )}

      <div className={styles.mmRow}>
        <button className={`${styles.mmBtn} ${styles.mmBtnPrimary}`} disabled={busy || !activeChannel || !prompt.trim()} onClick={generate}>
          {busy ? '提交中…' : `生成${modality === 'tts' ? '语音' : modality === 'video' ? '视频' : '图片'}`}
        </button>
        {capableChannels.length === 0 && <span className={styles.mmHint}>当前模态下没有已启用的渠道，请到「渠道」开启并配置</span>}
      </div>
      {error && <div className={styles.mmError}>{error}</div>}
      {toast && <div className={styles.mmOk}>{toast}</div>}

      {activeJobs.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <h4 className={styles.mmTitle}>进行中</h4>
          <div className={styles.mmJobStrip}>
            {activeJobs.map((j) => (
              <div key={j.id} className={styles.mmJobItem}>
                <span className={`${styles.mmBadge} ${statusBadge(j.status)}`}>{STATUS_LABEL[j.status] ?? j.status}</span>
                <span className={styles.mmJobMeta}>
                  {j.id} · {j.channelLabel} · {j.prompt.slice(0, 60) || j.note || ''}
                </span>
                <span className={styles.mmHint}>{j.progress}%{j.note ? ` · ${j.note}` : ''}</span>
                <button className={styles.mmBtn} onClick={() => cancelJob(j.id)}>取消</button>
                <div className={styles.mmJobBar} style={{ width: 120 }}><div className={styles.mmJobBarFill} style={{ width: `${j.progress ?? 0}%` }} /></div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )

  const renderGallery = () => {
    const filtered = jobs.filter((j) => galleryFilter === 'all' || j.modality === galleryFilter)
    return (
      <div className={styles.mmCard}>
        <div className={styles.mmRow}>
          <h3 className={styles.mmTitle} style={{ margin: 0 }}>作品库</h3>
          <select className={styles.mmSelect} value={galleryFilter} onChange={(e) => setGalleryFilter(e.target.value as 'all' | Modality)}>
            <option value="all">全部</option>
            {MODALITIES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
        {filtered.length === 0 && <div className={styles.mmHint}>还没有作品，去「生成」页试试</div>}
        <div className={styles.mmGrid}>
          {filtered.map((j) => (
            <div key={j.id} className={styles.mmTile} onClick={() => setPreview(j)}>
              {renderTileMedia(j.outputs?.[0])}
              <div className={styles.mmTileBody}>
                <div className={styles.mmTilePrompt}>{j.prompt || `(${j.modality})`}</div>
                <div className={styles.mmTileMeta}>
                  <span className={`${styles.mmBadge} ${statusBadge(j.status)}`}>{STATUS_LABEL[j.status] ?? j.status}</span>
                  <span>{j.channelLabel}</span>
                  <span>{fmtTime(j.createdAt)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const renderChannels = () => (
    <div className={styles.mmCard}>
      <h3 className={styles.mmTitle}>渠道设置</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {channels.map((c) => {
          const form = channelForms[c.id] ?? { baseUrl: c.baseUrl, apiKey: '', voice: c.voice, accountId: c.extra?.accountId ?? '' }
          return (
            <div key={c.id} className={`${styles.mmCard} ${styles.mmChannelCard}`}>
              <div className={styles.mmChannelHead}>
                <label className={styles.mmSwitch}>
                  <input type="checkbox" checked={c.enabled} onChange={(e) => toggleChannel(c.id, e.target.checked)} />
                  <span className={styles.mmSwitchTrack} />
                  <span className={styles.mmSwitchThumb} />
                </label>
                <strong>{c.label}</strong>
                <span className={styles.mmBadge} style={{ background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-secondary)' }}>{c.type}</span>
                {c.hasKey
                  ? <span className={styles.mmKeyTag}>已配置{c.apiKeyEnv ? `（env ${c.apiKeyEnv}）` : ` ****${c.keyHint}`}</span>
                  : <span className={`${styles.mmKeyTag} ${styles.mmKeyTagMissing}`}>未配置 API Key</span>}
                <span style={{ flex: 1 }} />
                <button className={styles.mmBtn} onClick={() => testChannel(c.id)}>测试连接</button>
                <button className={`${styles.mmBtn} ${styles.mmBtnDanger}`} onClick={() => setConfirmDelete(confirmDelete === c.id ? null : c.id)}>
                  {confirmDelete === c.id ? '确认删除？' : '删除'}
                </button>
                {confirmDelete === c.id && <button className={`${styles.mmBtn} ${styles.mmBtnPrimary}`} onClick={() => removeChannel(c.id)}>确认</button>}
              </div>
              <div className={styles.mmRow} style={{ marginBottom: 4 }}>
                <span className={styles.mmRowLabel}>Base URL</span>
                <input className={styles.mmInput} style={{ width: 320 }} value={form.baseUrl} onChange={(e) => setChannelForms((m) => ({ ...m, [c.id]: { ...form, baseUrl: e.target.value } }))} />
                <span className={styles.mmRowLabel}>API Key</span>
                <input className={styles.mmInput} type="password" style={{ width: 240 }} placeholder={c.hasKey ? '留空不改' : '输入 API Key'} value={form.apiKey} onChange={(e) => setChannelForms((m) => ({ ...m, [c.id]: { ...form, apiKey: e.target.value } }))} />
                {c.type === 'elevenlabs' && (
                  <>
                    <span className={styles.mmRowLabel}>默认音色</span>
                    <input className={styles.mmInput} style={{ width: 200 }} placeholder="voice_id" value={form.voice} onChange={(e) => setChannelForms((m) => ({ ...m, [c.id]: { ...form, voice: e.target.value } }))} />
                  </>
                )}
                {c.type === 'cloudflare' && (
                  <>
                    <span className={styles.mmRowLabel}>Account ID</span>
                    <input className={styles.mmInput} style={{ width: 220 }} placeholder="Cloudflare 账户 ID" value={form.accountId} onChange={(e) => setChannelForms((m) => ({ ...m, [c.id]: { ...form, accountId: e.target.value } }))} />
                  </>
                )}
                <button className={styles.mmBtn} onClick={() => saveChannel(c.id)}>保存</button>
              </div>
              {testMsg[c.id] && <div className={testMsg[c.id].startsWith('✅') ? styles.mmOk : styles.mmError}>{testMsg[c.id]}</div>}
            </div>
          )
        })}

        <div className={`${styles.mmCard} ${styles.mmChannelCard}`}>
          <h4 className={styles.mmTitle}>新增渠道</h4>
          <div className={styles.mmRow} style={{ marginBottom: 0 }}>
            <input className={styles.mmInput} placeholder="id（如 my-fal）" value={newChannel.id} onChange={(e) => setNewChannel((n) => ({ ...n, id: e.target.value }))} />
            <select className={styles.mmSelect} value={newChannel.type} onChange={(e) => setNewChannel((n) => ({ ...n, type: e.target.value }))}>
              <option value="fal">fal</option>
              <option value="elevenlabs">elevenlabs</option>
              <option value="comfyui">comfyui</option>
            </select>
            <input className={styles.mmInput} placeholder="显示名" value={newChannel.label} onChange={(e) => setNewChannel((n) => ({ ...n, label: e.target.value }))} />
            <button className={`${styles.mmBtn} ${styles.mmBtnPrimary}`} onClick={addChannel}>添加</button>
          </div>
        </div>
      </div>
    </div>
  )

  const renderPreview = () => {
    if (!preview) return null
    const job = preview
    return (
      <div className={styles.mmOverlay} role="dialog" aria-modal="true" aria-label="产物预览" onClick={() => setPreview(null)}>
        <div className={styles.mmPreview} onClick={(e) => e.stopPropagation()}>
          <div className={styles.mmRow} style={{ marginBottom: 8 }}>
            <span className={`${styles.mmBadge} ${statusBadge(job.status)}`}>{STATUS_LABEL[job.status] ?? job.status}</span>
            <strong>{job.channelLabel}</strong>
            <span className={styles.mmHint}>{job.model || ''}</span>
            <span className={styles.mmHint}>{fmtTime(job.createdAt)}</span>
            <span style={{ flex: 1 }} />
            <button className={styles.mmBtn} onClick={() => setPreview(null)}>关闭</button>
          </div>
          {job.error && <div className={styles.mmError}>{job.error}</div>}
          <div style={{ maxHeight: '52vh', overflow: 'auto' }}>{job.outputs.map((o) => <div key={o.idx}>{renderMedia(o)}</div>)}</div>
          <div className={styles.mmPreviewRow}>
            {job.outputs.map((o) => (
              <span key={o.idx}>
                <a className={styles.mmBtn} style={{ textDecoration: 'none', display: 'inline-block' }} href={o.fileUrl} download>下载[{o.idx}]</a>
                <button className={styles.mmBtn} onClick={() => copy(o.url || o.fileUrl, '链接')}>复制链接</button>
              </span>
            ))}
            <button className={styles.mmBtn} onClick={() => copy(job.prompt, '提示词')}>复制提示词</button>
            <button className={styles.mmBtn} onClick={() => regen(job)}>重新生成</button>
            <span className={styles.mmRowLabel}>导出到</span>
            <input className={styles.mmInput} style={{ width: 280 }} placeholder="/绝对/路径/目录" value={exportPath} onChange={(e) => setExportPath(e.target.value)} />
            <button className={styles.mmBtn} onClick={() => exportOutput(job, job.outputs[0]?.idx ?? 0)}>导出</button>
            <span style={{ flex: 1 }} />
            <button className={`${styles.mmBtn} ${styles.mmBtnDanger}`} onClick={() => { if (confirmDelete === job.id) { removeJob(job.id) } else { setConfirmDelete(job.id); setTimeout(() => setConfirmDelete((v) => (v === job.id ? null : v)), 3000) } }}>
              {confirmDelete === job.id ? '确认删除任务与文件？' : '删除'}
            </button>
          </div>
          {job.outputs[0] && (
            <div className={styles.mmHint} style={{ marginTop: 8 }}>
              {job.outputs.map((o) => `产物[${o.idx}] ${o.kind} ${o.sizeLabel}${o.seed != null ? ` seed=${o.seed}` : ''}`).join(' · ')}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={styles.mmRoot}>
      <div className={styles.mmTabs}>
        {([['generate', '生成'], ['gallery', '作品库'], ['channels', '渠道']] as const).map(([id, label]) => (
          <button key={id} className={`${styles.mmTab} ${tab === id ? styles.mmTabActive : ''}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === 'generate' && renderGenerate()}
      {tab === 'gallery' && renderGallery()}
      {tab === 'channels' && renderChannels()}
      {renderPreview()}
    </div>
  )
}
