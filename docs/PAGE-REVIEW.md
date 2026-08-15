# 多媒体插件页面实现复盘与优化清单（2026-08-15）

## 1. 当前实现地图

`src/client/MultimediaTab.tsx`（单文件 ~620 行）注册在 `conversation.view` tab「多媒体」：

- **三区结构**：生成 / 作品库 / 渠道（页头分段切换，CSS Module 令牌化，无 locale 层——conversation.view 页面先例如此）
- **生成区**：模态 Tab（图片/视频/语音）→ 渠道下拉（按 CAPABILITY 能力矩阵过滤）→ 模型下拉（host `/models` 实时拉取，EL 音色实时）→ 提示词 + 固定三套参数表单（image: 尺寸/数量/步数/CFG/Seed；video: 时长/比例/帧数/Seed；tts: 音色/稳定度/相似度/格式）→ 提交 → 进行中任务条（进度/取消，2s 轮询）
- **作品库**：`/multimedia/tasks?limit=60` 网格（缩略图=首产物），模态筛选，点击开灯箱（大图/视频/音频播放 + 下载/复制链接/复制提示词/重新生成/导出到目录/删除两段式确认）
- **渠道区**：卡片列表（开关/类型徽章/Key 状态/BaseURL/APIKey/音色或 AccountID/测试连接/保存/删除两段式）+ 新增渠道表单
- **host 侧**：`/multimedia/*` 15 个端点 + 4 个 agent 工具；jobs.json 快照、channels.json 运行时覆盖、并发 2 运行器、重启恢复轮询

## 2. 对照调研报告的差距（DSH-MULTIMEDIA-GEN-UI-RESEARCH.md）

| 调研建议（§8 IA / 12 条交互清单） | 现状 | 差距 |
|---|---|---|
| 参数面板按 provider「能力声明+JSON Schema」动态渲染 | 固定三套表单 | **P1**：recraft style/colors、kling cfg_scale/mode、veo3 generate_audio、pollinations enhance/safe/transparent、EL 的 seed/speed 等模型特有参数无法表达；ComfyUI 工作流裸 JSON 文本框体验差 |
| 生成按钮显示成本/额度 | 无 | **P1**：fal credits、EL credits 无展示（可先显示「已用任务数/最近任务耗时」） |
| 图生图/参考图（首帧/首尾帧/多图参考） | 不支持 | **P1**：fal veo3 I2V、EL flows images[]、pollinations kontext/gptimage `image` 参数；需要 host 侧暂存上传文件（client-only 做不了，需重启） |
| 负向提示词 | 无 | **P2**：仅对支持负向的模型/渠道显示 |
| TTS 音色卡片+试听（LobeChat 范本） | 下拉选择，生成后才能听 | **P2**：音色列表加试听按钮（EL 有 sample_url？或极短文本生成试听） |
| 任务失败 error.code+中文 message+重试按钮 | error 文本展示，无重试 | **P2**：失败任务一键「重试」（regen 已能带参重跑） |
| 视频 URL 过期转存 | 已转存本地（v0.1 就做了） | ✅ |
| 灯箱对比/并排 | 单图查看 | **P3**：多输出对比（fal num_images>1 时） |
| 作品库分页/搜索 | limit=60 截断，无搜索 | **P2** |
| 历史清理策略 | jobs.json 500 上限，磁盘无限堆积 | **P1**：作品库加「清理失败/30 天前」+ 磁盘占用统计 |

## 3. 实现质量发现

- ✅ 令牌白名单（23 个全为有效 --dsw-alias-*）、CSS Module、无 window.confirm（两段式确认）、Key 掩码回传、产物本地转存
- ⚠️ **轮询无门控**：所有 tab 每 2s 拉 60 条任务——应在「有进行中任务或作品库可见」时才轮询
- ⚠️ 单文件 620 行：GeneratePanel / GalleryPanel / ChannelsPanel / PreviewModal / JobStrip 应拆组件（可测性、可读性）
- ⚠️ 预览灯箱无 Esc 关闭、无 role=dialog/aria-modal（可访问性）
- ⚠️ 十几个 useState 平铺：表单状态可收敛为单对象/useReducer
- ⚠️ 内联 style 与 CSS Module 混用（宽度等布局值）——可收敛为 CSS 变量类
- ⚠️ 错误提示仅 toast/内联一行；网络失败无重试（host 下载无重试）
- ⚠️ 生成表单模态切换不清空 prompt（可接受，但「重新生成」填充后切模态会留旧值）
- ⚠️ i18n：页面中文硬编码（与 health-panel 一致，settings 卡片规范未延伸到这里）

## 4. 已实施快赢（本轮，client-only 无需重启）

- 轮询门控：仅当存在进行中任务或停留在作品库 tab 时轮询；提交/取消/删除后立即刷新一次
- 灯箱可访问性：Esc 关闭、`role="dialog" aria-modal="true"`

## 5. 分批路线

- **批次 A（client-only，随页面刷新生效）**：上述快赢 + 失败任务重试按钮 + 失败/空态文案 + 作品库磁盘统计
- **批次 B（host+client，一次重启）**：动态参数面板（模型能力声明下发）、图生图/参考图上传、真取消（fal cancel_url）、历史清理 API、并发可配
- **批次 C（后续）**：成本展示、音色试听、对比灯箱、i18n、组件拆分后补 client 单测
