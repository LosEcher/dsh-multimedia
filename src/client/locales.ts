/**
 * dsh-multimedia — locale bundle for the multimedia conversation tab.
 *
 * Dictionary namespace `multimedia`, declared into LocaleNamespaceMap so the
 * slot renderer synthesizes the typed `t` seat (PropsLocale) for the tab.
 * All UI copy lives here — the component never hardcodes strings.
 */

/** Locale keys this tab renders. */
export type MultimediaKey =
  // tab
  | 'tabTitle'
  // tabs
  | 'tabGenerate' | 'tabGallery' | 'tabChannels'
  // modality
  | 'modalityImage' | 'modalityVideo' | 'modalityTts'
  // status
  | 'statusQueued' | 'statusRunning' | 'statusSucceeded' | 'statusFailed' | 'statusCancelled' | 'statusCancelling'
  // image sizes
  | 'sizeSquareHd' | 'sizeSquare' | 'sizePortrait43' | 'sizeLandscape43'
  | 'sizeEleven1024' | 'sizeEleven768x1024' | 'sizeEleven1024x768'
  // generate form
  | 'labelModality' | 'labelChannel' | 'labelModel' | 'noApiKey'
  | 'labelPrompt' | 'promptPlaceholderTts' | 'promptPlaceholderImage'
  | 'labelWorkflow' | 'workflowPlaceholder'
  | 'labelSize' | 'labelCount' | 'labelSteps' | 'placeholderDefault' | 'labelCfg' | 'labelSeed' | 'placeholderRandom'
  | 'labelDuration' | 'labelRatio' | 'labelFrames'
  | 'labelVoice' | 'voiceDefault' | 'labelStability' | 'labelSimilarity' | 'labelFormat'
  | 'submitting' | 'generateImage' | 'generateVideo' | 'generateSpeech'
  | 'noChannelHint' | 'activeJobsTitle' | 'cancelJob'
  // toasts
  | 'submitted' | 'copied' | 'copyFailed' | 'needExportPath' | 'exported' | 'exportFailed'
  | 'noChanges' | 'channelSaved' | 'saveFailed' | 'testing' | 'testOk' | 'testFailed'
  | 'channelAdded' | 'addFailed'
  // gallery
  | 'filterAll' | 'galleryEmpty' | 'resultAlt' | 'thumbAlt'
  // channels
  | 'channelsTitle' | 'keyConfigured' | 'keyEnv' | 'keyMasked' | 'testConnection' | 'delete' | 'save'
  | 'labelBaseUrl' | 'labelApiKey' | 'keyUnchanged' | 'apiKeyPlaceholder'
  | 'labelDefaultVoice' | 'voiceIdPlaceholder' | 'labelAccountId' | 'accountIdPlaceholder'
  | 'addChannelTitle' | 'channelIdPlaceholder' | 'displayNamePlaceholder' | 'add'
  // preview
  | 'previewAria' | 'close' | 'download' | 'copyLink' | 'copyPrompt' | 'regen' | 'exportTo' | 'export'
  | 'exportPathPlaceholder' | 'outputSummary' | 'linkCopy' | 'promptCopy' | 'usageLine'
  // confirmation modal
  | 'deleteChannelTitle' | 'deleteChannelBody' | 'deleteJobTitle' | 'deleteJobBody'
  | 'cancelJobTitle' | 'cancelJobBody' | 'modalCancel' | 'modalConfirmDelete' | 'modalConfirmCancel'
  // shared bits
  | 'unitSeconds' | 'unitPercent' | 'metaSep' | 'channelOption' | 'jobMeta'

