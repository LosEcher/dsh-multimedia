/**
 * dsh-multimedia — lib/tools.mjs
 * Agent tool definitions (pure: no cordis, no dsh-tools import — callers map
 * them through defineTool). Single source of truth; test/preflight.mjs
 * validates every definition against the REAL @deepseek-ai/dsh-tools
 * compiler before the plugin ever touches the web profile.
 */
import { existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createJob, extForMime } from './core.mjs'

export function createToolDefs(deps) {
  const { channels, jobs, awaitJob, summarize, dataDir, dispatch } = deps

  const OBJECT_SCHEMA = { type: 'object', additionalProperties: true, properties: {} }
  const renderLines = (_args, value) => [{ type: 'text', text: value.lines.join('\n') }]

  return [
    {
      name: 'media_generate',
      description: '通过已配置的多媒体渠道生成图片/视频/语音：指定 channel（fal/elevenlabs/comfyui 渠道 id）、modality（image/video/audio/tts）、prompt 与 params（steps/seed/image_size/num_images/duration/voice/stability 等，extra 对象透传给渠道）。产物保存在 ~/.dsh/multimedia/results/<jobId>/，返回任务状态与产物本地路径。',
      parameters: {
        channel: { type: 'string', description: '渠道 id（默认 fal；elevenlabs 或 comfyui）' },
        modality: { type: 'string', required: true, description: 'image | video | audio | tts' },
        prompt: { type: 'string', required: true, description: '生成提示词（TTS 为朗读文本）' },
        params: { type: 'object', additionalProperties: true, description: '生成参数：image_size/steps/guidance_scale/seed/num_images/duration/aspect_ratio/voice/stability/similarity_boost/extra{} 等，按渠道与模型透传' },
        model: { type: 'string', description: '模型 id（如 fal-ai/flux/schnell、eleven_multilingual_v2）' },
        run_in_background: { type: 'boolean', description: 'true 立即返回任务 id（异步）；false（默认）等待完成并返回全部产物路径' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            jobId: { type: 'string' },
            status: { type: 'string' },
            error: { type: 'string' },
            lines: { type: 'array', items: { type: 'string' } },
            outputs: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        render: renderLines,
      },
      timeoutMs: 120000,
      async execute(args, exec) {
        const channelId = String(args.channel ?? 'fal')
        const channel = channels.get(channelId)
        if (!channel) {
          return { jobId: '', status: 'failed', error: `渠道不存在：${channelId}`, lines: [`渠道不存在：${channelId}（可用：${channels.list().map((c) => `${c.id}(${c.type})`).join(', ')}）`] }
        }
        if (!channel.enabled) {
          return { jobId: '', status: 'failed', error: `渠道已停用：${channel.label}`, lines: [`渠道已停用：${channel.label}，请先在「多媒体」tab 渠道设置中启用`] }
        }
        const job = createJob({ channelId, modality: args.modality, prompt: args.prompt, params: args.params ?? {}, model: args.model ?? '', channelLabel: channel.label })
        jobs.add(job)
        dispatch?.()
        if (args.run_in_background) {
          const j = jobs.get(job.id)
          return { jobId: job.id, status: j.status, lines: [`已提交 ${job.id}（${job.modality} @ ${channel.label}）`, ...summarize(j).split('\n')] }
        }
        const done = await awaitJob(job.id, exec?.signal)
        return { jobId: job.id, status: done.status, error: done.error, outputs: done.outputs, lines: summarize(done).split('\n') }
      },
    },
    {
      name: 'media_list',
      description: '列出多媒体生成任务（作品库），可按 modality/status 过滤。',
      parameters: {
        limit: { type: 'integer', description: '最多返回条数（默认 20）' },
        modality: { type: 'string', description: 'image | video | audio | tts' },
        status: { type: 'string', description: 'queued | running | succeeded | failed | cancelled' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            jobs: { type: 'array', items: { type: 'object', additionalProperties: true } },
            lines: { type: 'array', items: { type: 'string' } },
          },
        },
        render: renderLines,
      },
      async execute(args) {
        const list = jobs.list({ limit: args.limit ?? 20, modality: args.modality, status: args.status })
        if (!list.length) return { jobs: [], lines: ['暂无任务'] }
        return {
          jobs: list.map((j) => ({ id: j.id, status: j.status, modality: j.modality, channelLabel: j.channelLabel, prompt: j.prompt, error: j.error })),
          lines: list.map((j) => `[${j.status}] ${j.id} ${j.modality} @ ${j.channelLabel} — ${j.prompt.slice(0, 80)}${j.error ? ` ❌ ${j.error.slice(0, 120)}` : ''}`),
        }
      },
    },
    {
      name: 'media_status',
      description: '查询单个多媒体任务状态与产物。',
      parameters: {
        jobId: { type: 'string', required: true, description: '任务 id' },
      },
      output: {
        schema: { ...OBJECT_SCHEMA, properties: { job: OBJECT_SCHEMA, lines: { type: 'array', items: { type: 'string' } } } },
        render: renderLines,
      },
      async execute(args) {
        const job = jobs.get(String(args.jobId))
        if (!job) return { job: null, lines: [`任务不存在：${args.jobId}`] }
        return { job: { ...job, outputs: job.outputs.map((o) => ({ ...o })) }, lines: summarize(job).split('\n') }
      },
    },
    {
      name: 'media_export',
      description: '把多媒体任务产物导出到指定目录（默认 ~/.dsh/multimedia/exports），返回落盘路径。',
      parameters: {
        jobId: { type: 'string', required: true, description: '任务 id' },
        outputIndex: { type: 'integer', description: '产物序号（默认 0）' },
        destPath: { type: 'string', description: '目标目录（绝对路径）' },
      },
      output: {
        schema: { ...OBJECT_SCHEMA, properties: { saved: { type: 'string' }, lines: { type: 'array', items: { type: 'string' } } } },
        render: renderLines,
      },
      async execute(args) {
        const job = jobs.get(String(args.jobId))
        if (!job) return { saved: '', lines: [`任务不存在：${args.jobId}`] }
        const output = job.outputs?.[Number(args.outputIndex ?? 0)]
        if (!output?.localFile || !existsSync(output.localFile)) return { saved: '', lines: ['产物文件不存在'] }
        const destDir = resolve(args.destPath ?? join(dataDir, 'exports'))
        mkdirSync(destDir, { recursive: true })
        const name = `${job.id}-${output.idx}${extForMime(output.mime, output.url)}`
        copyFileSync(output.localFile, join(destDir, name))
        const saved = join(destDir, name)
        return { saved, lines: [`已导出：${saved}`] }
      },
    },
  ]
}
