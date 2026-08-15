/**
 * dsh-multimedia — test/preflight.mjs
 * 关键预检：把 lib/tools.mjs 的四个工具定义喂给【真实】@deepseek-ai/dsh-tools
 * 的 defineTool 编译器（从 web profile 的扁平 fallback 解析），任何参数
 * schema / output schema 编译错误都会在这里抛出——绝不让 web 插件树再炸。
 *
 * Run: node test/preflight.mjs   （在改 index.mjs / lib/tools.mjs 后必跑）
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { createToolDefs } from '../lib/tools.mjs'

const PROFILE = process.env.DSH_PROFILE ?? '/Users/echerlos/.dsh/profiles/web'
const ANCHOR = `${PROFILE}/`

if (!existsSync(`${PROFILE}/node_modules`)) {
  console.error(`profile 不存在：${PROFILE}`)
  process.exit(1)
}

const require = createRequire(ANCHOR)
let entry
try {
  entry = require.resolve('@deepseek-ai/dsh-tools')
} catch (e) {
  console.error(`无法从 ${ANCHOR} 解析 @deepseek-ai/dsh-tools：${e.message}`)
  process.exit(1)
}
const tools = await import(pathToFileURL(entry).href)
if (typeof tools.defineTool !== 'function') {
  console.error('dsh-tools 未导出 defineTool，API 又变了？')
  process.exit(1)
}

const defs = createToolDefs({
  channels: { get: () => ({ id: 'fal', enabled: true, label: 'fal.ai' }), list: () => [{ id: 'fal', type: 'fal' }] },
  jobs: { get: () => undefined, add: () => {}, list: () => [] },
  awaitJob: async () => ({ status: 'succeeded' }),
  summarize: () => '',
  dataDir: '/tmp',
  dispatch: () => {},
})

let n = 0
for (const def of defs) {
  try {
    tools.defineTool(def) // 编译失败会抛错
    n += 1
    console.log(`  ✓ defineTool 编译通过: ${def.name}`)
  } catch (e) {
    console.error(`  ✗ ${def.name} 编译失败: ${e.message}`)
    process.exit(1)
  }
}

// render 冒烟：产出 ContentBlock
const rendered = defs[0].output.render({}, { jobId: 'x', status: 'succeeded', lines: ['a', 'b'] })
if (!Array.isArray(rendered) || rendered[0]?.type !== 'text') {
  console.error('render 输出不符合 ContentBlock[] 形态')
  process.exit(1)
}

console.log(`\n${n} 个工具定义全部通过真实 dsh-tools 编译器预检 ✓`)
