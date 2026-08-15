# dsh-multimedia 设计文档

多渠道多媒体生成插件：文生图 / 文生视频 / TTS，页面配置渠道 + 生成 + 作品库 + 导出。
会话 tab「多媒体」；host 侧 `/multimedia` API 与 4 个 agent 工具。

## 1. 调研依据（2026-08-15 三份报告）

| 报告 | 位置 | 关键结论 |
|---|---|---|
| 平台 UI 调研（LobeHub/LobeChat、OpenWebUI、Sora、可灵、Coze、Hermes、Codex） | `dsfolder/DSH-MULTIMEDIA-GEN-UI-RESEARCH.md` | 独立创作面板范式（提示词区+参数面板+生成按钮+画廊+历史）优于纯对话卡片；异步任务状态机 `queued→processing→succeeded|failed` 是视频/长任务通用骨架；TTS 范本=LobeChat（音色试听/语速/下载/缓存）；参数面板按 provider「能力+JSON Schema」动态渲染；LobeHub 插件市场=manifest(api+ui+gateway) |
| fal.ai + ElevenLabs 渠道调研 | `dsfolder/FAL-ELEVENLABS-CHANNEL-RESEARCH.md` | 统一适配器抽象 `SubmitJob→PollStatus→FetchResult` 同时映射 fal queue 与 EL flows；fal 响应=媒体 URL（签名、可配保留期），EL `content_url` 约 1h 过期 → **拿即转存本地**；鉴权头模板分 provider；fal TTS 代表模型 kokoro(prompt+voice)；EL 图片/视频已是异步 Flows（旧 /v1/images/generations 已下线） |
| Civitai + liblib.art 调研 | `dsfolder/CIVITAI-LIBLIB-RESEARCH.md`（子代理交付中） | 见 §6 待办 |

本插件已落实的映射：
- 三区页面：**生成 / 作品库 / 渠道**（模态 Tab + 参数面板 + 任务队列 + 画廊网格 + 灯箱预览/导出，对应报告 §8 推荐 IA 的精简落地）
- 统一 Job 模型（MediaJobStore）：id/渠道/模态/prompt/params/status/progress/error/outputs/meta，落盘 `jobs.json`
- 渠道抽象：`lib/adapters.mjs` 每渠道 `{ modalities, models, test, generate, resume }`；fal queue 与 EL flows 都实现为「提交→轮询→取结果→转存」
- 产物转存：统一下载到 `~/.dsh/multimedia/results/<jobId>/`，`/multimedia/file/:id/:idx` 本地流式提供（不把签名 URL 外泄给消费方）

## 2. 架构

```
web host (cordis row: multimedia)
├─ index.mjs        apply(): 配置解析、ChannelStore/JobStore、任务运行器、/multimedia API、工具注册
├─ lib/core.mjs     纯逻辑：配置归一化、渠道存储(runtime channels.json 覆盖 seed)、JobStore、
│                   collectUrls / extForMime / sizeLabel（零依赖，可单测）
├─ lib/adapters.mjs 渠道适配器：fal / elevenlabs / comfyui（fetch 可注入，冒烟测试覆盖）
└─ lib/tools.mjs    4 个 agent 工具定义（纯模块；preflight 用真实 dsh-tools 编译校验）

client (include:multimedia, conversation.view tab)
└─ src/client/      MultimediaTab.tsx（生成/作品库/渠道）+ multimedia.module.css（令牌白名单）
```

数据流：页面/工具 → host `generate` → 建 Job(queued) → 运行器 dispatch(并发≤2) →
adapter.generate（fal/EL：提交→轮询→取结果；EL TTS/同步）→ saveOutput 转存本地 →
Job(succeeded, outputs[localFile+fileUrl]) → 页面 2s 轮询 `/multimedia/tasks` 刷新。

## 3. 渠道模型

种子渠道在 bundle `cordis.patch.yml`；运行时增删改在页面「渠道」区 → `<dataDir>/channels.json`（0600）优先。

| 字段 | 说明 |
|---|---|
| id / type / label | type ∈ fal \| elevenlabs \| comfyui |
| enabled | 页面开关 |
| apiKeyEnv | 环境变量名（优先）；`apiKey` 字面量兜底（存 channels.json，绝不回传） |
| baseUrl | 可改（自建代理/镜像） |
| voice | elevenlabs 默认音色 |

能力矩阵（client 侧 CAPABILITY 与 adapters 对齐）：fal=image/video/tts；elevenlabs=tts/image；comfyui=image/video(工作流 JSON)。

## 4. HTTP API（同源 /multimedia）

channels: GET / PUT {id,patch} / POST / DELETE?id= / POST /test
models:   GET /models?channelId=&modality=          （模型/音色预设，EL 音色实时拉取）
jobs:     POST /generate · GET /tasks[?limit&modality&status&channelId] · GET /tasks/:id ·
          DELETE /tasks/:id · POST /cancel
files:    GET /file/:jobId/:idx（流式）· GET /export?jobId=&idx=&destPath=（复制到目录）

## 5. Agent 工具（新 defineTool API：execute + output.schema/render）

media_generate(channel?, modality, prompt, params?, model?, run_in_background?) — 默认同步等待(≤90s)，可后台
media_list / media_status / media_export(jobId, outputIndex?, destPath?)

## 6. 安全与边界

- API Key：env 优先；页面输入仅存 channels.json(0600)；客户端只见 hasKey/keyHint(末4位)
- 产物 URL 转存本地后才暴露 `fileUrl`；`localFile` 绝不进 publicJob
- comfyui 工作流 JSON 仅本机回环地址默认
- 下载限流：单文件 120s 超时；body ≤2MB
- 已知边界：fal/EL 的 webhook（签名校验）未接（轮询已够用）；provider 取消未实现（cancel 仅本地标记）
- v1.1 待办：Civitai/liblib 调研并入后做模型市场浏览/预设参数库；图生图/参考图（fal veo3 I2V、EL flows images[]）；成本展示（fal credits）；失败重试；工作流模板管理；导出到 IM 渠道（wechat/telegram bridge 有发送文件能力时）

## 7. 开发与发布纪律（防整树崩溃）

1. 改 host 代码后：`node --check` 全部 mjs → `node test/run.mjs` → `node test/preflight.mjs`（真实 dsh-tools 编译 4 工具）
2. 只允许在 profile 中启用前跑 `pnpm dsh --profile web --dump-config` 核对行
3. 模块顶层禁止：裸 throw、`||` 与 `??` 混用（需括号）、未声明 inject 的 ctx 服务使用
4. 工具参数 property-map：可选参数**不得写 required:false**；object 型必须显式 additionalProperties
5. 重启后会话恢复窗口（数分钟）内工具调度可能 aborted before dispatch——非故障，等待恢复
