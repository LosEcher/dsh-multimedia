/**
 * dsh-multimedia — host 入口冒烟测试（跨版本门禁）。
 *
 * 用**运行中 profile 的真实宿主库**（@deepseek-ai/dsh-tools）加载插件入口
 * index.mjs，用桩 ctx 驱动 apply()。锁住四类只有"装到真宿主里"才暴露的漂移：
 *   1. 模块能加载（语法/裸导入/@deepseek-ai/dsh-tools 存在）——本插件**没有自己的
 *      node_modules**，宿主库一旦缺失/改名，生产里就是整棵插件树异常；
 *   2. 注入契约（inject=['timer','webServer','tools']）与路由注册
 *      （/multimedia 前缀 + /plugins/dsh-multimedia/status 约定信封）；
 *   3. **5 个 agent 工具都必须被真实 defineTool 编译并注册**（模型可见面：
 *      media_generate / media_list / media_status / media_balance / media_export）；
 *   4. 生命周期：dispose 后两个内部定时器必须真的停（否则每次插件重载都漏定时器，
 *      在真宿主里表现为后台任务越积越多）——用**行为**判定而非内部字段。
 *
 * 设计要点（沿用 dsh-scheduler / dsh-verify-gate 先例）：
 *   - 依赖从 profile 解析（test/fixtures/resolve-host.mjs），不赌本机软链；
 *   - 解析不到宿主库 ⇒ skip 并打印原因，而不是假装通过（防空转）；
 *   - **dataDir 指向临时目录**，绝不碰用户真实 storages/channels/jobs；
 *   - 不触发真实生成：只做注册与结构断言，不调用任何工具 execute。
 *
 * 运行：node --test test/host-smoke.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** 宿主库探测链：显式 env → ~/.dsh/profiles（link 插件的公共层）→ web profile。 */