/** English copy. */
export const en: Record<MultimediaKey, string> = {
  tabTitle: 'Multimedia',

  tabGenerate: 'Generate',
  tabGallery: 'Gallery',
  tabChannels: 'Channels',

  modalityImage: 'Image',
  modalityVideo: 'Video',
  modalityTts: 'Speech',

  statusQueued: 'Queued',
  statusRunning: 'Generating',
  statusSucceeded: 'Done',
  statusFailed: 'Failed',
  statusCancelled: 'Cancelled',
  statusCancelling: 'Cancelling',

  sizeSquareHd: 'Square 1024×1024',
  sizeSquare: 'Square 512×512',
  sizePortrait43: 'Portrait 4:3',
  sizeLandscape43: 'Landscape 4:3',
  sizeEleven1024: 'ElevenLabs 1024×1024',
  sizeEleven768x1024: 'ElevenLabs 768×1024',
  sizeEleven1024x768: 'ElevenLabs 1024×768',

  labelModality: 'Modality',
  labelChannel: 'Channel',
  labelModel: 'Model',
  noApiKey: 'No API key',
  labelPrompt: 'Prompt',
  promptPlaceholderTts: 'Enter the text to read aloud…',
  promptPlaceholderImage: 'Describe the image you want…',
  labelWorkflow: 'Workflow',
  workflowPlaceholder: 'ComfyUI workflow JSON ({"3":{"inputs":{...}},…})',
  labelSize: 'Size',
  labelCount: 'Count',
  labelSteps: 'Steps',
  placeholderDefault: 'default',
  labelCfg: 'CFG',
  labelSeed: 'Seed',
  placeholderRandom: 'random',
  labelDuration: 'Duration',
  labelRatio: 'Ratio',
  labelFrames: 'Frames',
  labelVoice: 'Voice',
  voiceDefault: 'Channel default',
  labelStability: 'Stability',
  labelSimilarity: 'Similarity',
  labelFormat: 'Format',
  submitting: 'Submitting…',
  generateImage: 'Generate image',
  generateVideo: 'Generate video',
  generateSpeech: 'Generate speech',
  noChannelHint: 'No enabled channel supports this modality — enable one in Channels.',
  activeJobsTitle: 'In progress',
  cancelJob: 'Cancel',

  submitted: 'Submitted: {channel} · {modality}',
  copied: '{label} copied',
  copyFailed: 'Copy failed',
  needExportPath: 'Enter a target directory first',
  exported: 'Exported: {path}',
  exportFailed: 'Export failed: {error}',
  noChanges: 'No changes to save',
  channelSaved: 'Channel saved',
  saveFailed: 'Save failed: {error}',
  testing: 'Testing…',
  testOk: '✅ {message}',
  testFailed: '❌ {error}',
  channelAdded: 'Channel added',
  addFailed: 'Add failed: {error}',

  filterAll: 'All',
  galleryEmpty: 'No works yet — try the Generate tab.',
  resultAlt: 'Generated result',
  thumbAlt: 'Result thumbnail',

  channelsTitle: 'Channel settings',
  keyConfigured: 'Configured',
  keyEnv: ' (env {env})',
  keyMasked: ' ****{hint}',
  testConnection: 'Test connection',
  delete: 'Delete',
  save: 'Save',
  labelBaseUrl: 'Base URL',
  labelApiKey: 'API Key',
  keyUnchanged: 'Leave blank to keep',
  apiKeyPlaceholder: 'Enter API key',
  labelDefaultVoice: 'Default voice',
  voiceIdPlaceholder: 'voice_id',
  labelAccountId: 'Account ID',
  accountIdPlaceholder: 'Cloudflare account ID',
  addChannelTitle: 'Add channel',
  channelIdPlaceholder: 'id (e.g. my-fal)',
  displayNamePlaceholder: 'Display name',
  add: 'Add',

  previewAria: 'Output preview',
  close: 'Close',
  download: 'Download [{idx}]',
  copyLink: 'Copy link',
  copyPrompt: 'Copy prompt',
  regen: 'Regenerate',
  exportTo: 'Export to',
  export: 'Export',
  exportPathPlaceholder: '/absolute/path/dir',
  outputSummary: 'Output[{idx}] {kind} {size}{seed}',
  usageLine: 'Usage: {text}',
  linkCopy: 'link',
  promptCopy: 'prompt',

  deleteChannelTitle: 'Delete channel',
  deleteChannelBody: 'Delete channel {label}? This removes its configuration.',
  deleteJobTitle: 'Delete output',
  deleteJobBody: 'Delete job {id} and its output files? This cannot be undone.',
  cancelJobTitle: 'Cancel job',
  cancelJobBody: 'Cancel job {id}?',
  modalCancel: 'Cancel',
  modalConfirmDelete: 'Delete',
  modalConfirmCancel: 'Cancel job',

  unitSeconds: '{n}s',
  unitPercent: '{n}%',
  metaSep: ' · ',
  channelOption: '{label} ({type})',
  jobMeta: '{id} · {channel} · {desc}',
}

