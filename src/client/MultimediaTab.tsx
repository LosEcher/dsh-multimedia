/**
 * dsh-multimedia — '多媒体' tab view: 生成 / 作品库 / 渠道设置。
 * 数据面全部走同源 /multimedia API（host 半包），API Key 永不落到客户端。
 * 设计参照 LobeHub/fal/ElevenLabs/Civitai 等平台的多媒体生成页面惯例：
 * 模态切换 → 渠道/模型选择 → 参数面板 → 任务队列（进度/取消）→ 作品库网格 → 预览/导出。
 *
 * 标准 client 范式（见 dsh-channel-wechat 先例）：
 *   - 样式全部走 CSS Module + --dsw-alias-* 设计令牌，零内联 style。
 *   - 文案全部走 locale（NS='multimedia'，zh/en 字典在 locales.ts），只用注入的 t()。
 *   - 危险操作（删除渠道/作品、取消任务）用 primitives Button + Modal 确认，
 *     绝不使用 window.confirm。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import styles from './multimedia.module.css'
import { StatusBadge } from './StatusBadge.tsx'
import { NS, type MultimediaKey } from './locales.ts'
import type {} from './locales.ts'

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

/** Props delivered by the slot outlet: runtime share + locale seat. */
export type MultimediaTabProps =
  PropsRuntime<'conversation.view'>
  & PropsLocale<typeof NS>

const MODALITIES = [
  { id: 'image', labelKey: 'modalityImage' },
  { id: 'video', labelKey: 'modalityVideo' },
  { id: 'tts', labelKey: 'modalityTts' },
] as const
type Modality = typeof MODALITIES[number]['id']

const modalityKey = (id: string): MultimediaKey =>
  MODALITIES.find((m) => m.id === id)?.labelKey ?? 'modalityImage'

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
  { id: 'square_hd', labelKey: 'sizeSquareHd' },
  { id: 'square', labelKey: 'sizeSquare' },
  { id: 'portrait_4_3', labelKey: 'sizePortrait43' },
  { id: 'landscape_4_3', labelKey: 'sizeLandscape43' },
  { id: '1024x1024', labelKey: 'sizeEleven1024' },
  { id: '768x1024', labelKey: 'sizeEleven768x1024' },
  { id: '1024x768', labelKey: 'sizeEleven1024x768' },
] as const
const VIDEO_DURATIONS = [5, 10]
const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4']
const TTS_FORMATS = ['mp3_44100_128', 'mp3_22050_96', 'pcm_16000', 'pcm_24000', 'pcm_44100', 'ulaw_8000']

/** status → 字典键（未知状态原样显示）。 */
const STATUS_KEYS: Record<string, MultimediaKey> = {
  queued: 'statusQueued', running: 'statusRunning', succeeded: 'statusSucceeded',
  failed: 'statusFailed', cancelled: 'statusCancelled', cancelling: 'statusCancelling',
}

/** 危险操作确认态（Modal 驱动，不再用内联两步确认）。 */
type ConfirmAction =
  | { kind: 'deleteChannel'; id: string; label: string }
  | { kind: 'deleteJob'; id: string }
  | { kind: 'cancelJob'; id: string }
  | null

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

/* ── component ── */