function findHostRoot() {
  const candidates = [
    process.env.DSH_HOST_MODULES,
    process.env.DSH_PROFILE_ROOT,
    join(homedir(), '.dsh', 'profiles'),
    join(homedir(), '.dsh', 'profiles', 'web'),
  ].filter(Boolean)
  for (const root of candidates) {
    if (existsSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-tools'))) return root
  }
  return null
}

const HOST_ROOT = findHostRoot()
const SKIP = HOST_ROOT
  ? false
  : '未找到宿主 node_modules（profile 未安装 @deepseek-ai/dsh-tools），跳过而非假装通过'

/** 模型可见的工具面：新增/改名都是破坏性变更，必须同步改这里（刻意显式）。 */
const TOOL_NAMES = ['media_generate', 'media_list', 'media_status', 'media_balance', 'media_export']

/** 桩 ctx：捕获路由、工具、定时器（含跳数）与 dispose 回调。 */
function makeCtx() {
  const routes = []
  const registeredTools = []
  const logs = []
  const timerHandles = new Set()
  const timerTicks = { count: 0 }
  const disposeHandlers = []
  return {
    routes,
    registeredTools,
    logs,
    timerHandles,
    timerTicks,
    disposeHandlers,
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    tools: { register: (t) => { registeredTools.push(t); return () => {} } },
    setInterval: (fn, ms) => {
      const wrapped = () => {
        timerTicks.count += 1
        fn()
      }
      const h = setInterval(wrapped, ms)
      if (typeof h?.unref === 'function') h.unref()
      timerHandles.add(h)
      return h
    },
    logger: {
      info: (m) => logs.push(`info: ${String(m)}`),
      warn: (m) => logs.push(`warn: ${String(m)}`),
      error: (m) => logs.push(`error: ${String(m)}`),
    },
    on: (event, fn) => { if (event === 'dispose') disposeHandlers.push(fn) },
    dispose: () => { for (const fn of disposeHandlers.splice(0)) { try { fn() } catch { /* 清理失败不掩盖判定 */ } } },
  }
}

async function loadPlugin(dshHome) {
  process.env.DSH_HOME = dshHome
  process.env.DSH_HOST_MODULES = HOST_ROOT
  register(new URL('./fixtures/resolve-host.mjs', import.meta.url).href)
  return await import(`../index.mjs?smoke=${Date.now()}`)
}

test('host 冒烟：真实宿主库加载入口 + 注入/路由/工具面 + dispose 停定时器', { skip: SKIP }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-mm-smoke-'))
  const ctx = makeCtx()
  try {
    const mod = await loadPlugin(dataDir)
    assert.equal(mod.name, 'dsh-multimedia')
    assert.deepEqual(mod.inject, ['timer', 'webServer', 'tools'], 'inject 是宿主服务门控，漂移会导致 ctx.* 不可用')
    assert.equal(mod.apply.inject, mod.inject, 'apply.inject 与模块级 inject 必须一致（Cordis 两种读法）')

    mod.apply(ctx, { dataDir })

    // ── 路由：/multimedia 前缀 + /plugins/dsh-multimedia/status 约定信封 ──
    const media = ctx.routes.find((r) => r.path === '/multimedia')
    assert.ok(media, '/multimedia 前缀路由应注册')
    assert.equal(media.kind, 'prefix')
    assert.equal(typeof media.handler, 'function')

    const status = ctx.routes.find((r) => r.path === '/plugins/dsh-multimedia/status')
    assert.ok(status, '/plugins/dsh-multimedia/status 应注册（2026-08-23 统一约定，与 dashboards/scheduler 同构）')
    assert.equal(status.kind, 'exact')
    const res = {
      statusCode: 0,
      body: '',
      writeHead(code) { this.statusCode = code },
      end(chunk) { this.body = chunk ?? '' },
    }
    status.handler({ url: '/plugins/dsh-multimedia/status', method: 'GET' }, res)
    const envelope = JSON.parse(res.body)
    assert.equal(res.statusCode, 200)
    assert.equal(envelope.ok, true)
    assert.equal(envelope.plugin, 'dsh-multimedia')
    assert.equal(typeof envelope.version, 'string', 'version 应来自 package.json')
    assert.equal(envelope.lastError, null)
    assert.deepEqual(
      Object.keys(envelope.counts).sort(),
      ['active', 'channels', 'channelsEnabled', 'failed', 'inflight', 'jobs'],
    )
    assert.equal(envelope.counts.jobs, 0, '临时 dataDir 下应无 job')
    assert.equal(envelope.counts.inflight, 0)
    assert.equal(envelope.detail.dataDir, dataDir, 'detail 应回显真实 dataDir（排障用）')

    // ── 数据目录隔离：apply 必须在传入的 dataDir 下建 results/，而不是用户 storages ──
    assert.ok(existsSync(join(dataDir, 'results')), 'apply 应在配置的 dataDir 下创建 results/')

    // ── 工具面：5 个工具都必须被真实 defineTool 编译成功并注册 ──
    const names = ctx.registeredTools.map((t) => t.name).sort()
    assert.deepEqual(names, [...TOOL_NAMES].sort(), `注册到的工具：${names.join(', ') || '(none)'}`)
    for (const t of ctx.registeredTools) {
      assert.equal(typeof t.execute, 'function', `${t.name} 缺少 execute`)
    }

    // ── 生命周期：dispose 后内部定时器必须真的不再跳（行为判定）──
    assert.equal(ctx.timerHandles.size, 2, 'apply 应起两个内部定时器（dispatch/resumeStale）')
    const before = ctx.timerTicks.count
    ctx.dispose()
    await new Promise((resolve) => setTimeout(resolve, 1_700))
    assert.equal(
      ctx.timerTicks.count,
      before,
      'dispose 后定时器仍在跑：每次插件重载都会漏一个循环（真宿主里后台任务越积越多）',
    )
  } finally {
    ctx.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