/** Simplified Chinese copy (the original UI text). */
export const zh: Record<MultimediaKey, string> = {
  tabTitle: '多媒体',

  tabGenerate: '生成',
  tabGallery: '作品库',
  tabChannels: '渠道',

  modalityImage: '图片',
  modalityVideo: '视频',
  modalityTts: '语音',

  statusQueued: '排队中',
  statusRunning: '生成中',
  statusSucceeded: '已完成',
  statusFailed: '失败',
  statusCancelled: '已取消',
  statusCancelling: '取消中',

  sizeSquareHd: '方形 1024×1024',
  sizeSquare: '方形 512×512',
  sizePortrait43: '竖版 4:3',
  sizeLandscape43: '横版 4:3',
  sizeEleven1024: 'ElevenLabs 1024×1024',
  sizeEleven768x1024: 'ElevenLabs 768×1024',
  sizeEleven1024x768: 'ElevenLabs 1024×768',

  labelModality: '模态',
  labelChannel: '渠道',
  labelModel: '模型',
  noApiKey: '未配置 API Key',
  labelPrompt: '提示词',
  promptPlaceholderTts: '输入要朗读的文本…',
  promptPlaceholderImage: '描述你想生成的画面…',
  labelWorkflow: '工作流',
  workflowPlaceholder: 'ComfyUI 工作流 JSON（{"3":{"inputs":{...}},…}）',
  labelSize: '尺寸',
  labelCount: '数量',
  labelSteps: '步数',
  placeholderDefault: '默认',
  labelCfg: 'CFG',
  labelSeed: 'Seed',
  placeholderRandom: '随机',
  labelDuration: '时长',
  labelRatio: '比例',
  labelFrames: '帧数',
  labelVoice: '音色',
  voiceDefault: '渠道默认',
  labelStability: '稳定度',
  labelSimilarity: '相似度',
  labelFormat: '格式',
  submitting: '提交中…',
  generateImage: '生成图片',
  generateVideo: '生成视频',
  generateSpeech: '生成语音',
  noChannelHint: '当前模态下没有已启用的渠道，请到「渠道」开启并配置',
  activeJobsTitle: '进行中',
  cancelJob: '取消',

  submitted: '已提交：{channel} · {modality}',
  copied: '{label}已复制',
  copyFailed: '复制失败',
  needExportPath: '请先填写目标目录',
  exported: '已导出：{path}',
  exportFailed: '导出失败：{error}',
  noChanges: '没有需要保存的改动',
  channelSaved: '渠道已保存',
  saveFailed: '保存失败：{error}',
  testing: '测试中…',
  testOk: '✅ {message}',
  testFailed: '❌ {error}',
  channelAdded: '渠道已添加',
  addFailed: '添加失败：{error}',

  filterAll: '全部',
  galleryEmpty: '还没有作品，去「生成」页试试',
  resultAlt: '生成结果',
  thumbAlt: '结果缩略图',

  channelsTitle: '渠道设置',
  keyConfigured: '已配置',
  keyEnv: '（env {env}）',
  keyMasked: ' ****{hint}',
  testConnection: '测试连接',
  delete: '删除',
  save: '保存',
  labelBaseUrl: 'Base URL',
  labelApiKey: 'API Key',
  keyUnchanged: '留空不改',
  apiKeyPlaceholder: '输入 API Key',
  labelDefaultVoice: '默认音色',
  voiceIdPlaceholder: 'voice_id',
  labelAccountId: 'Account ID',
  accountIdPlaceholder: 'Cloudflare 账户 ID',
  addChannelTitle: '新增渠道',
  channelIdPlaceholder: 'id（如 my-fal）',
  displayNamePlaceholder: '显示名',
  add: '添加',

  previewAria: '产物预览',
  close: '关闭',
  download: '下载[{idx}]',
  copyLink: '复制链接',
  copyPrompt: '复制提示词',
  regen: '重新生成',
  exportTo: '导出到',
  export: '导出',
  exportPathPlaceholder: '/绝对/路径/目录',
  outputSummary: '产物[{idx}] {kind} {size}{seed}',
  usageLine: '用量：{text}',
  linkCopy: '链接',
  promptCopy: '提示词',

  deleteChannelTitle: '删除渠道',
  deleteChannelBody: '确定删除渠道 {label}？该操作会移除渠道配置。',
  deleteJobTitle: '删除作品',
  deleteJobBody: '确定删除任务 {id} 及其产物文件？该操作不可恢复。',
  cancelJobTitle: '取消任务',
  cancelJobBody: '确定取消任务 {id}？',
  modalCancel: '取消',
  modalConfirmDelete: '删除',
  modalConfirmCancel: '取消任务',

  unitSeconds: '{n}s',
  unitPercent: '{n}%',
  metaSep: ' · ',
  channelOption: '{label}（{type}）',
  jobMeta: '{id} · {channel} · {desc}',
}

/** The dictionary namespace this tab owns (registered via ctx.locale). */
export const NS = 'multimedia'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This conversation tab's copy. */
    'multimedia': MultimediaKey
  }
}
