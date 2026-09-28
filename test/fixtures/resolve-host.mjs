/**
 * 测试用 ESM resolve 钩子：把 `@deepseek-ai/*`（宿主提供的库）解析到运行中
 * profile 的 node_modules，而不是插件自己的 node_modules。
 *
 * 为什么需要它：dsh-multimedia **没有自己的 node_modules**，`@deepseek-ai/dsh-tools`
 * 完全由 profile 提供 —— 直接 import 插件入口必然 ERR_MODULE_NOT_FOUND，于是门禁
 * 要么被绕过（只测纯函数），要么依赖「本机手动建了软链」这种环境赌注。
 *
 * 这里复用 DSH 自己的解析路径：把 bare specifier 的 parentURL 换到 profile 根
 * 下的锚点文件，交给 Node 原生解析（即使用**运行中宿主的那一份**库，能抓到
 * 宿主 API 漂移）。
 *
 * 用法：DSH_HOST_MODULES=<profile 根> + module.register('./fixtures/resolve-host.mjs')
 *
 * 与 dsh-scheduler / dsh-verify-gate / dsh-dashboards 的同名 fixture 同源
 * （先例：dsh-undo tests/harness-compat.test.ts）。
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const ROOT = process.env.DSH_HOST_MODULES
const ANCHOR = ROOT ? pathToFileURL(join(ROOT, '__dsh_host_anchor__.mjs')).href : null

export async function resolve(specifier, context, next) {
  if (ANCHOR && specifier.startsWith('@deepseek-ai/')) {
    return next(specifier, { ...context, parentURL: ANCHOR })
  }
  return next(specifier, context)
}
