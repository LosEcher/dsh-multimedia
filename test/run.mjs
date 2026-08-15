/**
 * dsh-multimedia — test/run.mjs
 * Host-side smoke tests: core helpers + adapters with an injected fake fetch.
 * Run: node test/run.mjs
 */
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  normalizeChannels, ChannelStore, JobStore, createJob, collectUrls,
  channelKey, maskChannel, extForMime,
} from '../lib/core.mjs'
import { createAdapters } from '../lib/adapters.mjs'

let passed = 0
let failed = 0
function ok(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name} ${extra}`) }
}

const DATA = mkdtempSync(join(tmpdir(), 'dsh-mm-'))

console.log('— core —')
{
  const chans = normalizeChannels([
    { id: 'fal', type: 'fal', label: 'fal.ai', enabled: false, apiKeyEnv: 'FAL_KEY' },
    { id: 'x', type: 'bogus', label: 'X' },
  ])
  ok('normalize keeps valid type', chans[0].type === 'fal')
  ok('unknown type defaults to fal', chans[1].type === 'fal')
  ok('enabled defaults true', chans[1].enabled === true)
}

{
  process.env.TEST_MM_KEY = 'sk-secret-1234'
  const c = { id: 'a', type: 'fal', apiKeyEnv: 'TEST_MM_KEY', apiKey: 'literal' }
  ok('env key wins', channelKey(c) === 'sk-secret-1234')
  const c2 = { id: 'b', type: 'fal', apiKeyEnv: '', apiKey: 'literal' }
  ok('literal fallback', channelKey(c2) === 'literal')
  const m = maskChannel(c)
  ok('mask hides key', m.hasKey === true && m.keyHint === '1234' && !('apiKey' in m))
  delete process.env.TEST_MM_KEY
}

{
  const store = new ChannelStore(DATA, [
    { id: 'fal', type: 'fal', label: 'fal.ai', enabled: true, apiKeyEnv: 'FAL_KEY', apiKey: '', baseUrl: 'https://queue.fal.run' },
  ])
  const list = store.list()
  list[0].label = '改了'
  store.persist(list)
  const store2 = new ChannelStore(DATA, [
    { id: 'fal', type: 'fal', label: 'fal.ai', enabled: true, apiKeyEnv: 'FAL_KEY', apiKey: '', baseUrl: 'https://queue.fal.run' },
  ])
  ok('runtime channel override persists', store2.get('fal')?.label === '改了')
}

{
  const jobs = new JobStore(DATA)
  const job = createJob({ channelId: 'fal', modality: 'video', prompt: 'a cat', params: { duration: 5 }, model: 'fal-ai/kling-video/v2.1/standard', channelLabel: 'fal.ai' })
  jobs.add(job)
  jobs.update(job.id, { status: 'running', progress: 10 })
  const j2 = new JobStore(DATA)
  ok('job persists', j2.get(job.id)?.status === 'running' && j2.get(job.id)?.progress === 10)
  jobs.remove(job.id)
  ok('job removed', jobs.get(job.id) === undefined)
}

{
  const urls = collectUrls({ images: [{ url: 'https://x/img.png' }], video: { url: 'https://x/v.mp4' }, audio_url: 'https://x/a.mp3' })
  ok('collectUrls kinds', urls.some((u) => u.kind === 'image' && u.url.includes('img.png')) && urls.some((u) => u.kind === 'video') && urls.some((u) => u.kind === 'audio'))
  ok('extForMime', extForMime('video/mp4', 'x') === '.mp4')
}

console.log('— adapters (fake fetch) —')
{
  /** fake fetch: route by url fragment */
  const routes = new Map()
  const fakeFetch = async (url, init) => {
    const key = `${init?.method ?? 'GET'} ${url}`
    const hit = routes.get(key) ?? routes.get(url)
    if (!hit) throw new Error(`unmocked: ${key}`)
    if (hit && typeof hit === 'object' && init?.body) hit._body = String(init.body)
    if (typeof hit === 'string') return { ok: true, status: 200, headers: { get: () => '' }, json: async () => JSON.parse(hit), text: async () => hit, arrayBuffer: async () => Buffer.from(hit) }
    return hit
  }
  const adapters = createAdapters({ fetchImpl: fakeFetch, sleep: async () => {} })
  const key = 'test-key'
  const channel = { id: 'eleven', type: 'elevenlabs', label: 'ElevenLabs', enabled: true, apiKeyEnv: '', apiKey: key, baseUrl: 'https://api.elevenlabs.io/v1' }

  // elevenlabs TTS: binary response
  {
    routes.set('POST https://api.elevenlabs.io/v1/text-to-speech/v1?output_format=mp3_44100_128', {
      ok: true, status: 200, headers: { get: () => 'audio/mpeg' },
      arrayBuffer: async () => Buffer.from('ID3fakeaudio'),
    })
    const job = createJob({ channelId: 'eleven', modality: 'tts', prompt: '你好世界', params: { voice: 'v1', stability: 0.6 } })
    const saved = []
    const api = {
      channelKey: () => key,
      progress: () => {},
      saveOutput: async (j, o) => { const out = { ...o, idx: j.outputs.length, localFile: `/tmp/x${j.outputs.length}.mp3`, fileUrl: '/f', mime: o.mime ?? 'audio/mpeg', size: 100, sizeLabel: '100 B' }; j.outputs.push(out); saved.push(out); return out },
    }
    const result = await adapters.elevenlabs.generate(channel, job, api)
    ok('elevenlabs tts outputs 1 audio', result.outputs.length === 1 && result.outputs[0].kind === 'audio')
    const sent = routes.get('POST https://api.elevenlabs.io/v1/text-to-speech/v1?output_format=mp3_44100_128')
    ok('elevenlabs tts received text+settings', (sent?._body ?? '').includes('你好世界'))
  }

  // elevenlabs image flow: POST /flows/image → poll → content_url
  {
    routes.set('POST https://api.elevenlabs.io/v1/flows/image', {
      ok: true, status: 200, headers: { get: () => '' },
      json: async () => ({ id: 'flow-1', status: 'pending' }),
    })
    let flowCalls = 0
    routes.set('GET https://api.elevenlabs.io/v1/flows/flow-1', {
      ok: true, status: 200, headers: { get: () => '' },
      json: async () => (++flowCalls === 1
        ? { id: 'flow-1', status: 'processing' }
        : { id: 'flow-1', status: 'succeeded', content_url: 'https://storage.elevenlabs.io/img.png' }),
    })
    const job = createJob({ channelId: 'eleven', modality: 'image', prompt: 'a cat', params: { image_size: '1024x1024' } })
    const api = {
      channelKey: () => key,
      progress: () => {},
      saveOutput: async (j, o) => { const out = { ...o, idx: j.outputs.length, localFile: '/tmp/f.png', fileUrl: '/f', mime: 'image/png', size: 10, sizeLabel: '10 B' }; j.outputs.push(out); return out },
    }
    const result = await adapters.elevenlabs.generate(channel, job, api)
    ok('elevenlabs flows image', result.outputs.length === 1 && result.meta.providerJobId === 'flow-1' && result.outputs[0].url.includes('storage.elevenlabs.io'))
  }

  // googletts: GET translate_tts → mp3 bytes
  {
    routes.set('GET https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=zh-CN&q=hello', {
      ok: true, status: 200, headers: { get: () => 'audio/mpeg' },
      arrayBuffer: async () => Buffer.from('MP3DATA'),
    })
    const job = createJob({ channelId: 'gt', modality: 'tts', prompt: 'hello', params: {} })
    const api = { channelKey: () => '', progress: () => {}, saveOutput: async (j, o) => { const out = { ...o, idx: 0, localFile: '/tmp/g.mp3', fileUrl: '/f', mime: o.mime, size: 7, sizeLabel: '7 B' }; j.outputs.push(out); return out } }
    const result = await adapters.googletts.generate({ id: 'gt', type: 'googletts', baseUrl: 'https://translate.google.com' }, job, api)
    ok('googletts mp3', result.outputs.length === 1 && result.outputs[0].kind === 'audio' && result.meta.lang === 'zh-CN')
  }

  // pollinations image: GET prompt → jpeg bytes
  {
    routes.set('GET https://image.pollinations.ai/prompt/a%20cat?width=1024&height=1024&model=flux&seed=1&nologo=true&private=true', {
      ok: true, status: 200, headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => Buffer.from('JPEGDATA'),
    })
    routes.set('GET https://image.pollinations.ai/models', { ok: true, status: 200, headers: { get: () => '' }, json: async () => ({ models: ['flux'] }) })
    const job = createJob({ channelId: 'polli', modality: 'image', prompt: 'a cat', params: { seed: 1 }, model: 'flux' })
    const api = { channelKey: () => '', progress: () => {}, saveOutput: async (j, o) => { const out = { ...o, idx: 0, localFile: '/tmp/p.jpg', fileUrl: '/f', mime: o.mime, size: 9, sizeLabel: '9 B' }; j.outputs.push(out); return out } }
    const result = await adapters.pollinations.generate({ id: 'polli', type: 'pollinations', baseUrl: 'https://image.pollinations.ai' }, job, api)
    ok('pollinations image jpeg', result.outputs.length === 1 && result.outputs[0].mime === 'image/jpeg' && result.meta.seed === '1')
  }

  // streamelements tts: GET speech → mp3 bytes
  {
    routes.set('GET https://api.streamelements.com/kappa/v2/speech?voice=Brian&text=hello', {
      ok: true, status: 200, headers: { get: () => 'audio/mpeg' },
      arrayBuffer: async () => Buffer.from('MP3DATA'),
    })
    const job = createJob({ channelId: 'se', modality: 'tts', prompt: 'hello', params: {} })
    const api = { channelKey: () => '', progress: () => {}, saveOutput: async (j, o) => { const out = { ...o, idx: 0, localFile: '/tmp/s.mp3', fileUrl: '/f', mime: o.mime, size: 7, sizeLabel: '7 B' }; j.outputs.push(out); return out } }
    const result = await adapters.streamelements.generate({ id: 'se', type: 'streamelements', baseUrl: 'https://api.streamelements.com' }, job, api)
    ok('streamelements tts mp3', result.outputs.length === 1 && result.outputs[0].kind === 'audio' && result.meta.voice === 'Brian')
  }

  // fal queue: submit → IN_QUEUE → COMPLETED → result
  {
    const falChannel = { ...channel, id: 'fal', type: 'fal', baseUrl: 'https://queue.fal.run' }
    const base = 'https://queue.fal.run'
    const model = 'fal-ai/flux/schnell'
    routes.set(`POST ${base}/${model}`, {
      ok: true, status: 200, headers: { get: () => '' },
      json: async () => ({ request_id: 'req-1' }),
    })
    let statusCall = 0
    routes.set(`GET ${base}/${model}/requests/req-1/status`, {
      ok: true, status: 200, headers: { get: () => '' },
      json: async () => (++statusCall === 1 ? { status: 'IN_QUEUE' } : { status: 'COMPLETED' }),
    })
    routes.set(`GET ${base}/${model}/requests/req-1`, {
      ok: true, status: 200, headers: { get: () => '' },
      json: async () => ({ images: [{ url: 'https://cdn.fal.ai/img1.png' }], seed: 42 }),
    })
    const job = createJob({ channelId: 'fal', modality: 'image', prompt: 'a dog', params: {}, model })
    const api = {
      channelKey: () => key,
      progress: () => {},
      saveOutput: async (j, o) => { const out = { ...o, idx: j.outputs.length, localFile: `/tmp/x${j.outputs.length}.png`, fileUrl: '/f', mime: 'image/png', size: 10, sizeLabel: '10 B' }; j.outputs.push(out); return out },
    }
    const result = await adapters.fal.generate(falChannel, job, api)
    ok('fal queue returns output with providerJobId', result.outputs.length === 1 && result.meta.providerJobId === 'req-1' && result.meta.seed === 42)
  }

  // comfyui: submit → completed history
  {
    const base = 'http://127.0.0.1:8188'
    routes.set(`POST ${base}/prompt`, {
      ok: true, status: 200, headers: { get: () => '' },
      json: async () => ({ prompt_id: 'p-9' }),
    })
    routes.set(`GET ${base}/history/p-9`, {
      ok: true, status: 200, headers: { get: () => '' },
      json: async () => ({ 'p-9': { status: { completed: true }, outputs: { '3': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } }),
    })
    const job = createJob({ channelId: 'comfy', modality: 'image', prompt: '', params: { workflow: '{"3":{"inputs":{}}}' } })
    const api = {
      channelKey: () => '',
      progress: () => {},
      saveOutput: async (j, o) => { const out = { ...o, idx: j.outputs.length, localFile: '/tmp/c.png', fileUrl: '/f', mime: 'image/png', size: 10, sizeLabel: '10 B' }; j.outputs.push(out); return out },
    }
    const result = await adapters.comfyui.generate({ ...channel, id: "comfy", type: "comfyui", baseUrl: "http://127.0.0.1:8188" }, job, api)
    ok('comfyui history output captured', result.outputs.length === 1 && result.meta.providerJobId === 'p-9')
  }
}

rmSync(DATA, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
