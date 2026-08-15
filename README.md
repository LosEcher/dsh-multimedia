# dsh-multimedia — DSH 多媒体生成插件

多渠道（fal.ai / ElevenLabs / ComfyUI）文生图、文生视频、TTS 语音合成插件。
会话内「多媒体」tab 提供 **生成 / 作品库 / 渠道设置** 三区页面；host 侧提供
`/multimedia` HTTP API 与 agent 工具（`media_generate` / `media_list` /
`media_status` / `media_export`），支持产物下载、复制、导出到目录。

> 界面设计参考调研（LobeHub/LobeChat、OpenWebUI、Sora/可灵、Coze、Dify 等平台的生图/视频/TTS
> （LobeHub/LobeChat、OpenWebUI、Sora/可灵、Coze、Dify 等平台的生图/视频/TTS
> 页面模式），渠道 API 参考 fal.ai docs 与 ElevenLabs 文档。设计文档见
> `docs/DESIGN.md`。

## 安装

```sh
dsh plugin --profile web add github:LosEcher/dsh-multimedia#main
# 重启 dsh web（host 代码），client 重建后刷新页面即可
```

## 配置渠道

渠道种子定义在 `cordis.patch.yml` 的 `multimedia` 行；运行时增删改由页面
「渠道」区完成，落盘到 `<dataDir>/channels.json`（0600，运行时优先）。

API Key 策略：`apiKeyEnv`（环境变量）优先，其次页面输入的 `apiKey`
（存 channels.json，绝不写 patch 文件、绝不回传客户端）。

内置渠道类型：

| type | 能力 | 认证 | 说明 |
|---|---|---|---|
| `pollinations` | 文生图 | **免费无 Key** | 匿名免费（限 1 并发/5s），FLUX/Turbo 等 |
| `googletts` | TTS | **免费无 Key** | Google Translate TTS，中英日韩等，≤200 字符/次 |
| `cloudflare` | 文生图 / TTS | CF_API_TOKEN（免费层 10k neurons/天） | Workers AI：FLUX.1 Schnell + MeloTTS，需 accountId |
| `fal` | 文生图 / 文生视频 / TTS | `Authorization: Key <FAL_KEY>` | queue API，异步任务+轮询 |
| `elevenlabs` | TTS / 文生图 | `xi-api-key` | 同步 TTS；图片走异步 Flows（免费层 10k credits/月） |
| `comfyui` | 文生图 / 视频（工作流 JSON） | 无 | 本地 `127.0.0.1:8188`，需自备工作流 |
| `xai` | 文生图 / 图生图（编辑）/ 文生视频 / 视频编辑 / 视频扩展 | `Bearer <XAI_API_KEY>` | OpenAI 兼容 `https://api.x.ai/v1`；图片同步返回、视频异步轮询（request_id → done） |
| `zenmux` | 文生图 / 图生图（编辑）/ 图生视频 / 文生视频 / TTS | `Bearer <ZENMUX_API_KEY>` | OpenAI 兼容聚合网关 `https://zenmux.ai/api/v1`；图片/TTS 同步（b64），视频原生异步协议（`/videos` 提交 → 轮询） |

> ZenMux 渠道（2026-08-15 新增）：模型 slug 用「供应商/模型名」格式——
> 图片 `openai/gpt-image-2`（GPT 模型总是返回 b64）、视频
> `bytedance/doubao-seedance-2.0`（原生协议，480p–1080p，支持图生视频
> `params.image` → first_frame，可返回 last_frame 图）、TTS
> `google/gemini-3.1-flash-tts-preview`（默认 PCM，自动封装为 WAV 便于播放）。
> Key 在 https://zenmux.ai/platform/pay-as-you-go 充值并创建（PAYG 按量付费）。
> 更多模型 slug 见 https://zenmux.ai/models。

> xAI（Grok Imagine）渠道：模型 `grok-imagine-image-2.0`（图片生成/编辑）、
> `grok-imagine-video-1.5`（视频生成/编辑/扩展）。渠道页面可生成/编辑图片、
> 生成视频；**编辑与扩展**（需输入素材）由 agent 工具驱动：
> `media_generate(channel:'xai', modality:'image'|'video', prompt, params:{action:'edit'|'extend', image|video: '<http(s) url 或 data: URI>'})`。
> 视频为异步任务，`media_status` 可查询进度；结果含 xAI 用量（`cost_in_usd_ticks`）。
>
> **独立插件抽取路径**（dsh-xai 规划）：xAI 适配器是模块级工厂
> `createXaiAdapter({req, sleep, log, collect})`（`lib/adapters.mjs` 顶部），
> 不依赖 Cordis 上下文——未来需要专属控制台（用量看板/编辑工作台）时，
> 直接 `import { createXaiAdapter }` 复用，UI 与任务队列按需自建。

> 免费验证路径（2026-08-15 实测全通）：Pollinations 文生图 + Google TTS 语音，
> 零注册零 Key；Cloudflare/ElevenLabs 免费层需注册。视频生成暂无免费 API，
> 可选智谱 CogVideoX / MiniMax / 即梦（每日 66 积分）或本地 ComfyUI。

## HTTP API（同源 `/multimedia`）

- `GET  /multimedia/channels` — 渠道列表（Key 掩码）
- `PUT  /multimedia/channels` `{id, patch{enabled|label|baseUrl|apiKey|voice|extra}}`
- `POST /multimedia/channels` / `DELETE /multimedia/channels?id=`
- `POST /multimedia/test` `{channelId}` — 连通性/鉴权测试
- `GET  /multimedia/models?channelId=&modality=` — 模型/音色预设
- `POST /multimedia/generate` `{channelId, modality, prompt, model, params}`
- `GET  /multimedia/tasks[?limit=&modality=&status=&channelId=]`
- `GET  /multimedia/tasks/:id` / `DELETE /multimedia/tasks/:id`
- `POST /multimedia/cancel` `{jobId}`
- `GET  /multimedia/file/:jobId/:idx` — 产物流式下载
- `GET  /multimedia/export?jobId=&idx=&destPath=` — 复制产物到目录

## Agent 工具

```
media_generate(channel?, modality, prompt, params?, model?, run_in_background?)
media_list(limit?, modality?, status?)
media_status(jobId)
media_export(jobId, outputIndex?, destPath?)
```

产物默认落在 `~/.dsh/multimedia/results/<jobId>/`，任务快照 `jobs.json`。

## 开发

```sh
node test/run.mjs     # host 侧冒烟测试（core + adapters，fake fetch）
node scripts/build.mjs # client 构建（esbuild，CSS Module 内联）
```

- client 产物由 web 直接 serve 源文件：改 `src/client` 后重建 + 刷新页面即可；
- host 代码（index.mjs / lib）改动需重启 dsh web。
- 安全：产物 URL 可能含公开签名链接，`/multimedia/file` 走本地缓存流，
  不把提供商链接透给客户端页面之外的消费方。