export function MultimediaTab({ t }: MultimediaTabProps) {
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
  const [confirm, setConfirm] = useState<ConfirmAction>(null)
  const [exportPath, setExportPath] = useState('')
  const [galleryFilter, setGalleryFilter] = useState<'all' | Modality>('all')
  const [testMsg, setTestMsg] = useState<Record<string, string>>({})
  const [channelForms, setChannelForms] = useState<Record<string, { baseUrl: string; apiKey: string; voice: string; accountId?: string }>>({})
  const [newChannel, setNewChannel] = useState({ id: '', type: 'fal', label: '' })
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const statusLabel = useCallback((status: string): string => {
    const key = STATUS_KEYS[status]
    return key ? t(key) : status
  }, [t])

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
    const timer = setInterval(() => {
      if (hasActiveRef.current || tabRef.current === 'gallery') refreshJobs()
    }, 2000)
    return () => clearInterval(timer)
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
      notify(t('submitted', { channel: activeChannel.label, modality: t(modalityKey(modality)) }))
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
    try { await api(`/multimedia/tasks/${id}`, { method: 'DELETE' }); setPreview(null); await refreshJobs() } catch { /* ignore */ }
  }

  async function copy(text: string, label: string) {
    try { await navigator.clipboard.writeText(text); notify(t('copied', { label })) } catch { notify(t('copyFailed')) }
  }

  async function exportOutput(job: Job, idx: number) {
    const dest = exportPath.trim() || undefined
    if (!dest) { notify(t('needExportPath')); return }
    try {
      const r = await api<{ saved?: string }>(`/multimedia/export?jobId=${job.id}&idx=${idx}&destPath=${encodeURIComponent(dest)}`)
      notify(t('exported', { path: r.saved ?? '' }))
    } catch (e) { notify(t('exportFailed', { error: (e as Error).message })) }
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
    if (!Object.keys(patch).length) { notify(t('noChanges')); return }
    try {
      await api('/multimedia/channels', { method: 'PUT', body: JSON.stringify({ id, patch }) })
      notify(t('channelSaved'))
      setChannelForms((m) => ({ ...m, [id]: { ...m[id], apiKey: '' } }))
      await refreshChannels()
    } catch (e) { notify(t('saveFailed', { error: (e as Error).message })) }
  }

  async function testChannel(id: string) {
    setTestMsg((m) => ({ ...m, [id]: t('testing') }))
    try {
      const r = await api<{ message: string }>('/multimedia/test', { method: 'POST', body: JSON.stringify({ channelId: id }) })
      setTestMsg((m) => ({ ...m, [id]: t('testOk', { message: r.message }) }))
    } catch (e) {
      setTestMsg((m) => ({ ...m, [id]: t('testFailed', { error: (e as Error).message }) }))
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
      notify(t('channelAdded'))
      await refreshChannels()
    } catch (e) { notify(t('addFailed', { error: (e as Error).message })) }
  }

  async function removeChannel(id: string) {
    try { await api(`/multimedia/channels?id=${encodeURIComponent(id)}`, { method: 'DELETE' }); await refreshChannels() } catch { /* ignore */ }
  }

  /** Modal 确认后执行（删除渠道 / 删除作品 / 取消任务）。 */
  async function runConfirm() {
    if (!confirm) return
    const action = confirm
    setConfirm(null)
    if (action.kind === 'deleteChannel') await removeChannel(action.id)
    else if (action.kind === 'deleteJob') await removeJob(action.id)
    else await cancelJob(action.id)
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
      return <div className={styles.mmAudioWrap}><audio className={styles.mmAudio} src={out.fileUrl} controls /></div>
    }
    return <img className={styles.mmMedia} src={out.fileUrl} alt={t('resultAlt')} />
  }

  const renderTileMedia = (out: Output | undefined) => {
    if (!out) return <div className={styles.mmThumb} />
    if (out.kind === 'video' || /video\//.test(out.mime)) return <video className={styles.mmThumb} src={out.fileUrl} muted preload="metadata" />
    if (out.kind === 'audio' || /audio\//.test(out.mime)) return <div className={`${styles.mmThumb} ${styles.mmThumbAudio}`}>🔊</div>
    return <img className={styles.mmThumb} src={out.fileUrl} alt={t('thumbAlt')} loading="lazy" />
  }

  /* ── sections ── */

  const renderGenerate = () => (
    <div className={styles.mmCard}>
      <h3 className={styles.mmTitle}>{t('tabGenerate')}</h3>

      <div className={styles.mmRow}>
        <span className={styles.mmRowLabel}>{t('labelModality')}</span>
        {MODALITIES.map((m) => (
          <Button
            key={m.id}
            variant={modality === m.id ? 'primary' : 'outline'}
            size="sm"
            onClick={() => setModality(m.id)}
          >
            {t(m.labelKey)}
          </Button>
        ))}
      </div>

      <div className={styles.mmRow}>
        <span className={styles.mmRowLabel}>{t('labelChannel')}</span>
        <select className={styles.mmSelect} value={channelId} onChange={(e) => setChannelId(e.target.value)}>
          {capableChannels.map((c) => <option key={c.id} value={c.id}>{t('channelOption', { label: c.label, type: c.type })}</option>)}
        </select>
        {models.length > 0 && (
          <>
            <span className={styles.mmRowLabel}>{t('labelModel')}</span>
            <select className={styles.mmSelect} value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </>
        )}
        {activeChannel && !activeChannel.hasKey && !NO_KEY_TYPES.includes(activeChannel.type) && (
          <span className={`${styles.mmBadge} ${styles.mmBadgeErr}`}>{t('noApiKey')}</span>
        )}
      </div>

      <div className={`${styles.mmRow} ${styles.mmRowTop}`}>
        <span className={styles.mmRowLabel}>{t('labelPrompt')}</span>
        <textarea
          className={styles.mmTextarea}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={modality === 'tts' ? t('promptPlaceholderTts') : t('promptPlaceholderImage')}
        />
      </div>

      {activeChannel?.type === 'comfyui' && (
        <div className={`${styles.mmRow} ${styles.mmRowTop}`}>
          <span className={styles.mmRowLabel}>{t('labelWorkflow')}</span>
          <textarea
            className={`${styles.mmTextarea} ${styles.mmWorkflowTextarea}`}
            value={workflow}
            onChange={(e) => setWorkflow(e.target.value)}
            placeholder={t('workflowPlaceholder')}
          />
        </div>
      )}

      {modality === 'image' && (
        <div className={styles.mmRow}>
          <span className={styles.mmRowLabel}>{t('labelSize')}</span>
          <select className={styles.mmSelect} value={imageSize} onChange={(e) => setImageSize(e.target.value)}>
            {IMAGE_SIZES.map((s) => <option key={s.id} value={s.id}>{t(s.labelKey)}</option>)}
          </select>
          <span className={styles.mmRowLabel}>{t('labelCount')}</span>
          <input type="number" min={1} max={4} className={`${styles.mmInput} ${styles.mmW60}`} value={numImages} onChange={(e) => setNumImages(Math.max(1, Math.min(4, Number(e.target.value) || 1)))} />
          <span className={styles.mmRowLabel}>{t('labelSteps')}</span>
          <input type="number" className={`${styles.mmInput} ${styles.mmW70}`} placeholder={t('placeholderDefault')} value={steps} onChange={(e) => setSteps(e.target.value)} />
          <span className={styles.mmRowLabel}>{t('labelCfg')}</span>
          <input type="number" step="0.5" className={`${styles.mmInput} ${styles.mmW70}`} placeholder={t('placeholderDefault')} value={guidance} onChange={(e) => setGuidance(e.target.value)} />
          <span className={styles.mmRowLabel}>{t('labelSeed')}</span>
          <input type="number" className={`${styles.mmInput} ${styles.mmW100}`} placeholder={t('placeholderRandom')} value={seed} onChange={(e) => setSeed(e.target.value)} />
        </div>
      )}

      {modality === 'video' && (
        <div className={styles.mmRow}>
          <span className={styles.mmRowLabel}>{t('labelDuration')}</span>
          {VIDEO_DURATIONS.map((d) => (
            <Button
              key={d}
              variant={duration === d ? 'primary' : 'outline'}
              size="sm"
              onClick={() => setDuration(d)}
            >
              {t('unitSeconds', { n: d })}
            </Button>
          ))}
          <span className={styles.mmRowLabel}>{t('labelRatio')}</span>
          <select className={styles.mmSelect} value={aspect} onChange={(e) => setAspect(e.target.value)}>
            {ASPECT_RATIOS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <span className={styles.mmRowLabel}>{t('labelFrames')}</span>
          <input type="number" className={`${styles.mmInput} ${styles.mmW80}`} placeholder={t('placeholderDefault')} value={numFrames} onChange={(e) => setNumFrames(e.target.value)} />
          <span className={styles.mmRowLabel}>{t('labelSeed')}</span>
          <input type="number" className={`${styles.mmInput} ${styles.mmW100}`} placeholder={t('placeholderRandom')} value={seed} onChange={(e) => setSeed(e.target.value)} />
        </div>
      )}

      {modality === 'tts' && (
        <div className={styles.mmRow}>
          <span className={styles.mmRowLabel}>{t('labelVoice')}</span>
          <select className={styles.mmSelect} value={voice} onChange={(e) => setVoice(e.target.value)}>
            <option value="">{t('voiceDefault')}</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          {activeChannel?.type === 'elevenlabs' && (
            <>
              <span className={styles.mmRowLabel}>{t('labelStability')}</span>
              <input type="range" min={0} max={1} step={0.05} value={stability} onChange={(e) => setStability(Number(e.target.value))} />
              <span className={styles.mmHint}>{stability.toFixed(2)}</span>
              <span className={styles.mmRowLabel}>{t('labelSimilarity')}</span>
              <input type="range" min={0} max={1} step={0.05} value={similarity} onChange={(e) => setSimilarity(Number(e.target.value))} />
              <span className={styles.mmHint}>{similarity.toFixed(2)}</span>
            </>
          )}
          <span className={styles.mmRowLabel}>{t('labelFormat')}</span>
          <select className={styles.mmSelect} value={ttsFormat} onChange={(e) => setTtsFormat(e.target.value)}>
            {TTS_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
      )}

      <div className={styles.mmRow}>
        <Button
          variant="primary"
          size="sm"
          disabled={busy || !activeChannel || !prompt.trim()}
          onClick={generate}
        >
          {busy ? t('submitting') : t(modality === 'tts' ? 'generateSpeech' : modality === 'video' ? 'generateVideo' : 'generateImage')}
        </Button>
        {capableChannels.length === 0 && <span className={styles.mmHint}>{t('noChannelHint')}</span>}
      </div>
      {error && <div className={styles.mmError}>{error}</div>}
      {toast && <div className={styles.mmOk}>{toast}</div>}

      {activeJobs.length > 0 && (
        <div className={styles.mmSection}>
          <h4 className={styles.mmTitle}>{t('activeJobsTitle')}</h4>
          <div className={styles.mmJobStrip}>
            {activeJobs.map((j) => (
              <div key={j.id} className={styles.mmJobItem}>
                <StatusBadge status={j.status}>{statusLabel(j.status)}</StatusBadge>
                <span className={styles.mmJobMeta}>
                  {t('jobMeta', { id: j.id, channel: j.channelLabel, desc: j.prompt.slice(0, 60) || j.note || '' })}
                </span>
                <span className={styles.mmHint}>
                  {t('unitPercent', { n: j.progress })}{j.note ? `${t('metaSep')}${j.note}` : ''}
                </span>
                <Button variant="outline" size="sm" onClick={() => setConfirm({ kind: 'cancelJob', id: j.id })}>
                  {t('cancelJob')}
                </Button>
                <div className={`${styles.mmJobBar} ${styles.mmJobBarTrack}`}>
                  <div className={styles.mmJobBarFill} style={{ width: `${j.progress ?? 0}%` }} />
                </div>
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
          <h3 className={`${styles.mmTitle} ${styles.mmTitleInline}`}>{t('tabGallery')}</h3>
          <select className={styles.mmSelect} value={galleryFilter} onChange={(e) => setGalleryFilter(e.target.value as 'all' | Modality)}>
            <option value="all">{t('filterAll')}</option>
            {MODALITIES.map((m) => <option key={m.id} value={m.id}>{t(m.labelKey)}</option>)}
          </select>
        </div>
        {filtered.length === 0 && <div className={styles.mmHint}>{t('galleryEmpty')}</div>}
        <div className={styles.mmGrid}>
          {filtered.map((j) => (
            <div key={j.id} className={styles.mmTile} onClick={() => setPreview(j)}>
              {renderTileMedia(j.outputs?.[0])}
              <div className={styles.mmTileBody}>
                <div className={styles.mmTilePrompt}>{j.prompt || `(${j.modality})`}</div>
                <div className={styles.mmTileMeta}>
                  <StatusBadge status={j.status}>{statusLabel(j.status)}</StatusBadge>
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
      <h3 className={styles.mmTitle}>{t('channelsTitle')}</h3>
      <div className={styles.mmChannelList}>
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
                <span className={`${styles.mmBadge} ${styles.mmBadgeType}`}>{c.type}</span>
                {c.hasKey
                  ? <span className={styles.mmKeyTag}>{t('keyConfigured')}{c.apiKeyEnv ? t('keyEnv', { env: c.apiKeyEnv }) : t('keyMasked', { hint: c.keyHint })}</span>
                  : <span className={`${styles.mmKeyTag} ${styles.mmKeyTagMissing}`}>{t('noApiKey')}</span>}
                <span className={styles.mmSpacer} />
                <Button variant="outline" size="sm" onClick={() => testChannel(c.id)}>{t('testConnection')}</Button>
                <Button
                  variant="outline"
                  size="sm"
                  className={styles.mmBtnDanger}
                  onClick={() => setConfirm({ kind: 'deleteChannel', id: c.id, label: c.label })}
                >
                  {t('delete')}
                </Button>
              </div>
              <div className={`${styles.mmRow} ${styles.mmRowTight}`}>
                <span className={styles.mmRowLabel}>{t('labelBaseUrl')}</span>
                <input className={`${styles.mmInput} ${styles.mmW320}`} value={form.baseUrl} onChange={(e) => setChannelForms((m) => ({ ...m, [c.id]: { ...form, baseUrl: e.target.value } }))} />
                <span className={styles.mmRowLabel}>{t('labelApiKey')}</span>
                <input className={`${styles.mmInput} ${styles.mmW240}`} type="password" placeholder={c.hasKey ? t('keyUnchanged') : t('apiKeyPlaceholder')} value={form.apiKey} onChange={(e) => setChannelForms((m) => ({ ...m, [c.id]: { ...form, apiKey: e.target.value } }))} />
                {c.type === 'elevenlabs' && (
                  <>
                    <span className={styles.mmRowLabel}>{t('labelDefaultVoice')}</span>
                    <input className={`${styles.mmInput} ${styles.mmW200}`} placeholder={t('voiceIdPlaceholder')} value={form.voice} onChange={(e) => setChannelForms((m) => ({ ...m, [c.id]: { ...form, voice: e.target.value } }))} />
                  </>
                )}
                {c.type === 'cloudflare' && (
                  <>
                    <span className={styles.mmRowLabel}>{t('labelAccountId')}</span>
                    <input className={`${styles.mmInput} ${styles.mmW220}`} placeholder={t('accountIdPlaceholder')} value={form.accountId} onChange={(e) => setChannelForms((m) => ({ ...m, [c.id]: { ...form, accountId: e.target.value } }))} />
                  </>
                )}
                <Button variant="outline" size="sm" onClick={() => saveChannel(c.id)}>{t('save')}</Button>
              </div>
              {testMsg[c.id] && <div className={testMsg[c.id].startsWith('✅') ? styles.mmOk : styles.mmError}>{testMsg[c.id]}</div>}
            </div>
          )
        })}

        <div className={`${styles.mmCard} ${styles.mmChannelCard}`}>
          <h4 className={styles.mmTitle}>{t('addChannelTitle')}</h4>
          <div className={`${styles.mmRow} ${styles.mmRowNone}`}>
            <input className={styles.mmInput} placeholder={t('channelIdPlaceholder')} value={newChannel.id} onChange={(e) => setNewChannel((n) => ({ ...n, id: e.target.value }))} />
            <select className={styles.mmSelect} value={newChannel.type} onChange={(e) => setNewChannel((n) => ({ ...n, type: e.target.value }))}>
              <option value="fal">fal</option>
              <option value="elevenlabs">elevenlabs</option>
              <option value="comfyui">comfyui</option>
            </select>
            <input className={styles.mmInput} placeholder={t('displayNamePlaceholder')} value={newChannel.label} onChange={(e) => setNewChannel((n) => ({ ...n, label: e.target.value }))} />
            <Button variant="primary" size="sm" onClick={addChannel}>{t('add')}</Button>
          </div>
        </div>
      </div>
    </div>
  )

  const renderPreview = () => {
    if (!preview) return null
    const job = preview
    return (
      <div className={styles.mmOverlay} role="dialog" aria-modal="true" aria-label={t('previewAria')} onClick={() => setPreview(null)}>
        <div className={styles.mmPreview} onClick={(e) => e.stopPropagation()}>
          <div className={`${styles.mmRow} ${styles.mmRowGap8}`}>
            <StatusBadge status={job.status}>{statusLabel(job.status)}</StatusBadge>
            <strong>{job.channelLabel}</strong>
            <span className={styles.mmHint}>{job.model || ''}</span>
            <span className={styles.mmHint}>{fmtTime(job.createdAt)}</span>
            <span className={styles.mmSpacer} />
            <Button variant="outline" size="sm" onClick={() => setPreview(null)}>{t('close')}</Button>
          </div>
          {job.error && <div className={styles.mmError}>{job.error}</div>}
          <div className={styles.mmPreviewMedia}>{job.outputs.map((o) => <div key={o.idx}>{renderMedia(o)}</div>)}</div>
          <div className={styles.mmPreviewRow}>
            {job.outputs.map((o) => (
              <span key={o.idx}>
                <a className={`${styles.mmBtn} ${styles.mmLink}`} href={o.fileUrl} download>{t('download', { idx: o.idx })}</a>
                <Button variant="outline" size="sm" onClick={() => copy(o.url || o.fileUrl, t('linkCopy'))}>{t('copyLink')}</Button>
              </span>
            ))}
            <Button variant="outline" size="sm" onClick={() => copy(job.prompt, t('promptCopy'))}>{t('copyPrompt')}</Button>
            <Button variant="outline" size="sm" onClick={() => regen(job)}>{t('regen')}</Button>
            <span className={styles.mmRowLabel}>{t('exportTo')}</span>
            <input className={`${styles.mmInput} ${styles.mmW280}`} placeholder={t('exportPathPlaceholder')} value={exportPath} onChange={(e) => setExportPath(e.target.value)} />
            <Button variant="outline" size="sm" onClick={() => exportOutput(job, job.outputs[0]?.idx ?? 0)}>{t('export')}</Button>
            <span className={styles.mmSpacer} />
            <Button
              variant="outline"
              size="sm"
              className={styles.mmBtnDanger}
              onClick={() => setConfirm({ kind: 'deleteJob', id: job.id })}
            >
              {t('delete')}
            </Button>
          </div>
          {job.outputs[0] && (
            <div className={`${styles.mmHint} ${styles.mmHintTop}`}>
              {job.outputs.map((o) => t('outputSummary', { idx: o.idx, kind: o.kind, size: o.sizeLabel, seed: o.seed != null ? ` seed=${o.seed}` : '' })).join(t('metaSep'))}
            </div>
          )}
        </div>
      </div>
    )
  }

  const confirmTitle = confirm
    ? t(confirm.kind === 'deleteChannel' ? 'deleteChannelTitle' : confirm.kind === 'deleteJob' ? 'deleteJobTitle' : 'cancelJobTitle')
    : ''
  const confirmBody = confirm
    ? confirm.kind === 'deleteChannel'
      ? t('deleteChannelBody', { label: confirm.label })
      : t(confirm.kind === 'deleteJob' ? 'deleteJobBody' : 'cancelJobBody', { id: confirm.id })
    : undefined

  return (
    <div className={styles.mmRoot}>
      <div className={styles.mmTabs}>
        {([['generate', 'tabGenerate'], ['gallery', 'tabGallery'], ['channels', 'tabChannels']] as const).map(([id, key]) => (
          <button key={id} className={`${styles.mmTab} ${tab === id ? styles.mmTabActive : ''}`} onClick={() => setTab(id)}>{t(key)}</button>
        ))}
      </div>
      {tab === 'generate' && renderGenerate()}
      {tab === 'gallery' && renderGallery()}
      {tab === 'channels' && renderChannels()}
      {renderPreview()}

      {/* 危险操作确认 — primitives Modal，绝不 window.confirm */}
      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirmTitle}
        closeLabel={t('modalCancel')}
        description={confirmBody}
        footer={(
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>{t('modalCancel')}</Button>
            <Button variant="primary" size="sm" onClick={() => void runConfirm()}>
              {confirm?.kind === 'cancelJob' ? t('modalConfirmCancel') : t('modalConfirmDelete')}
            </Button>
          </>
        )}
      />
    </div>
  )
}
