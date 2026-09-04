import { useState, useEffect, useRef, useCallback, type ReactNode, type CSSProperties } from 'react'
import {
  BLOCK_ORDER, BLOCK_LABELS,
  CHAR_REF_MODES, charRefMode,
  type NaiBatchItem, type NaiPromptBlock, type NaiBlockVariant,
  type NaiCharacterPrompt, type NaiParams,
  type NaiQueueJob,
  type Character, type CharRefMode,
  type CharLayer, type ReplRule, type AugRole, type AugExtraBlock,
  type ViewVariantTexts, type ViewKey, VIEW_KEYS,
} from '../../types'
import type { useNaiBatch, DefaultBaseBlock } from '../../hooks/useNaiBatch'
import { buildCharactersPayload, getVariantAtIndex, isItemInBatchMode, batchVariantDistribution } from '../../hooks/useNaiBatch'
import CharacterPickerDialog from './CharacterPickerDialog'
import AutoGrowTextarea from '../common/AutoGrowTextarea'
import { encodeCharReferenceImage } from '../../lib/charReference'

interface Props {
  batch: ReturnType<typeof useNaiBatch>
  characters: Character[]
}

type SizePreset = { label: string; width: number; height: number; builtin?: boolean }

// 3 个内置 preset，不可删
const BUILTIN_PRESETS: SizePreset[] = [
  { label: '竖图（832×1216）', width: 832, height: 1216, builtin: true },
  { label: '横图（1216×832）', width: 1216, height: 832, builtin: true },
  { label: '方图（1024×1024）', width: 1024, height: 1024, builtin: true },
]

type NaiConfigPublic = {
  configured: boolean
  default_params?: Partial<NaiParams>
  batch?: {
    interval_seconds?: number
    interval_jitter_min?: number
    interval_jitter_max?: number
    retry_on_429_enabled?: boolean
    retry_on_429_delay_sec?: number
    max_retries?: number
    batch_count?: number
    number_of_requests?: number
  }
  size_presets?: SizePreset[]
  default_base_blocks?: DefaultBaseBlock[] | Record<string, string>
  output_folder?: string
}

// ── UI 状态持久化 keys ──
const LS_SHOW_DEFAULTS = 'owner-nai:show-defaults'
const LS_SHOW_BATCH = 'owner-nai:show-batch'
const LS_ITEM_TABS = 'owner-nai:item-tabs'
type NaiDriveMode = 'auto' | 'manual'

function readBool(key: string, fallback = false): boolean {
  try {
    const v = localStorage.getItem(key)
    if (v === null) return fallback
    return v === 'true'
  } catch { return fallback }
}
function writeBool(key: string, v: boolean) {
  try { localStorage.setItem(key, String(v)) } catch { /* ignore */ }
}
function readItemTabs(): Record<string, 'base' | 'characters' | 'params' | 'charref' | null> {
  try {
    const raw = localStorage.getItem(LS_ITEM_TABS)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed
  } catch { /* ignore */ }
  return {}
}
function writeItemTabs(map: Record<string, 'base' | 'characters' | 'params' | 'charref' | null>) {
  try { localStorage.setItem(LS_ITEM_TABS, JSON.stringify(map)) } catch { /* ignore */ }
}

// 常量：UI 下拉用
// 与 tools/job_emitter.ALLOWED_MODELS 对齐（改一处须同步另一处，见 linkage_map §六·五）
const MODEL_CHOICES = [
  'nai-diffusion-5-full',
  'nai-diffusion-5-curated',
  'nai-diffusion-4-5-full',
  'nai-diffusion-4-5-curated',
  'nai-diffusion-4-full',
  'nai-diffusion-4-curated-preview',
  'nai-diffusion-3',
]
const SAMPLER_CHOICES = [
  'k_euler', 'k_euler_ancestral', 'k_dpmpp_2s_ancestral',
  'k_dpmpp_2m_sde', 'k_dpmpp_sde', 'k_dpmpp_2m',
]
const NOISE_SCHEDULE_CHOICES = ['native', 'karras', 'exponential', 'polyexponential']

// 队列作业 id
function jid(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

// 自动伸高的 textarea：根据内容（含空行）自动调整高度，不再固定 2 行。
// 仍保留 resize: vertical，用户可手动再拉伸。
export default function NaiBatchPanel({ batch, characters }: Props) {
  const [config, setConfig] = useState<NaiConfigPublic | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [runProgress, setRunProgress] = useState({ done: 0, total: 0, currentItem: '' })
  const [generatedImages, setGeneratedImages] = useState<string[]>([])
  const [errorLog, setErrorLog] = useState('')
  const stopRequestRef = useRef(false)
  // ── 执行队列（多预设串行）──
  // jobs：每个作业 = 一个预设跑 N 张到独立子文件夹。运行中可继续入队（同预设再来一批 /
  // 切到别的预设入队），当前作业跑完自动接下一个。停止 = 当前作业转 paused（已出图保留），
  // 下次 ▶ 从 paused 续跑后继续后续队列。jobsRef 为权威源，jobs state 仅用于渲染。
  const [jobs, setJobs] = useState<NaiQueueJob[]>([])
  const jobsRef = useRef<NaiQueueJob[]>([])
  const isRunningRef = useRef(false)
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [showLoadDialog, setShowLoadDialog] = useState(false)

  // planRef：让 runLoop/runJob 闭包里能读最新 plan
  const planRef = useRef(batch.plan)
  useEffect(() => { planRef.current = batch.plan }, [batch.plan])
  // activeItemIdRef：让 runLoop/runJob 闭包里能读最新 active id
  const activeItemIdRef = useRef<string | null>(null)

  // 持久化 UI 状态
  const [driveMode, setDriveMode] = useState<NaiDriveMode>('manual')
  // 自动档内的子 tab：加装层(preset) / 角色加装层(charlayer)，同级切换
  const [augTab] = useState<'preset' | 'charlayer'>(() => {
    try { return (localStorage.getItem('owner-nai:aug-tab') as 'preset' | 'charlayer') || 'preset' } catch { return 'preset' }
  })
  const [showDefaults, setShowDefaultsState] = useState(() => readBool(LS_SHOW_DEFAULTS, false))
  const [showDefaultBlocks, setShowDefaultBlocksState] = useState(() => readBool('owner-nai:show-default-blocks', false))
  const [showBatchSettings, setShowBatchSettingsState] = useState(() => readBool(LS_SHOW_BATCH, false))
  // 当前选中编辑的任务 id（tag 式切换）
  const [activeItemId, setActiveItemIdState] = useState<string | null>(() => {
    try { return localStorage.getItem('owner-nai:active-item') } catch { return null }
  })
  const setActiveItemId = (id: string | null) => {
    setActiveItemIdState(id)
    activeItemIdRef.current = id
    try {
      if (id) localStorage.setItem('owner-nai:active-item', id)
      else localStorage.removeItem('owner-nai:active-item')
    } catch { /* ignore */ }
  }
  // 同步初始值到 ref
  useEffect(() => { activeItemIdRef.current = activeItemId }, [activeItemId])
  const setShowDefaults = (v: boolean | ((p: boolean) => boolean)) => {
    setShowDefaultsState(prev => {
      const next = typeof v === 'function' ? v(prev) : v
      writeBool(LS_SHOW_DEFAULTS, next)
      return next
    })
  }
  const setShowDefaultBlocks = (v: boolean | ((p: boolean) => boolean)) => {
    setShowDefaultBlocksState(prev => {
      const next = typeof v === 'function' ? v(prev) : v
      writeBool('owner-nai:show-default-blocks', next)
      return next
    })
  }
  const setShowBatchSettings = (v: boolean | ((p: boolean) => boolean)) => {
    setShowBatchSettingsState(prev => {
      const next = typeof v === 'function' ? v(prev) : v
      writeBool(LS_SHOW_BATCH, next)
      return next
    })
  }

  // 加载 NAI public 配置（不含 api_key）
  const refreshConfig = useCallback(async () => {
    try {
      const resp = await fetch('/api/nai/config')
      const data = await resp.json()
      setConfig(data)
    } catch {
      setConfig({ configured: false })
    }
  }, [])

  useEffect(() => { refreshConfig() }, [refreshConfig])

  // 把默认提示词注入到 hook 的 ref（新建任务时会用）
  useEffect(() => {
    if (config?.default_base_blocks) {
      batch.setDefaultBaseBlocks(config.default_base_blocks)
    }
  }, [config?.default_base_blocks, batch])

  // ── 乐观更新 + debounce 自动保存 ──
  // 改一下立即生效（runJob 用到的就是这个 config state），同时 500ms 后写入 nai_config.json
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingChangesRef = useRef<{
    default_params?: Partial<NaiParams>
    batch?: NaiConfigPublic['batch']
    size_presets?: SizePreset[]
    default_base_blocks?: DefaultBaseBlock[]
  }>({})

  const flushPending = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
    const body = pendingChangesRef.current
    if (Object.keys(body).length === 0) return
    pendingChangesRef.current = {}
    fetch('/api/nai/defaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => { /* 静默失败，下次再试 */ })
  }, [])

  const scheduleSave = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    debounceTimerRef.current = setTimeout(flushPending, 500)
  }, [flushPending])

  // 卸载时立即保存
  useEffect(() => () => { flushPending() }, [flushPending])

  // 立即更新 config 本地状态 + 累积到待发送 patch
  const patchDefaultParam = useCallback(<K extends keyof NaiParams>(k: K, v: NaiParams[K] | undefined) => {
    setConfig(c => {
      if (!c) return c
      const next = { ...c, default_params: { ...c.default_params, [k]: v } }
      return next
    })
    pendingChangesRef.current.default_params = {
      ...(pendingChangesRef.current.default_params || {}),
      [k]: v,
    }
    scheduleSave()
  }, [scheduleSave])

  const patchBatch = useCallback((k: keyof NonNullable<NaiConfigPublic['batch']>, v: unknown) => {
    setConfig(c => {
      if (!c) return c
      const next = { ...c, batch: { ...(c.batch || {}), [k]: v } }
      return next
    })
    pendingChangesRef.current.batch = {
      ...(pendingChangesRef.current.batch || {}),
      [k]: v,
    }
    scheduleSave()
  }, [scheduleSave])

  const setSizePresets = useCallback((presets: SizePreset[]) => {
    // 只保存非 builtin 的（builtin 在前端固定）
    const userOnly = presets.filter(p => !p.builtin)
    setConfig(c => c ? { ...c, size_presets: userOnly } : c)
    pendingChangesRef.current.size_presets = userOnly
    scheduleSave()
  }, [scheduleSave])

  // 整体替换默认 base blocks 数组
  const patchDefaultBaseBlocks = useCallback((next: DefaultBaseBlock[]) => {
    setConfig(c => c ? { ...c, default_base_blocks: next } : c)
    pendingChangesRef.current.default_base_blocks = next
    scheduleSave()
  }, [scheduleSave])

  // ── 执行队列（多预设串行）──
  // 关键设计：
  //   1. prompt 实时生效：每张图提交前从 planRef 重新读 item 的当前 baseBlocks/characters/paramsOverride
  //      → 用户改 prompt 不用停跑，下一张提交时就生效
  //   2. 停止无延迟：stopRequestRef 在循环开头 + 间隔 sleep 内每 100ms 检查
  //      → 正在出的那张图出完即停，不再等满一个间隔
  //   3. 多预设队列：jobs 是执行队列，runLoop 串行处理。运行中可继续 enqueue，
  //      当前作业跑完自动接下一个。停止 → 当前作业转 paused，下次 ▶ 续跑后继续后续队列。

  // 子文件夹名（作业首次开始时分配，时间戳）
  const makeSubfolder = (comment: string) => {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const clean = comment.replace(/[^a-zA-Z0-9_一-龥]/g, '_').slice(0, 30)
    return `${clean}_${stamp}`
  }

  // jobsRef 为权威源，setJobs 仅镜像渲染
  const patchJob = useCallback((id: string, patch: Partial<NaiQueueJob>) => {
    jobsRef.current = jobsRef.current.map(j => j.id === id ? { ...j, ...patch } : j)
    setJobs(jobsRef.current)
  }, [])

  const enqueueJob = useCallback((itemId: string, target: number): string | null => {
    const item = planRef.current.items.find(i => i.id === itemId)
    if (!item || target <= 0) return null
    const job: NaiQueueJob = {
      id: jid(), itemId, comment: item.comment, target,
      produced: 0, subfolder: null, images: [], status: 'queued',
    }
    jobsRef.current = [...jobsRef.current, job]
    setJobs(jobsRef.current)
    return job.id
  }, [])

  const removeJob = useCallback((id: string) => {
    const j = jobsRef.current.find(x => x.id === id)
    if (j && j.status === 'running') return  // 运行中不可删
    jobsRef.current = jobsRef.current.filter(x => x.id !== id)
    setJobs(jobsRef.current)
  }, [])

  // 清除已完成/出错的作业
  const clearFinishedJobs = useCallback(() => {
    jobsRef.current = jobsRef.current.filter(j => j.status === 'running' || j.status === 'queued' || j.status === 'paused')
    setJobs(jobsRef.current)
  }, [])

  // 清空队列里所有未运行的作业（正在跑的不动）
  const clearQueue = useCallback(() => {
    if (jobsRef.current.some(j => j.status !== 'running') &&
        !confirm('清空队列里所有未运行的作业？正在跑的不受影响，已生成的图片不会删除。')) return
    jobsRef.current = jobsRef.current.filter(j => j.status === 'running')
    setJobs(jobsRef.current)
  }, [])

  // 跑单个作业到 target（可被 stopRequestRef 中断 → 转 paused）
  const runJob = useCallback(async (jobId: string) => {
    const startJob = jobsRef.current.find(j => j.id === jobId)
    if (!startJob) return
    const itemId = startJob.itemId
    const target = startJob.target

    const batchCfg = config?.batch || {}
    const batchSize = Math.max(1, batchCfg.batch_count ?? 1)
    const intervalSec = batchCfg.interval_seconds ?? 1
    const jitterMin = batchCfg.interval_jitter_min ?? 0
    const jitterMax = batchCfg.interval_jitter_max ?? 0

    const subfolder = startJob.subfolder || makeSubfolder(startJob.comment)
    let totalDone = startJob.produced
    const localImages = [...startJob.images]
    let inCurrentBatch = 0

    patchJob(jobId, { status: 'running', subfolder })
    batch.updateItem(itemId, { status: 'running', generatedCount: totalDone, generatedImages: [...localImages], errorMessage: undefined })
    // 必须传副本：localImages 之后会被 push 原地修改，若直接把它设进 state，
    // 下面 setGeneratedImages(prev => ...) 的 prev 会读到已 push 的同一引用 → 首图重复
    setGeneratedImages([...localImages])
    setRunProgress({ done: totalDone, total: target, currentItem: startJob.comment })

    // 可中断间隔 sleep（每 100ms 检查停止 → 停止无延迟）
    const sleepBatch = async () => {
      let sec = intervalSec
      if (jitterMax > jitterMin) sec += Math.random() * (jitterMax - jitterMin) + jitterMin
      if (sec <= 0) return
      const steps = Math.ceil((sec * 1000) / 100)
      for (let i = 0; i < steps; i++) {
        if (stopRequestRef.current) return
        await new Promise(r => setTimeout(r, 100))
      }
    }

    while (totalDone < target) {
      if (stopRequestRef.current) break

      // 实时读取 item 当前 state（让用户中途的 prompt 编辑下一张就生效）
      const itemNow = planRef.current.items.find(i => i.id === itemId)
      if (!itemNow) {
        // 预设被删 → 作业作废
        patchJob(jobId, { status: 'error', produced: totalDone, images: [...localImages], errorMessage: '预设已被删除' })
        return
      }

      const run = getVariantAtIndex(itemNow, totalDone)
      const charactersPayload = buildCharactersPayload(itemNow.characters)
      const prefix = run.variantLabel
        ? run.variantLabel.replace(/[^a-zA-Z0-9_一-龥]/g, '_').slice(0, 20)
        : ''

      try {
        const payload: Record<string, unknown> = {
          positive: run.positive,
          characters: charactersPayload,
          params: itemNow.paramsOverride,
          count: 1,
          prefix,
          subfolder,
          char_reference: itemNow.charReference?.image_b64
            ? {
                image_b64: itemNow.charReference.image_b64,
                strength: itemNow.charReference.strength,
                fidelity: itemNow.charReference.fidelity,
                base_caption: charRefMode(itemNow.charReference),
              }
            : undefined,
          augment: itemNow.augment || undefined,   // 过固定加装层(activeId)：服务端走 submit_nai.py --augment
          char_layer_assign: (itemNow.charLayerAssign && Object.keys(itemNow.charLayerAssign).length)
            ? itemNow.charLayerAssign : undefined,  // 角色加装层指派：服务端走 submit_nai.py --char-layers
          char_layer_views: (itemNow.charLayerAssign && Object.keys(itemNow.charLayerAssign).length)
            ? Object.fromEntries(Object.keys(itemNow.charLayerAssign).map(s => [s, itemNow.characters[Number(s)]?.view || 'front_full']))
            : undefined,                            // 每个被指派槽的 view → 按视角选 persona 变体
        }
        const resp = await fetch('/api/nai/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const result = await resp.json()
        if (result.ok && (result.queued || result.images?.length > 0)) {
          // 新契约：202 只代表终端已接单，不在 webapp 里等图；图和状态由终端统一管理。
          if (result.images?.length > 0) {
            localImages.push(...result.images)
            setGeneratedImages(prev => [...prev, ...result.images])
          }
          inCurrentBatch++
          totalDone++
          patchJob(jobId, { produced: totalDone, images: [...localImages] })
          batch.updateItem(itemId, { generatedCount: totalDone, generatedImages: [...localImages] })
          setRunProgress(p => ({
            ...p,
            done: totalDone, total: target,
            currentItem: run.variantLabel
              ? `${itemNow.comment} · ${run.variantLabel}`
              : itemNow.comment,
          }))

          // 批次间隔：跑满 batch_count 张才 sleep（最后一张不 sleep）
          if (inCurrentBatch >= batchSize && totalDone < target) {
            await sleepBatch()
            inCurrentBatch = 0
          }
        } else {
          const tag = run.variantLabel ? `${itemNow.comment}·${run.variantLabel}` : itemNow.comment
          const errorMsg = result.stderr || result.error || '未知错误'
          setErrorLog(prev => prev + `\n[${tag} #${totalDone + 1}] ${errorMsg}`)
          patchJob(jobId, { status: 'error', produced: totalDone, images: [...localImages], errorMessage: errorMsg })
          batch.updateItem(itemId, { status: 'error', generatedCount: totalDone, generatedImages: [...localImages], errorMessage: errorMsg })
          return
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const tag = run.variantLabel ? `${itemNow.comment}·${run.variantLabel}` : itemNow.comment
        setErrorLog(prev => prev + `\n[${tag} #${totalDone + 1}] ${msg}`)
        patchJob(jobId, { status: 'error', produced: totalDone, images: [...localImages], errorMessage: msg })
        batch.updateItem(itemId, { status: 'error', generatedCount: totalDone, generatedImages: [...localImages], errorMessage: msg })
        return
      }
    }

    if (totalDone >= target) {
      patchJob(jobId, { status: 'done', produced: totalDone, images: [...localImages] })
      batch.updateItem(itemId, { status: 'done', generatedCount: totalDone, generatedImages: [...localImages] })
    } else {
      // 被停止 → 转 paused（下次 ▶ 续跑）
      patchJob(jobId, { status: 'paused', produced: totalDone, images: [...localImages] })
      batch.updateItem(itemId, { status: 'pending', generatedCount: totalDone, generatedImages: [...localImages] })
    }
  }, [batch, config, patchJob])

  // 串行处理队列。队列空时自动把当前 active 预设按 cap 入队（保留一键跑体验）。
  const runLoop = useCallback(async () => {
    if (isRunningRef.current) return
    const isRunnable = (j: NaiQueueJob) => (j.status === 'queued' || j.status === 'paused') && j.produced < j.target
    if (!jobsRef.current.some(isRunnable)) {
      const activeId = activeItemIdRef.current || planRef.current.items[0]?.id
      const cap = config?.batch?.number_of_requests ?? 0
      if (!activeId || cap <= 0) return
      enqueueJob(activeId, cap)
    }
    isRunningRef.current = true
    setIsRunning(true)
    stopRequestRef.current = false
    setErrorLog('')
    while (true) {
      if (stopRequestRef.current) break
      const next = jobsRef.current.find(isRunnable)
      if (!next) break
      await runJob(next.id)
      if (stopRequestRef.current) break
    }
    isRunningRef.current = false
    setIsRunning(false)
    setRunProgress(p => ({ ...p, currentItem: '' }))
  }, [config, enqueueJob, runJob])

  const stopQueue = useCallback(() => { stopRequestRef.current = true }, [])

  // 把当前 active 预设按 cap 排进队列末尾（运行中也可用 → 实现"追加"）
  const handleEnqueueActive = useCallback(() => {
    const activeId = activeItemIdRef.current || planRef.current.items[0]?.id
    const cap = config?.batch?.number_of_requests ?? 0
    if (!activeId || cap <= 0) return
    enqueueJob(activeId, cap)
  }, [config, enqueueJob])

  if (!config) {
    return <div className="nai-batch-panel"><div style={{ padding: 20 }}>加载 NAI 配置中...</div></div>
  }
  if (!config.configured) {
    return (
      <div className="nai-batch-panel">
        <div className="nai-batch-empty">
          <h3>NAI API 未配置</h3>
          <p>请先编辑 <code>data/nai_config.json</code>，填入 API Token 和默认参数。</p>
        </div>
      </div>
    )
  }

  const { plan, itemCount } = batch
  // active 任务（顶部选中的 tab）
  const activeItem = plan.items.find(i => i.id === activeItemId) || plan.items[0]
  // 单次入队的目标张数 = cap（批量与非批量统一）
  const cap = config.batch?.number_of_requests ?? 0
  const activeBatchMode = activeItem ? isItemInBatchMode(activeItem) : false
  const targetCount = cap
  // 批量模式：按 target 在变体间 round-robin 平摊
  const variantDist = activeItem && activeBatchMode
    ? batchVariantDistribution(activeItem, targetCount)
    : []
  const defaultParams = config.default_params || {}
  const batchSettings = config.batch || {}
  // ── 队列派生 ──
  const pendingCount = jobs.filter(j => (j.status === 'queued' || j.status === 'paused') && j.produced < j.target).length
  const queueTotalRemaining = jobs
    .filter(j => j.status !== 'done' && j.status !== 'error')
    .reduce((s, j) => s + Math.max(0, j.target - j.produced), 0)

  return (
    <div className="nai-batch-panel">
      {/* 顶栏 */}
      <div className="nai-batch-toolbar">
        <div className="nai-batch-toolbar-left">
          <h3 className="nai-batch-title">NAI 出图</h3>
          <span className="nai-batch-stats">
            {driveMode === 'auto'
              ? '加装层已迁移到桌面终端'
              : `${itemCount} 个预设档${activeItem ? ` · 当前: ${activeItem.comment} · 单次入队 ${targetCount} 张` : ''}${pendingCount > 0 ? ` · 队列待跑 ${queueTotalRemaining} 张` : ''}`}
            {driveMode === 'manual' && activeBatchMode && variantDist.length > 0 && (
              ` · 批量: ${variantDist.map(d => `${d.label}×${d.count}`).join(' / ')}`
            )}
          </span>
        </div>
        <div className="nai-batch-toolbar-right">
          <button className={`nai-drive-tab ${driveMode === 'auto' ? 'active' : ''}`}
            onClick={() => setDriveMode('auto')}
            title="网页编辑已退役，请使用 NAI 出图终端桌面 App">
            加装层（已迁移）
          </button>
          <button className={`nai-drive-tab ${driveMode === 'manual' ? 'active' : ''}`}
            onClick={() => setDriveMode('manual')}
            title="手动网页队列用：编辑 prompt、角色、参数、执行队列">
            手动挡
          </button>
        </div>
      </div>

      {driveMode === 'auto' ? (
        <div className="nai-drive-page nai-drive-page-auto">
          <div className="nai-drive-brief auto">
            <div>
              <h4>网页加装层编辑已退役</h4>
              <p>加装预设、角色私设、角色参考与替换规则现在只能在“NAI 出图终端”桌面 App 中查看和修改。网页不再读写私设内容。</p>
            </div>
            <div className="nai-drive-scope">
              <span>请打开桌面终端</span>
              <span>旧网页保存接口会明确拒绝</span>
            </div>
          </div>
          {/* 保留旧组件仅供数据迁移期代码考古，永不挂载：防止浏览器触发私设 GET/POST。 */}
          {false && (augTab === 'preset' ? <AugPresetEditor /> : <CharLayerEditor characters={characters} />)}
        </div>
      ) : (
        <div className="nai-drive-page nai-drive-page-manual">
          <div className="nai-manual-actions">
            <button className="btn btn-secondary btn-small" onClick={() => batch.addItem()} disabled={isRunning}
              title={isRunning ? '出图中无法新建预设' : '新建一个空预设档'}>
              + 新建预设
            </button>
            <button className="btn btn-secondary btn-small" onClick={() => setShowLoadDialog(true)} disabled={isRunning}
              title={isRunning ? '出图中无法加载' : '加载已保存的预设档库'}>
              加载
            </button>
            <button className="btn btn-secondary btn-small" onClick={() => setShowSaveDialog(true)} disabled={isRunning || itemCount === 0}>
              保存为...
            </button>
            <button className="btn btn-secondary btn-small" onClick={batch.clearAll} disabled={isRunning || itemCount === 0}
              title={isRunning ? '出图中无法清空' : '清空所有预设档'}>
              清空
            </button>
          </div>

          <div className="nai-drive-brief manual">
            <div>
              <h4>手动挡：网页里自己控制的 NAI 队列</h4>
              <p>这里是手动坐驾驶位：编辑 prompt、角色、参数和批量队列。它不会自动套用自动挡里的加装层。</p>
            </div>
            <div className="nai-drive-scope">
              <span>{itemCount} 个预设档</span>
              {pendingCount > 0 && <span>队列待跑 {queueTotalRemaining} 张</span>}
              {activeItem && <span>当前：{activeItem.comment}</span>}
            </div>
          </div>

      {/* 全局默认参数 */}
      <CollapsibleSection
        title="全局默认参数"
        subtitle={`${defaultParams.model || '未设置'} · ${defaultParams.width}×${defaultParams.height} · ${defaultParams.sampler} · steps=${defaultParams.steps}`}
        open={showDefaults}
        onToggle={() => setShowDefaults(o => !o)}
      >
        <ParamsEditor
          params={defaultParams as Partial<NaiParams>}
          sizePresets={config.size_presets || []}
          onChangeParam={patchDefaultParam}
          onChangePresets={setSizePresets}
        />
      </CollapsibleSection>

      {/* 默认基础提示词（独立折叠） */}
      <CollapsibleSection
        title="默认基础提示词"
        subtitle={(() => {
          const arr = normalizeDefaultBlocks(config.default_base_blocks)
          const enabled = arr.filter(b => b.enabled && b.text.trim()).length
          return `已启用 ${enabled}/${arr.length} 区块（新建任务时自动填入）`
        })()}
        open={showDefaultBlocks}
        onToggle={() => setShowDefaultBlocks(o => !o)}
      >
        <DefaultBlocksEditor
          defaultBaseBlocks={normalizeDefaultBlocks(config.default_base_blocks)}
          onChange={patchDefaultBaseBlocks}
        />
      </CollapsibleSection>

      {/* 批次设置 */}
      <CollapsibleSection
        title="批次设置"
        subtitle={`生成张数${batchSettings.number_of_requests || '?'} · 每批${batchSettings.batch_count ?? 1}张 · 间隔${batchSettings.interval_seconds ?? 1}s · 429重试: ${batchSettings.retry_on_429_enabled ? '开' : '关'}`}
        open={showBatchSettings}
        onToggle={() => setShowBatchSettings(o => !o)}
      >
        <BatchSettingsEditor batch={batchSettings} onChangeField={patchBatch}
          activeBatchMode={activeBatchMode}
          variantDistribution={variantDist} />
      </CollapsibleSection>

      {/* 实时缩略图条（横向滚动，自动滚到最新；放在 prompt 上方便于即时查看） */}
      {generatedImages.length > 0 && (
        <ThumbnailStrip images={generatedImages} />
      )}

      {/* 执行控制（大圆按钮 + 加入队列 + 进度） */}
      <div className="nai-batch-runbar">
        <div className="nai-run-wrap">
          <button
            className={`nai-run-button ${isRunning ? 'running' : ''} ${!isRunning && pendingCount > 0 ? 'resume' : ''}`}
            onClick={isRunning ? stopQueue : runLoop}
            disabled={!isRunning && pendingCount === 0 && (!activeItem || cap <= 0)}
            title={isRunning
              ? '点击停止（当前正在出的图会出完，间隔等待立即中断，无延迟）'
              : pendingCount > 0
                ? `跑队列：${pendingCount} 个作业 / 共 ${queueTotalRemaining} 张`
                : !activeItem ? '请先新建预设'
                  : cap <= 0 ? '请在「批次设置」中填写「生成图片总数」'
                    : `点击跑 ${cap} 张：${activeItem.comment}`}
          >
            {isRunning ? '■' : '▶'}
          </button>
          <div className="nai-run-label">
            {isRunning
              ? '点击停止'
              : pendingCount > 0
                ? `跑队列 ${queueTotalRemaining} 张`
                : (activeItem ? `跑 ${cap} 张` : '请先建预设')}
          </div>
        </div>
        {/* 加入队列：运行中也可用 → 实现"运行中追加" */}
        <button className="btn btn-warning btn-small nai-enqueue-btn"
          onClick={handleEnqueueActive}
          disabled={!activeItem || cap <= 0}
          title={!activeItem ? '请先新建预设'
            : cap <= 0 ? '请在「批次设置」中填写「生成图片总数」'
              : isRunning
                ? `把「${activeItem.comment}」再排 ${cap} 张到队列末尾（当前批跑完接着跑）`
                : `把「${activeItem.comment}」排 ${cap} 张进队列`}>
          ＋加入队列（{cap}）
        </button>
        <div className="nai-batch-progress">
          <div className="nai-batch-progress-bar">
            <div className="nai-batch-progress-fill"
              style={{ width: `${runProgress.total > 0 ? (runProgress.done / runProgress.total) * 100 : 0}%` }} />
          </div>
          <span className="nai-batch-progress-text">
            {isRunning
              ? `${runProgress.done}/${runProgress.total}${runProgress.currentItem ? ` — ${runProgress.currentItem}` : ''}${pendingCount > 1 ? ` · 队列还有 ${pendingCount - 1} 个作业` : ''}`
              : pendingCount > 0
                ? `队列待跑：${pendingCount} 个作业 / 共 ${queueTotalRemaining} 张 — 点 ▶ 开始（prompt 改了立即生效）`
                : activeItem
                  ? `准备：跑 ${cap} 张${activeBatchMode && variantDist.length > 0 ? '（' + variantDist.length + ' 变体 round-robin）' : ''}`
                  : '请新建一个预设档'}
          </span>
        </div>
      </div>

      {/* 执行队列列表 */}
      {jobs.length > 0 && (
        <QueuePanel jobs={jobs} isRunning={isRunning}
          onRemove={removeJob} onClearFinished={clearFinishedJobs} onClearQueue={clearQueue} />
      )}

      {/* 预设档库 tab 切换 */}
      {plan.items.length === 0 ? (
        <div className="nai-batch-empty">
          <p>预设档库为空。</p>
          <p>方式 ① 点上面「+ 新建预设」从零开始</p>
          <p>方式 ② 去「生产 → 组装棚」组装后点底部「加入NAI预设」</p>
        </div>
      ) : (
        <>
          <div className="nai-item-tabs-bar">
            {plan.items.map((item, idx) => {
              const isActive = activeItemId === item.id || (activeItemId === null && idx === 0)
              const hasBatch = isItemInBatchMode(item)
              return (
                <button key={item.id}
                  className={`nai-item-tab ${isActive ? 'active' : ''} status-${item.status || 'pending'} ${hasBatch ? 'has-batch' : ''}`}
                  onClick={() => setActiveItemId(item.id)}
                  title={`切换为 active — ${item.comment}${hasBatch ? '（含批量）' : ''}`}>
                  <span className="nai-item-tab-name">{item.comment}</span>
                  {hasBatch && <span className="nai-item-tab-count">🔀</span>}
                  {item.status === 'done' && <span className="nai-item-tab-badge done">✓</span>}
                  {item.status === 'running' && <span className="nai-item-tab-badge running">…</span>}
                  {item.status === 'error' && <span className="nai-item-tab-badge error">!</span>}
                </button>
              )
            })}
            <button className="nai-item-tab-add" onClick={() => batch.addItem()} disabled={isRunning}
              title="新建预设档">
              +
            </button>
          </div>

          {/* active 任务编辑器 */}
          {activeItem && (() => {
            const activeIdx = plan.items.findIndex(i => i.id === activeItem.id)
            // 出图过程中也允许编辑：每次提交前会重新读取 item 当前 state，
            // 用户改的 prompt 在下一张就生效（"提交那一刻的 prompt 为准"）。
            const cardDisabled = false
            return (
              <BatchItemCard
                key={activeItem.id}
                item={activeItem}
                index={activeIdx}
                total={plan.items.length}
                batch={batch}
                characters={characters}
                disabled={cardDisabled}
                onAfterRemove={() => {
                  // 删除后切到第一个剩余任务
                  const remain = plan.items.filter(i => i.id !== activeItem.id)
                  setActiveItemId(remain[0]?.id || null)
                }}
              />
            )
          })()}
        </>
      )}

      {/* 错误日志 */}
      {errorLog && (
        <div className="nai-batch-errors">
          <h4>错误日志</h4>
          <pre>{errorLog}</pre>
        </div>
      )}
        </div>
      )}

      {/* 对话框 */}
      {showSaveDialog && (
        <SaveDialog
          onSave={async (name) => {
            const ok = await batch.savePlanAs(name)
            setShowSaveDialog(false)
            if (!ok) alert('保存失败')
          }}
          onClose={() => setShowSaveDialog(false)}
        />
      )}
      {showLoadDialog && (
        <LoadDialog
          plans={batch.savedPlans}
          onLoad={async (id) => { await batch.loadPlan(id); setShowLoadDialog(false) }}
          onDelete={(id) => batch.deletePlan(id)}
          onClose={() => setShowLoadDialog(false)}
        />
      )}
    </div>
  )
}

// ── 执行队列面板（多预设串行队列的可视化 + 管理） ──
const QUEUE_STATUS_TEXT: Record<NaiQueueJob['status'], string> = {
  queued: '待跑', running: '运行中', paused: '已暂停', done: '完成', error: '出错',
}
function QueuePanel({ jobs, isRunning, onRemove, onClearFinished, onClearQueue }: {
  jobs: NaiQueueJob[]
  isRunning: boolean
  onRemove: (id: string) => void
  onClearFinished: () => void
  onClearQueue: () => void
}) {
  const hasFinished = jobs.some(j => j.status === 'done' || j.status === 'error')
  const hasRemovable = jobs.some(j => j.status !== 'running')
  return (
    <div className="nai-queue-panel">
      <div className="nai-queue-header">
        <h4>执行队列（{jobs.length}）</h4>
        <div className="nai-queue-header-actions">
          {hasFinished && (
            <button className="btn btn-secondary btn-small" onClick={onClearFinished}>清除已完成</button>
          )}
          {hasRemovable && (
            <button className="btn btn-secondary btn-small" onClick={onClearQueue}
              title="清空队列里所有未运行的作业（正在跑的不动）">清空队列</button>
          )}
        </div>
      </div>
      <ul className="nai-queue-list">
        {jobs.map((j, i) => (
          <li key={j.id} className={`nai-queue-item status-${j.status}`}>
            <span className="nai-queue-idx">{i + 1}</span>
            <span className="nai-queue-name" title={j.comment}>{j.comment}</span>
            <span className="nai-queue-progress">{j.produced}/{j.target}</span>
            <span className={`nai-queue-status status-${j.status}`}>
              {QUEUE_STATUS_TEXT[j.status]}
              {j.status === 'error' && j.errorMessage ? ` · ${j.errorMessage.slice(0, 40)}` : ''}
            </span>
            <button className="btn-icon btn-icon-danger" onClick={() => onRemove(j.id)}
              disabled={j.status === 'running'}
              title={j.status === 'running' ? '运行中无法删除（先停止）' : '从队列移除'}>×</button>
          </li>
        ))}
      </ul>
      {isRunning && <p className="nai-section-hint">运行中也能「＋加入队列」，会排到末尾，当前作业跑完自动接着跑。</p>}
    </div>
  )
}

// ── 实时缩略图条（横向滚动，新图进来自动滚到最右） ──
function ThumbnailStrip({ images }: { images: string[] }) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // 新图通常加在末尾，滚到最右才能看到
    el.scrollLeft = el.scrollWidth
  }, [images.length])
  return (
    <div className="nai-batch-thumbnails">
      <h4>
        本次生成（{images.length} 张）
        <span className="nai-batch-thumbs-hint">点击在新窗口打开 · 自动滚到最新</span>
      </h4>
      <div className="nai-batch-thumbnails-grid" ref={scrollRef}>
        {images.map((img, idx) => {
          const proxyUrl = `/api/nai/file?path=${encodeURIComponent(img)}`
          const filename = img.split(/[/\\]/).pop() || `gen-${idx}`
          return (
            <a key={img} href={proxyUrl} target="_blank" rel="noreferrer"
              className="nai-batch-thumb" title={filename}>
              <img src={proxyUrl} alt={filename} loading="lazy" />
            </a>
          )
        })}
      </div>
    </div>
  )
}

// ── 可折叠区段 ──
function CollapsibleSection({
  title, subtitle, open, onToggle, children,
}: {
  title: string; subtitle?: string; open: boolean; onToggle: () => void; children: React.ReactNode
}) {
  return (
    <div className={`nai-collapse ${open ? 'open' : ''}`}>
      <button className="nai-collapse-header" onClick={onToggle}>
        <span className="nai-collapse-arrow">{open ? '▼' : '▶'}</span>
        <span className="nai-collapse-title">{title}</span>
        {subtitle && <span className="nai-collapse-subtitle">{subtitle}</span>}
      </button>
      {open && <div className="nai-collapse-body">{children}</div>}
    </div>
  )
}

// ── 单条任务卡片（active 预设档的编辑器） ──
function BatchItemCard({
  item, index, total, batch, characters, disabled, onAfterRemove,
}: {
  item: NaiBatchItem; index: number; total: number
  batch: ReturnType<typeof useNaiBatch>
  characters: Character[]
  disabled: boolean      // 此预设正在跑图时锁定编辑
  onAfterRemove?: () => void
}) {
  // 持久化每个任务卡片的当前 tab 选择
  const [section, setSectionState] = useState<'base' | 'characters' | 'params' | 'charref' | null>(() => {
    const tabs = readItemTabs()
    return tabs[item.id] ?? 'base'
  })

  const setSection = (s: 'base' | 'characters' | 'params' | 'charref' | null) => {
    setSectionState(s)
    const tabs = readItemTabs()
    tabs[item.id] = s
    writeItemTabs(tabs)
  }

  const toggle = (s: 'base' | 'characters' | 'params' | 'charref') => setSection(section === s ? null : s)

  const statusLabel = { pending: '', running: '运行中', done: '完成', error: '出错' }[item.status || 'pending']
  const enabledBlocks = item.baseBlocks.filter(b => b.enabled && b.text.trim()).length
  const enabledChars = item.characters.filter(c => c.enabled && c.text.trim()).length
  const isFinished = item.status === 'done' || item.status === 'error'
  const resetStatus = () => batch.updateItem(item.id, {
    status: 'pending', generatedCount: 0, generatedImages: [], errorMessage: undefined,
  })

  return (
    <div className={`nai-batch-card status-${item.status || 'pending'}`}>
      {/* 头部：预设名 + 状态 + 操作（无 enabled/count） */}
      <div className="nai-batch-card-header">
        <input className="nai-batch-card-comment" value={item.comment}
          onChange={e => batch.updateItem(item.id, { comment: e.target.value })} disabled={disabled}
          placeholder="预设档名称" />
        {statusLabel && <span className={`nai-batch-card-status status-${item.status}`}>{statusLabel}</span>}
        <label className="nai-aug-toggle" title="提交时过固定加装层(自动挡 activeId 预设)。换AW 的 persona 靠它补；纯复刻原角色可关。">
          <input type="checkbox" checked={!!item.augment} disabled={disabled}
            onChange={e => batch.updateItem(item.id, { augment: e.target.checked })} />
          过加装层
        </label>
        <div className="nai-batch-card-actions">
          {isFinished && (
            <button className="btn-icon" onClick={resetStatus}
              disabled={disabled} title="清除上次出图状态">↺</button>
          )}
          <button className="btn-icon" onClick={() => batch.moveItem(item.id, 'up')}
            disabled={disabled || index === 0} title="上移（仅 tab 排序）">↑</button>
          <button className="btn-icon" onClick={() => batch.moveItem(item.id, 'down')}
            disabled={disabled || index === total - 1} title="下移（仅 tab 排序）">↓</button>
          <button className="btn-icon" onClick={() => batch.duplicateItem(item.id)}
            disabled={disabled} title="复制此预设档">⎘</button>
          <button className="btn-icon btn-icon-danger"
            onClick={() => { batch.removeItem(item.id); onAfterRemove?.() }}
            disabled={disabled} title="删除此预设档">×</button>
        </div>
      </div>

      {/* 折叠按钮组 */}
      <div className="nai-batch-card-tabs">
        <button className={`nai-batch-card-tab ${section === 'base' ? 'active' : ''}`}
          onClick={() => toggle('base')}>
          基础提示词（{enabledBlocks}/{item.baseBlocks.length}）
        </button>
        <button className={`nai-batch-card-tab ${section === 'characters' ? 'active' : ''}`}
          onClick={() => toggle('characters')}>
          角色提示词（{enabledChars}/{item.characters.length}）
        </button>
        <button className={`nai-batch-card-tab ${section === 'params' ? 'active' : ''}`}
          onClick={() => toggle('params')}>
          参数覆盖（{Object.keys(item.paramsOverride).length}）
        </button>
        <button className={`nai-batch-card-tab ${section === 'charref' ? 'active' : ''}`}
          onClick={() => toggle('charref')}
          title="Precise Reference 角色参考（仅 V4.5，每张 ~5 Anlas，与 Vibe 互斥）">
          角色参考{item.charReference?.image_b64 ? ' ●' : ''}
        </button>
      </div>

      {/* 区段内容 */}
      {section === 'base' && (
        <BaseBlocksEditor item={item} batch={batch} disabled={disabled} />
      )}
      {section === 'characters' && (
        <CharactersEditor item={item} batch={batch} characters={characters} disabled={disabled} />
      )}
      {section === 'params' && (
        <ParamsOverrideEditor item={item} batch={batch} disabled={disabled} />
      )}
      {section === 'charref' && (
        <CharReferenceEditor item={item} batch={batch} disabled={disabled} />
      )}

      {/* 卡片底部状态 */}
      {(item.generatedCount !== undefined && item.generatedCount > 0) || item.errorMessage ? (
        <div className="nai-batch-card-footer-status">
          {item.generatedCount !== undefined && item.generatedCount > 0 && (
            <span className="nai-batch-card-progress">上次生成 {item.generatedCount} 张</span>
          )}
          {item.errorMessage && (
            <span className="nai-batch-card-error" title={item.errorMessage}>
              ⚠ {item.errorMessage.slice(0, 80)}
            </span>
          )}
        </div>
      ) : null}
    </div>
  )
}

// ── 基础区块编辑器 ──
function BaseBlocksEditor({ item, batch, disabled }: {
  item: NaiBatchItem; batch: ReturnType<typeof useNaiBatch>; disabled: boolean
}) {
  // 计算是否已有其他 block 在 batchMode（用于禁用其他 block 的批量开关）
  const batchModeBlockId = item.baseBlocks.find(b => b.batchMode)?.id
  return (
    <div className="nai-blocks-editor">
      {item.baseBlocks.map((b, idx) => (
        <BlockRow key={b.id} block={b} index={idx} total={item.baseBlocks.length}
          onUpdate={(patch) => batch.updateBlock(item.id, b.id, patch)}
          onRemove={() => batch.removeBlock(item.id, b.id)}
          onMoveUp={() => batch.moveBlock(item.id, b.id, 'up')}
          onMoveDown={() => batch.moveBlock(item.id, b.id, 'down')}
          onToggleBatch={(enabled) => batch.setBlockBatchMode(item.id, b.id, enabled)}
          onAddVariant={() => batch.addVariant(item.id, b.id)}
          onUpdateVariant={(vid, patch) => batch.updateVariant(item.id, b.id, vid, patch)}
          onRemoveVariant={(vid) => batch.removeVariant(item.id, b.id, vid)}
          onMoveVariant={(vid, dir) => batch.moveVariant(item.id, b.id, vid, dir)}
          otherBlockHasBatchMode={batchModeBlockId !== undefined && batchModeBlockId !== b.id}
          disabled={disabled} />
      ))}
      <button className="nai-add-block" onClick={() => batch.addBlock(item.id)} disabled={disabled}>
        + 增加区块
      </button>
    </div>
  )
}

function BlockRow({
  block, index, total,
  onUpdate, onRemove, onMoveUp, onMoveDown,
  onToggleBatch, onAddVariant, onUpdateVariant, onRemoveVariant, onMoveVariant,
  otherBlockHasBatchMode,
  disabled,
}: {
  block: NaiPromptBlock; index: number; total: number
  onUpdate: (patch: Partial<NaiPromptBlock>) => void
  onRemove: () => void; onMoveUp: () => void; onMoveDown: () => void
  onToggleBatch: (enabled: boolean) => void
  onAddVariant: () => void
  onUpdateVariant: (variantId: string, patch: Partial<NaiBlockVariant>) => void
  onRemoveVariant: (variantId: string) => void
  onMoveVariant: (variantId: string, direction: 'up' | 'down') => void
  otherBlockHasBatchMode: boolean
  disabled: boolean
}) {
  const inBatchMode = !!block.batchMode
  const variants = block.variants || []
  const enabledVariantCount = variants.filter(v => v.enabled && v.text.trim()).length

  return (
    <div className={`nai-block-row ${block.enabled ? '' : 'disabled'} ${block.isPrivate ? 'private' : ''} ${inBatchMode ? 'batch-mode' : ''}`}>
      <div className="nai-block-row-header">
        <input type="checkbox" checked={block.enabled}
          onChange={e => onUpdate({ enabled: e.target.checked })} disabled={disabled} title="启用/禁用" />
        <input className="nai-block-name" value={block.name}
          onChange={e => onUpdate({ name: e.target.value })} disabled={disabled} placeholder="区块名" />
        {block.isPrivate && <span className="nai-block-privacy">🔒</span>}
        {/* 批量跑开关 */}
        <label className={`nai-batch-toggle ${inBatchMode ? 'on' : ''}`}
          title={otherBlockHasBatchMode && !inBatchMode
            ? '同任务内只能有一个区块开启批量（请先关闭其他区块的批量）'
            : inBatchMode
              ? `批量模式：${enabledVariantCount} 个变体（总张数 = 批次设置的 cap，按 round-robin 平摊）`
              : '开启后，本区块按变体列表 round-robin 出图，其他区块固定'}>
          <input type="checkbox" checked={inBatchMode}
            onChange={e => onToggleBatch(e.target.checked)}
            disabled={disabled || (otherBlockHasBatchMode && !inBatchMode)} />
          <span>🔀 批量</span>
          {inBatchMode && <span className="nai-batch-toggle-count">{enabledVariantCount} 变体</span>}
        </label>
        <div className="nai-block-actions">
          <button className="btn-icon" onClick={onMoveUp} disabled={disabled || index === 0} title="上移">↑</button>
          <button className="btn-icon" onClick={onMoveDown} disabled={disabled || index === total - 1} title="下移">↓</button>
          <button className="btn-icon btn-icon-danger" onClick={onRemove} disabled={disabled} title="删除">×</button>
        </div>
      </div>
      {inBatchMode ? (
        <div className="nai-variants-list">
          {variants.length === 0 && (
            <div className="nai-variants-empty">还没有变体，点下方按钮添加</div>
          )}
          {variants.map((v, vi) => (
            <VariantRow key={v.id} variant={v} index={vi} total={variants.length}
              onUpdate={(patch) => onUpdateVariant(v.id, patch)}
              onRemove={() => onRemoveVariant(v.id)}
              onMoveUp={() => onMoveVariant(v.id, 'up')}
              onMoveDown={() => onMoveVariant(v.id, 'down')}
              disabled={disabled} />
          ))}
          <button className="nai-add-block nai-add-variant" onClick={onAddVariant} disabled={disabled}>
            + 增加变体
          </button>
        </div>
      ) : (
        <AutoGrowTextarea className="nai-block-text" value={block.text}
          onChange={v => onUpdate({ text: v })} disabled={disabled}
          placeholder="提示词内容..." />
      )}
    </div>
  )
}

// 批量跑：单个变体行（label + 启用/删除 + textarea；张数由 cap 按 round-robin 自动分配）
function VariantRow({ variant, index, total, onUpdate, onRemove, onMoveUp, onMoveDown, disabled }: {
  variant: NaiBlockVariant; index: number; total: number
  onUpdate: (patch: Partial<NaiBlockVariant>) => void
  onRemove: () => void; onMoveUp: () => void; onMoveDown: () => void
  disabled: boolean
}) {
  return (
    <div className={`nai-variant-row ${variant.enabled ? '' : 'disabled'}`}>
      <div className="nai-variant-header">
        <input type="checkbox" checked={variant.enabled}
          onChange={e => onUpdate({ enabled: e.target.checked })} disabled={disabled} title="启用/禁用此变体" />
        <input className="nai-variant-label" type="text" value={variant.label}
          onChange={e => onUpdate({ label: e.target.value })} disabled={disabled}
          placeholder="标签（进文件名）" title="变体标签：用于文件名前缀，比如 正面牛仔 / 背面全身" />
        <div className="nai-block-actions">
          <button className="btn-icon" onClick={onMoveUp} disabled={disabled || index === 0} title="上移">↑</button>
          <button className="btn-icon" onClick={onMoveDown} disabled={disabled || index === total - 1} title="下移">↓</button>
          <button className="btn-icon btn-icon-danger" onClick={onRemove} disabled={disabled} title="删除">×</button>
        </div>
      </div>
      <AutoGrowTextarea className="nai-block-text nai-variant-text" value={variant.text}
        onChange={v => onUpdate({ text: v })} disabled={disabled}
        placeholder="此变体的 prompt 内容..." />
    </div>
  )
}

// ── 角色编辑器 ──
// 角色加装层指派面板：给每个角色槽（按 index 0-based）选一个可复用角色加装层
function CharLayerAssignPanel({ item, batch, disabled }: {
  item: NaiBatchItem; batch: ReturnType<typeof useNaiBatch>; disabled: boolean
}) {
  const [layers, setLayers] = useState<{ id: string; name: string; enabled?: boolean }[]>([])
  useEffect(() => {
    let cancelled = false
    fetch('/api/nai/char-layers')
      .then(r => r.json())
      .then((d: { layers?: { id: string; name: string; enabled?: boolean }[] }) => {
        if (!cancelled) setLayers((d.layers || []).map(l => ({ id: l.id, name: l.name, enabled: l.enabled })))
      })
      .catch(() => { /* ignore */ })
    return () => { cancelled = true }
  }, [])

  if (item.characters.length === 0) return null
  const assign = item.charLayerAssign || {}
  const setAssign = (slot: number, layerId: string) => {
    const next: Record<number, string> = { ...assign }
    if (layerId) next[slot] = layerId
    else delete next[slot]
    batch.updateItem(item.id, { charLayerAssign: next })
  }

  return (
    <div style={{ border: '1px solid var(--border, #333)', borderRadius: 6, padding: 8, marginBottom: 10 }}>
      <p className="nai-section-hint" style={{ marginTop: 0 }}>
        <b>角色加装层指派</b>：给某角色槽选一个可复用角色加装层（如角色1上 adult woman A）+ 该槽 <b>视角</b>（按视角选 persona 变体，blue eyes 只进正面）。
        提交走 <code>--char-layers</code>，私设脚本内合并；整图级参考图只取第一张 enabled 生效。
      </p>
      {layers.length === 0 && <p className="nai-section-hint">（还没有角色加装层。去「自动挡 → 角色加装层」新建。）</p>}
      {item.characters.map((c, i) => (
        <div key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, minWidth: 96 }}>角色{i + 1}{c.name ? `（${c.name}）` : ''}</span>
          <select value={assign[i] || ''} disabled={disabled || layers.length === 0}
            onChange={e => setAssign(i, e.target.value)} style={{ minWidth: 150 }}>
            <option value="">（不指派）</option>
            {layers.map(l => <option key={l.id} value={l.id} disabled={l.enabled === false}>{l.name}{l.enabled === false ? '（停用）' : ''}</option>)}
          </select>
          <select value={c.view || 'front_full'} disabled={disabled}
            onChange={e => batch.updateCharacter(item.id, c.id, { view: e.target.value as ViewKey })}
            title="该槽视角：角色加装层按此选 persona 变体（front 含五官 / back 去五官）" style={{ minWidth: 110 }}>
            {VIEW_KEYS.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
      ))}
    </div>
  )
}

function CharactersEditor({ item, batch, characters, disabled }: {
  item: NaiBatchItem; batch: ReturnType<typeof useNaiBatch>
  characters: Character[]; disabled: boolean
}) {
  // 当前打开 picker 的角色行 id（null = 关闭）
  const [pickerForCharId, setPickerForCharId] = useState<string | null>(null)

  return (
    <div className="nai-chars-editor">
      <p className="nai-section-hint">
        角色提示词独立于基础提示词，对应 NAI V4 的 characterPrompts。
        可手写、也可点「📚 从角色库选」自动按视角填充。
      </p>
      <CharLayerAssignPanel item={item} batch={batch} disabled={disabled} />
      {item.characters.map(c => (
        <CharacterRow key={c.id} char={c}
          onUpdate={(patch) => batch.updateCharacter(item.id, c.id, patch)}
          onRemove={() => batch.removeCharacter(item.id, c.id)}
          onPickFromLibrary={() => setPickerForCharId(c.id)}
          disabled={disabled} />
      ))}
      <button className="nai-add-block" onClick={() => batch.addCharacter(item.id)} disabled={disabled}>
        + 增加角色
      </button>

      {pickerForCharId && (
        <CharacterPickerDialog
          characters={characters}
          onClose={() => setPickerForCharId(null)}
          onPick={({ name, text, negative, view }) => {
            // 从角色库选时，同步把角色级+衣服级合并负面词写入该角色的 char-level negative；view 固化供角色加装层选变体
            batch.updateCharacter(item.id, pickerForCharId, { name, text, negative_text: negative, view })
            setPickerForCharId(null)
          }}
        />
      )}
    </div>
  )
}

// 5x5 网格坐标轴值（NAI V4 centers 标准 5 等分）
const POS_AXIS = [0.1, 0.3, 0.5, 0.7, 0.9] as const
const POS_COLS = ['A', 'B', 'C', 'D', 'E'] as const

// 把 {x, y} 反查成 "C3" 这种标签；找不到精确匹配就找最近的
function posToLabel(pos: { x: number; y: number } | null | undefined): string {
  if (!pos) return ''
  const findIdx = (v: number) => {
    let best = 0
    let bestDiff = Infinity
    for (let i = 0; i < POS_AXIS.length; i++) {
      const d = Math.abs(POS_AXIS[i] - v)
      if (d < bestDiff) { bestDiff = d; best = i }
    }
    return best
  }
  return `${POS_COLS[findIdx(pos.x)]}${findIdx(pos.y) + 1}`
}

function PositionGridModal({ value, onConfirm, onCancel }: {
  value: { x: number; y: number } | null | undefined
  onConfirm: (pos: { x: number; y: number } | null) => void
  onCancel: () => void
}) {
  const initial = value ?? { x: 0.5, y: 0.5 }
  const [pos, setPos] = useState(initial)
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content nai-pos-modal" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onCancel}>×</button>
        <h3>编辑：角色位置</h3>
        <p className="nai-section-hint">
          5×5 网格对应 NAI V4 的 centers 坐标。居中 = C3 = (0.5, 0.5)。
        </p>
        <div className="nai-pos-grid">
          {POS_AXIS.map((y, ri) => (
            <div key={ri} className="nai-pos-row">
              {POS_AXIS.map((x, ci) => {
                const label = `${POS_COLS[ci]}${ri + 1}`
                const active = Math.abs(pos.x - x) < 0.01 && Math.abs(pos.y - y) < 0.01
                return (
                  <button key={label}
                    className={`nai-pos-cell ${active ? 'active' : ''}`}
                    onClick={() => setPos({ x, y })}
                    title={`x=${x}, y=${y}`}
                  >{label}</button>
                )
              })}
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={() => onConfirm(null)} title="不指定位置 → 由 AI 自动选择">
            清除位置
          </button>
          <button className="btn btn-primary" onClick={() => onConfirm(pos)}>确认</button>
        </div>
      </div>
    </div>
  )
}

function NegativeTextModal({ value, onConfirm, onCancel }: {
  value: string | undefined
  onConfirm: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(value || '')
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content nai-neg-modal" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onCancel}>×</button>
        <h3>编辑：反向提示词</h3>
        <p className="nai-section-hint">
          仅作用于该角色，与全局 negative_prompt 叠加。留空 = 不附加 char-level negative。
        </p>
        <textarea className="nai-block-text" value={text}
          onChange={e => setText(e.target.value)} rows={5}
          placeholder="如 bad anatomy, low quality... 留空表示无 char-level negative" />
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onCancel}>取消</button>
          <button className="btn btn-primary" onClick={() => onConfirm(text.trim())}>确认</button>
        </div>
      </div>
    </div>
  )
}

function CharacterRow({ char, onUpdate, onRemove, onPickFromLibrary, disabled }: {
  char: NaiCharacterPrompt
  onUpdate: (patch: Partial<NaiCharacterPrompt>) => void
  onRemove: () => void
  onPickFromLibrary: () => void
  disabled: boolean
}) {
  const [showPosModal, setShowPosModal] = useState(false)
  const [showNegModal, setShowNegModal] = useState(false)
  const posLabel = posToLabel(char.position)
  const hasNeg = !!(char.negative_text && char.negative_text.trim())

  return (
    <div className={`nai-char-row ${char.enabled ? '' : 'disabled'}`}>
      <div className="nai-block-row-header">
        <input type="checkbox" checked={char.enabled}
          onChange={e => onUpdate({ enabled: e.target.checked })} disabled={disabled} />
        <input className="nai-block-name" value={char.name}
          onChange={e => onUpdate({ name: e.target.value })} disabled={disabled} placeholder="角色名（自由命名）" />
        <button className="btn btn-secondary btn-small" onClick={onPickFromLibrary} disabled={disabled}
          title="从角色库选角色、衣服、视角">
          📚 从角色库选
        </button>
        <div className="nai-block-actions">
          <button className="btn-icon btn-icon-danger" onClick={onRemove} disabled={disabled} title="删除">×</button>
        </div>
      </div>
      <div className="nai-char-meta-row">
        <button className={`nai-char-meta-btn ${char.position ? 'active' : ''}`}
          onClick={() => setShowPosModal(true)} disabled={disabled}
          title={char.position ? `当前：${posLabel}（x=${char.position.x}, y=${char.position.y}）` : '未设位置（由 AI 自动）'}
        >
          📍 角色位置{char.position ? `：${posLabel}` : ''}
        </button>
        <button className={`nai-char-meta-btn ${hasNeg ? 'active' : ''}`}
          onClick={() => setShowNegModal(true)} disabled={disabled}
          title={hasNeg ? char.negative_text : '该角色暂无 char-level negative'}
        >
          ⊘ 反向提示词{hasNeg ? '（已设）' : ''}
        </button>
      </div>
      <AutoGrowTextarea className="nai-block-text" value={char.text}
        onChange={v => onUpdate({ text: v })} disabled={disabled} minRows={3}
        placeholder="角色 prompt（如 1girl, white hair, blue eyes... — 或用上方按钮自动填充）" />
      {showPosModal && (
        <PositionGridModal value={char.position}
          onConfirm={(pos) => { onUpdate({ position: pos }); setShowPosModal(false) }}
          onCancel={() => setShowPosModal(false)} />
      )}
      {showNegModal && (
        <NegativeTextModal value={char.negative_text}
          onConfirm={(t) => { onUpdate({ negative_text: t }); setShowNegModal(false) }}
          onCancel={() => setShowNegModal(false)} />
      )}
    </div>
  )
}

// ── 单条任务的角色参考编辑器（Precise Reference，仅 V4.5）──
function CharReferenceEditor({ item, batch, disabled }: {
  item: NaiBatchItem; batch: ReturnType<typeof useNaiBatch>; disabled: boolean
}) {
  const cr = item.charReference
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const patch = (p: Partial<NonNullable<NaiBatchItem['charReference']>>) => {
    if (!item.charReference) return
    batch.updateItem(item.id, { charReference: { ...item.charReference, ...p } })
  }

  const onPickFile = async (file: File | undefined) => {
    if (!file) return
    setBusy(true); setErr(null)
    try {
      const b64 = await encodeCharReferenceImage(file)
      batch.updateItem(item.id, {
        charReference: {
          image_b64: b64,
          fileName: file.name,
          strength: cr?.strength ?? 1.0,
          fidelity: cr?.fidelity ?? 1.0,
          base_caption: charRefMode(cr),
        },
      })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const clear = () => batch.updateItem(item.id, { charReference: null })

  return (
    <div className="nai-params-editor">
      <p className="nai-section-hint">
        Precise Reference 角色参考：上传一张参考图锁定角色身份。<b>仅 V4.5 模型</b>、与 Vibe 互斥、
        <b>每张图额外消耗 ~5 Anlas</b>（消耗型，无可复用编码）。图片会自动 letterbox 到允许画布。
      </p>

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {cr?.image_b64 ? (
          <img src={`data:image/png;base64,${cr.image_b64}`} alt="角色参考"
            style={{ width: 96, height: 144, objectFit: 'contain', background: '#000', borderRadius: 6 }} />
        ) : (
          <div style={{ width: 96, height: 144, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.2)', borderRadius: 6, fontSize: 12, color: '#888', textAlign: 'center' }}>
            未选择
          </div>
        )}
        <div style={{ flex: 1, minWidth: 200 }}>
          <label className="nai-add-block" style={{ cursor: disabled || busy ? 'default' : 'pointer', display: 'inline-block' }}>
            {busy ? '处理中…' : cr?.image_b64 ? '更换参考图' : '+ 选择参考图'}
            <input type="file" accept="image/*" style={{ display: 'none' }} disabled={disabled || busy}
              onChange={e => { onPickFile(e.target.files?.[0]); e.target.value = '' }} />
          </label>
          {cr?.image_b64 && (
            <button className="nai-add-block" style={{ marginLeft: 8 }} disabled={disabled} onClick={clear}>
              移除
            </button>
          )}
          {cr?.fileName && <div style={{ fontSize: 12, color: '#888', marginTop: 6 }}>{cr.fileName}</div>}
          {err && <div className="nai-batch-card-error" style={{ marginTop: 6 }}>⚠ {err}</div>}
        </div>
      </div>

      {cr?.image_b64 && (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 110 }}>Strength {cr.strength.toFixed(2)}</span>
            <input type="range" min={0} max={1} step={0.05} value={cr.strength} disabled={disabled}
              style={{ flex: 1 }} onChange={e => patch({ strength: Number(e.target.value) })} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 110 }}>Fidelity {cr.fidelity.toFixed(2)}</span>
            <input type="range" min={0} max={1} step={0.05} value={cr.fidelity} disabled={disabled}
              style={{ flex: 1 }} onChange={e => patch({ fidelity: Number(e.target.value) })} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 110 }}>参考模式</span>
            <select value={charRefMode(cr)} disabled={disabled} style={{ flex: 1 }}
              onChange={e => patch({ base_caption: e.target.value as CharRefMode })}>
              {CHAR_REF_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </label>
        </div>
      )}
    </div>
  )
}

// ── 单条任务的参数覆盖编辑器 ──
function ParamsOverrideEditor({ item, batch, disabled }: {
  item: NaiBatchItem; batch: ReturnType<typeof useNaiBatch>; disabled: boolean
}) {
  const ov = item.paramsOverride
  // ParamField.onChange 给的是 unknown（组件按 type 自行 coerce），故 patch 收 Record<string,unknown>，落库时回到 Partial<NaiParams>
  const setOv = (patch: Record<string, unknown>) => {
    // 用 undefined 删除某字段
    const next = { ...ov }
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete next[k as keyof NaiParams]
      else (next as Record<string, unknown>)[k] = v
    }
    batch.updateItem(item.id, { paramsOverride: next })
  }

  return (
    <div className="nai-params-editor">
      <p className="nai-section-hint">不填写的字段使用全局默认值。在字段右侧打 ✕ 可清除该覆盖。</p>
      <ParamField label="模型" value={ov.model} onChange={(v) => setOv({ model: v })}
        choices={MODEL_CHOICES} type="select" disabled={disabled} />
      <ParamField label="宽度" value={ov.width} onChange={(v) => setOv({ width: v })}
        type="number" disabled={disabled} />
      <ParamField label="高度" value={ov.height} onChange={(v) => setOv({ height: v })}
        type="number" disabled={disabled} />
      <ParamField label="采样步数" value={ov.steps} onChange={(v) => setOv({ steps: v })}
        type="number" min={1} max={50} disabled={disabled} />
      <ParamField label="Prompt Guidance (scale)" value={ov.scale} onChange={(v) => setOv({ scale: v })}
        type="float" step={0.1} disabled={disabled} />
      <ParamField label="Prompt Guidance Rescale" value={ov.cfg_rescale} onChange={(v) => setOv({ cfg_rescale: v })}
        type="float" step={0.01} disabled={disabled} />
      <ParamField label="采样器" value={ov.sampler} onChange={(v) => setOv({ sampler: v })}
        choices={SAMPLER_CHOICES} type="select" disabled={disabled} />
      <ParamField label="噪音调度" value={ov.noise_schedule} onChange={(v) => setOv({ noise_schedule: v })}
        choices={NOISE_SCHEDULE_CHOICES} type="select" disabled={disabled} />
      <ParamField label="Variety+" value={ov.variety_plus} onChange={(v) => setOv({ variety_plus: v })}
        type="bool" disabled={disabled} />
      <ParamField label="由 AI 选择角色位置" value={ov.auto_position} onChange={(v) => setOv({ auto_position: v })}
        type="bool" disabled={disabled} />
      <ParamField label="Legacy 模式" value={ov.legacy} onChange={(v) => setOv({ legacy: v })}
        type="bool" disabled={disabled} />
      <ParamField label="Seed（留空=每次随机）" value={ov.seed} onChange={(v) => setOv({ seed: v })}
        type="number" disabled={disabled} />
      <ParamField label="反向提示词" value={ov.negative_prompt} onChange={(v) => setOv({ negative_prompt: v })}
        type="textarea" disabled={disabled} />
    </div>
  )
}

// ── 全局默认参数编辑器（乐观更新 + 自动保存） ──
function ParamsEditor({
  params, sizePresets,
  onChangeParam, onChangePresets,
}: {
  params: Partial<NaiParams>
  sizePresets: SizePreset[]
  onChangeParam: <K extends keyof NaiParams>(k: K, v: NaiParams[K] | undefined) => void
  onChangePresets: (presets: SizePreset[]) => void
}) {
  const [newW, setNewW] = useState('')
  const [newH, setNewH] = useState('')

  // 合并内置 + 用户自定义（按 width/height 去重，builtin 优先）
  const userPresets = (sizePresets || []).filter(p =>
    !BUILTIN_PRESETS.some(b => b.width === p.width && b.height === p.height)
  )
  const allPresets: SizePreset[] = [...BUILTIN_PRESETS, ...userPresets.map(p => ({ ...p, builtin: false }))]

  const applyPreset = (p: SizePreset) => {
    onChangeParam('width', p.width)
    onChangeParam('height', p.height)
  }
  const removeUserPreset = (preset: SizePreset) => {
    const next = userPresets.filter(p => !(p.width === preset.width && p.height === preset.height))
    onChangePresets(next)
  }
  const addPreset = () => {
    const w = parseInt(newW)
    const h = parseInt(newH)
    if (!w || !h || w < 64 || h < 64) return
    if (allPresets.some(p => p.width === w && p.height === h)) { setNewW(''); setNewH(''); return }
    const next = [...userPresets, { label: `${w} × ${h}`, width: w, height: h }]
    onChangePresets(next)
    setNewW(''); setNewH('')
  }

  const currentSizeMatch = allPresets.find(p => p.width === params.width && p.height === params.height)

  return (
    <div className="nai-params-editor">
      <ParamField label="模型" value={params.model} onChange={(v) => onChangeParam('model', v as string)}
        choices={MODEL_CHOICES} type="select" hideClear />

      {/* 图像尺寸 */}
      <div className="nai-param-field">
        <label className="nai-param-label">图像尺寸（宽 × 高）</label>
        <div className="nai-param-control nai-size-control">
          <div className="nai-size-current">
            当前: <strong>{params.width || '-'} × {params.height || '-'}</strong>
            {currentSizeMatch && <span className="nai-size-tag">{currentSizeMatch.label}</span>}
          </div>
          <div className="nai-size-presets">
            {allPresets.map((p) => (
              <span key={`${p.width}x${p.height}`}
                className={`nai-size-chip ${p.builtin ? 'builtin' : ''} ${params.width === p.width && params.height === p.height ? 'active' : ''}`}>
                <button className="nai-size-chip-main" onClick={() => applyPreset(p)}>
                  {p.label}{p.builtin && ' 🔒'}
                </button>
                {!p.builtin && (
                  <button className="nai-size-chip-del" onClick={() => removeUserPreset(p)} title="删除自定义 preset">×</button>
                )}
              </span>
            ))}
          </div>
          <div className="nai-size-manual">
            <input type="number" placeholder="宽" value={newW}
              onChange={e => setNewW(e.target.value)} style={{ width: 70 }} />
            <span>×</span>
            <input type="number" placeholder="高" value={newH}
              onChange={e => setNewH(e.target.value)} style={{ width: 70 }} />
            <button className="btn-icon" onClick={addPreset} disabled={!newW || !newH} title="添加 preset">+</button>
          </div>
          <div className="nai-size-direct">
            <label>手动:
              <input type="number" value={params.width ?? ''} onChange={e => onChangeParam('width', parseInt(e.target.value) || undefined)} style={{ width: 80 }} />
              ×
              <input type="number" value={params.height ?? ''} onChange={e => onChangeParam('height', parseInt(e.target.value) || undefined)} style={{ width: 80 }} />
            </label>
          </div>
        </div>
      </div>

      <ParamField label="采样步数" value={params.steps} onChange={(v) => onChangeParam('steps', v as number)}
        type="number" min={1} max={50} hideClear />
      <ParamField label="Prompt Guidance" value={params.scale} onChange={(v) => onChangeParam('scale', v as number)}
        type="float" step={0.1} hideClear />
      <ParamField label="Prompt Guidance Rescale" value={params.cfg_rescale} onChange={(v) => onChangeParam('cfg_rescale', v as number)}
        type="float" step={0.01} hideClear />
      <ParamField label="采样器" value={params.sampler} onChange={(v) => onChangeParam('sampler', v as string)}
        choices={SAMPLER_CHOICES} type="select" hideClear />
      <ParamField label="噪音调度" value={params.noise_schedule} onChange={(v) => onChangeParam('noise_schedule', v as string)}
        choices={NOISE_SCHEDULE_CHOICES} type="select" hideClear />
      <ParamField label="Variety+" value={params.variety_plus} onChange={(v) => onChangeParam('variety_plus', v as boolean)}
        type="bool" hideClear />
      <ParamField label="由 AI 选择角色位置" value={params.auto_position} onChange={(v) => onChangeParam('auto_position', v as boolean)}
        type="bool" hideClear />
      <ParamField label="反向提示词" value={params.negative_prompt} onChange={(v) => onChangeParam('negative_prompt', v as string)}
        type="textarea" hideClear />

      <div className="nai-params-actions">
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          ✓ 改动自动保存（500ms 后写入 nai_config.json），立即生效
        </span>
      </div>
    </div>
  )
}

// 把 config.default_base_blocks 规整为数组（兼容旧 Record 格式）
function normalizeDefaultBlocks(input: DefaultBaseBlock[] | Record<string, string> | undefined): DefaultBaseBlock[] {
  if (Array.isArray(input)) return input
  if (input && typeof input === 'object') {
    return BLOCK_ORDER.map(b => ({
      name: BLOCK_LABELS[b],
      text: input[b] || '',
      enabled: !!(input[b] || '').trim(),
      isPrivate: b === 'sub_style' ? true : undefined,
    }))
  }
  return []
}

// ── 独立的默认基础提示词编辑器（数组结构：支持任意 name 的 block） ──
function DefaultBlocksEditor({ defaultBaseBlocks, onChange }: {
  defaultBaseBlocks: DefaultBaseBlock[]
  onChange: (next: DefaultBaseBlock[]) => void
}) {
  const update = (idx: number, patch: Partial<DefaultBaseBlock>) => {
    const next = defaultBaseBlocks.map((b, i) => i === idx ? { ...b, ...patch } : b)
    onChange(next)
  }
  const remove = (idx: number) => {
    if (!confirm(`删除「${defaultBaseBlocks[idx]?.name}」？`)) return
    onChange(defaultBaseBlocks.filter((_, i) => i !== idx))
  }
  const move = (idx: number, dir: 'up' | 'down') => {
    const target = dir === 'up' ? idx - 1 : idx + 1
    if (target < 0 || target >= defaultBaseBlocks.length) return
    const next = [...defaultBaseBlocks]
    ;[next[idx], next[target]] = [next[target], next[idx]]
    onChange(next)
  }
  const add = () => {
    onChange([...defaultBaseBlocks, { name: '新区块', text: '', enabled: false }])
  }
  return (
    <div className="nai-params-editor">
      <p className="nai-section-hint">新建任务时，下列每个 enabled 区块会自动填入对应位置。可任意改名（如"画师串"）/ 增删 / 重排。改动立即生效。</p>
      <div className="nai-default-blocks">
        {defaultBaseBlocks.map((b, i) => (
          <div className="nai-default-blocks-row" key={i} style={{ display: 'grid', gridTemplateColumns: 'auto 140px 1fr auto', gap: 6, alignItems: 'start' }}>
            <input type="checkbox" checked={!!b.enabled}
              onChange={e => update(i, { enabled: e.target.checked })}
              title="是否默认启用" />
            <input type="text" value={b.name}
              onChange={e => update(i, { name: e.target.value })}
              placeholder="区块名" />
            <AutoGrowTextarea value={b.text}
              onChange={v => update(i, { text: v })}
              minRows={1} placeholder="留空则该区块为空" />
            <div style={{ display: 'flex', gap: 4 }}>
              <button className="btn btn-secondary btn-small" onClick={() => move(i, 'up')} disabled={i === 0} title="上移">↑</button>
              <button className="btn btn-secondary btn-small" onClick={() => move(i, 'down')} disabled={i === defaultBaseBlocks.length - 1} title="下移">↓</button>
              <button className="btn btn-secondary btn-small" onClick={() => remove(i)} title="删除">×</button>
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 8 }}>
        <button className="btn btn-secondary btn-small" onClick={add}>+ 新增区块</button>
      </div>
    </div>
  )
}

// ── 加装预设编辑器（统一：提示词加装 base + 多角色 + 角色参考 + 替换；可命名存/切换/新建）──
// fetch/save /api/nai/aug-presets。隐私内容按预设 ID 命名空间存 private_blocks.json（AI 不读）。
// 参考加装基础形状（无 id·CharLayer 单参考沿用）；AugCharRef=预设多参考条目（带 id，隐私多键/列表 key 靠它）
type AugCharRefBase = {
  enabled: boolean
  isPrivate: boolean
  strength: number
  fidelity: number
  base_caption: CharRefMode
  fileName?: string
  image_b64: string
  role?: AugRole
  roleLabel?: string
}
type AugCharRef = AugCharRefBase & { id: string }
type AugBaseBlock = { text: string; enabled: boolean; isPrivate: boolean; position: 'prefix' | 'suffix'; role: AugRole; roleLabel?: string }
type AugChar = {
  id: string; name: string; enabled: boolean; isPrivate: boolean
  text: string; negative: string; position: 'prefix' | 'suffix'
  x: number; y: number; char_index: number
  role: AugRole; roleLabel?: string
  extras: AugExtraBlock[]                  // 该角色的额外效果框（拼进同一角色槽，正/负按 kind）
}
type AugPreset = {
  id: string; name: string; enabled: boolean
  group?: string                          // 预设分组（chip 拉选按此分组、可拖动改组/排序）
  base_positive: AugBaseBlock; base_negative: AugBaseBlock
  extra_blocks: AugExtraBlock[]           // 提示词加装的追加框（正/负各若干，各带归属）
  chars: AugChar[]
  char_references: AugCharRef[]           // 参考加装（多张·role/cast 门控挑张；NAI 多图=整图 blend 非逐槽绑定；~5 Anlas/张叠加）
  replacements: { enabled: boolean; rules: ReplRule[] }
}
type PresetsData = { activeId: string; presets: AugPreset[] }

function genId(prefix: string): string {
  try { if (crypto?.randomUUID) return prefix + crypto.randomUUID() } catch { /* noop */ }
  return prefix + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
}
const defaultBase = (): AugBaseBlock => ({ text: '', enabled: false, isPrivate: true, position: 'suffix', role: 'main' })
const defaultCharRef = (): AugCharRefBase => ({ enabled: false, isPrivate: true, strength: 1.0, fidelity: 1.0, base_caption: 'character', fileName: '', image_b64: '', role: 'main' })
const newAugCharRef = (): AugCharRef => ({ ...defaultCharRef(), id: genId('cr_') })
// role→char_index 派生：cast 落槽为"出场女主紧凑落前、女角排最前"，此处按归属给个稳妥序号(仅存不消费；运行时消费属跑图接口)
const roleToCharIndex = (role: AugRole): number => (role === 'f2' ? 2 : role === 'other' ? 3 : 1)
function newAugChar(idx: number): AugChar {
  // 新增框默认「主要」(备注：加装层默认新增都是主要)；女1/女2 由用户手动切
  return { id: genId('ac_'), name: `角色${idx}`, enabled: true, isPrivate: true, text: '', negative: '', position: 'suffix', x: 0.5, y: 0.5, char_index: 1, role: 'main', extras: [] }
}
function newExtraBlock(kind: 'positive' | 'negative'): AugExtraBlock {
  return { id: genId('eb_'), kind, text: '', role: 'main', position: 'suffix', isPrivate: true, enabled: true }
}
// 归一化额外框（提示词加装 / 角色额外框共用）：补齐字段、role 兜底 main
function normExtra(b: Partial<AugExtraBlock>): AugExtraBlock {
  return { ...newExtraBlock(b.kind === 'negative' ? 'negative' : 'positive'), ...b, role: b.role || 'main' } as AugExtraBlock
}
function newPreset(name: string): AugPreset {
  return { id: genId('p_'), name, enabled: true, group: '', base_positive: defaultBase(), base_negative: defaultBase(), extra_blocks: [], chars: [], char_references: [], replacements: { enabled: true, rules: [] } }
}
// 参考加装迁移（读旧写新·2026-07-12 多参考化）：旧单 char_reference → 单元素 char_references；
// 纯默认空壳（没图没启用没文件名）直接丢弃不生成无用行。save 只写 char_references（不双写旧键）。
function normCharRefs(p: Partial<AugPreset> & { char_reference?: Partial<AugCharRefBase> & { id?: string } }): AugCharRef[] {
  const list: Array<Partial<AugCharRefBase> & { id?: string }> =
    Array.isArray(p.char_references) ? p.char_references
      : (p.char_reference && typeof p.char_reference === 'object'
          && (p.char_reference.enabled || p.char_reference.image_b64 || p.char_reference.fileName)
          ? [p.char_reference] : [])
  return list.map(cr => ({ ...newAugCharRef(), ...cr, id: cr.id || genId('cr_'), role: cr.role || 'main' }))
}
// 防御性归一化：补齐缺失字段（旧数据 / 手改 config 的兜底）
// ★role 兜底：旧数据无 role → 一律 'main'(主要=无条件always装)，故「没更新好的加装层按旧逻辑只走主要」自动成立
function normalizePreset(p: Partial<AugPreset>): AugPreset {
  const repl = p.replacements
  const withRole = <T extends { role?: AugRole }>(o: T): T => ({ ...o, role: o.role || 'main' })
  return {
    id: p.id || genId('p_'),
    name: p.name || '未命名',
    enabled: p.enabled !== false,
    group: typeof p.group === 'string' ? p.group : '',
    base_positive: withRole({ ...defaultBase(), ...(p.base_positive || {}) }),
    base_negative: withRole({ ...defaultBase(), ...(p.base_negative || {}) }),
    extra_blocks: (Array.isArray(p.extra_blocks) ? p.extra_blocks : []).map(normExtra),
    chars: (Array.isArray(p.chars) ? p.chars : []).map(c => ({
      ...withRole(c), extras: (Array.isArray(c.extras) ? c.extras : []).map(normExtra),
    })),
    char_references: normCharRefs(p),
    replacements: {
      enabled: repl?.enabled !== false,
      rules: (Array.isArray(repl?.rules) ? repl!.rules : []).map(r => ({ ...r, role: r.role || 'main' })),
    },
  }
}

// ── 加装层本地草稿（localStorage）：编辑实时镜像，关页面/切走/写盘失败都不丢；点「保存到本地」才正式写盘文件并清草稿 ──
const AUG_DRAFT_KEY = 'owner:augpreset:draft'
function readAugDraft(): PresetsData | null {
  try {
    const raw = localStorage.getItem(AUG_DRAFT_KEY)
    if (!raw) return null
    const obj = JSON.parse(raw)
    if (obj && Array.isArray(obj.presets) && obj.presets.length) return obj as PresetsData
  } catch { /* localStorage 不可用 / 解析失败 */ }
  return null
}
function writeAugDraft(d: PresetsData) {
  try { localStorage.setItem(AUG_DRAFT_KEY, JSON.stringify(d)) }
  catch { /* 配额满 / 不可用：忽略，仍有「保存到本地」按钮写盘兜底 */ }
}
function clearAugDraft() {
  try { localStorage.removeItem(AUG_DRAFT_KEY) } catch { /* ignore */ }
}
function nowClock(): string {
  const d = new Date(); const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
function normalizePresetsData(d: PresetsData): PresetsData {
  const presets = (Array.isArray(d.presets) && d.presets.length ? d.presets : [newPreset('默认')]).map(normalizePreset)
  return { activeId: presets.some(p => p.id === d.activeId) ? d.activeId : presets[0].id, presets }
}

// ── 拖拽排序（镜像懒狗库 LazyBrowser 的原生 HTML5 落点式排序）──
// 落点统一语义：把 moved 插到 beforeId【之前】；beforeId=null/'__end__' 即末尾。
function augPlaceBefore<T extends { id: string }>(list: T[], moved: T, beforeId: string | null): T[] {
  const reduced = list.filter(x => x.id !== moved.id)
  if (!beforeId || beforeId === '__end__') return [...reduced, moved]
  const at = reduced.findIndex(x => x.id === beforeId)
  if (at < 0) return [...reduced, moved]
  reduced.splice(at, 0, moved)
  return reduced
}
// 拖拽中的实时预览顺序（本列表无被拖项=跨组拖，不预览）
function augPreviewList<T extends { id: string }>(list: T[], movedId: string | null, beforeId: string | null): T[] {
  if (!movedId || !beforeId) return list
  const moved = list.find(x => x.id === movedId); if (!moved) return list
  return augPlaceBefore(list, moved, beforeId)
}
// 按光标位置在容器内算落点：返回应插到其【之前】的 id（data-augid）；越过全部=末尾('__end__')。单一中线阈值→不抖动、往回移自然回原序。
function augPickBefore(container: HTMLElement, x: number, y: number, movedId: string | null): string | '__end__' {
  const cards = Array.from(container.querySelectorAll<HTMLElement>('[data-augid]'))
  for (const el of cards) {
    const id = el.dataset.augid
    if (!id || id === movedId) continue
    const r = el.getBoundingClientRect()
    const after = y >= r.bottom ? true : y < r.top ? false : x > r.left + r.width / 2
    if (!after) return id
  }
  return '__end__'
}

// ── 归属/门控标签选择器（主要 / 女1 / 女2 / 其他）──
// 每个内容单元一枚：决定该内容在哪种 cast(本图出场女主) 下激活。语义见 types AugRole。
const AUG_ROLE_OPTS: { v: AugRole; label: string; hint: string }[] = [
  { v: 'main', label: '主要', hint: '无条件 always 装（默认/旧行为）' },
  { v: 'f1', label: '女1', hint: '仅女1出现在本图时装' },
  { v: 'f2', label: '女2', hint: '仅女2出现在本图时装' },
  { v: 'other', label: '其他', hint: '女3+ 手写标签，默认不装、需点名' },
]
function RoleSelect({ role, roleLabel, onRole, onLabel, compact }: {
  role: AugRole; roleLabel?: string
  onRole: (r: AugRole) => void; onLabel?: (s: string) => void; compact?: boolean
}) {
  return (
    <span className="aug-role-seg" title="归属：这块内容归谁 / 何时激活">
      {AUG_ROLE_OPTS.map(o => (
        <button key={o.v} type="button" className={`aug-role-opt${role === o.v ? ' active' : ''} r-${o.v}`}
          onClick={() => onRole(o.v)} title={o.hint}>{o.label}</button>
      ))}
      {role === 'other' && onLabel && (
        <input className="aug-role-label" value={roleLabel || ''} onChange={e => onLabel(e.target.value)}
          placeholder={compact ? '标签' : '手写标签（如 女3，让 AI 认得）'} title="手写标签，让 AI 知道这是女3还是什么" />
      )}
    </span>
  )
}

function AugPresetEditor() {
  const [data, setData] = useState<PresetsData | null>(null)
  const [dirty, setDirty] = useState(false)            // 内存/草稿 与 盘上文件不一致
  const [restored, setRestored] = useState(false)      // 本次是从未保存草稿恢复进来的
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveMsg, setSaveMsg] = useState('')
  const [posModalCharId, setPosModalCharId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)   // 正在拖动的预设 id
  const [over, setOver] = useState<string | null>(null)       // 拖拽落点：插到其之前的 id（'__end__'=末尾）
  const [refOpen, setRefOpen] = useState(true)                // ④参考加装 折叠态（备注：默认展开）
  // 自动保存（默认开·可关）：dirty 后空闲 1.2s 自动写盘。安全化重生——旧自动写盘因【静默吞错+共用private_blocks覆盖】反复丢，
  // 那俩根因已根治（persona 独立文件 + 合并写），本版=debounce + awaited + 失败有反馈 + localStorage 草稿兜底，不再静默丢。
  const [autoSave, setAutoSave] = useState<boolean>(() => { try { return localStorage.getItem('owner:augpreset:autosave') !== '0' } catch { return true } })
  const saveRef = useRef<() => void>(() => {})
  useEffect(() => { try { localStorage.setItem('owner:augpreset:autosave', autoSave ? '1' : '0') } catch { /* ignore */ } }, [autoSave])
  useEffect(() => {
    if (!autoSave || !dirty || saveState === 'saving') return
    // 【数据安全红线·2026-07-14 血的教训】restored=从 localStorage 旧草稿恢复的状态。此时用户【一个字都没改】，
    // 只是打开了页面。旧版在这里照样 autosave，等于用一份可能很陈旧的浏览器草稿【静默覆盖盘上真数据】——
    // 实测把 14 个预设冲成 3 个，且 private 文件不入 git、无版本可回滚，几乎不可挽回。
    // 草稿恢复态一律不自动写盘：要么用户点💾显式确认，要么点「从本地重读」丢弃草稿。首次显式保存后 restored 归 false，autosave 自动恢复。
    if (restored) return
    const t = setTimeout(() => saveRef.current(), 1200)
    return () => clearTimeout(t)
  }, [autoSave, dirty, saveState, data, restored])

  // 首次加载：拉服务端文件；若存在未保存草稿则优先恢复草稿（标脏 + 提示）
  useEffect(() => {
    let cancelled = false
    fetch('/api/nai/aug-presets')
      .then(r => r.json())
      .then((d: PresetsData) => {
        if (cancelled) return
        const draft = readAugDraft()
        if (draft) { setData(normalizePresetsData(draft)); setDirty(true); setRestored(true) }
        else { setData(normalizePresetsData(d)); setDirty(false) }
      })
      .catch(() => {
        if (cancelled) return
        const draft = readAugDraft()
        if (draft) { setData(normalizePresetsData(draft)); setDirty(true); setRestored(true) }
        else { const p = newPreset('默认'); setData({ activeId: p.id, presets: [p] }) }
      })
    return () => { cancelled = true }
  }, [])

  // 保存到本地：awaited 写盘（公开→nai_config.json，隐私→private_blocks.json），成功后清草稿
  const saveToLocal = async () => {
    if (!data) return
    setSaveState('saving'); setSaveMsg('')
    try {
      const res = await fetch('/api/nai/aug-presets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || (j && j.error)) throw new Error((j && j.error) || `HTTP ${res.status}`)
      clearAugDraft(); setDirty(false); setRestored(false)
      setSaveState('saved'); setSaveMsg(nowClock())
    } catch (e) {
      setSaveState('error'); setSaveMsg(e instanceof Error ? e.message : String(e))
    }
  }
  saveRef.current = saveToLocal   // 供自动保存 debounce 调用最新闭包（含最新 data）

  // 从本地文件重读（丢弃内存/草稿，回到盘上真相）；可选切到某预设
  const reloadFromLocal = async (targetActiveId?: string) => {
    const res = await fetch('/api/nai/aug-presets')
    const server = normalizePresetsData(await res.json())
    const next = targetActiveId && server.presets.some(p => p.id === targetActiveId)
      ? { ...server, activeId: targetActiveId } : server
    setData(next); clearAugDraft(); setDirty(false); setRestored(false); setSaveState('idle'); setSaveMsg('')
  }

  if (!data) return <div className="nai-params-editor"><p className="nai-section-hint">加载中…</p></div>

  const active = data.presets.find(p => p.id === data.activeId) || data.presets[0]
  // 每次编辑：更新内存 + 同步镜像到 localStorage 草稿 + 标脏（不写盘，写盘只在点按钮时）
  const commit = (next: PresetsData) => {
    setData(next); writeAugDraft(next); setDirty(true)
    if (saveState !== 'idle') { setSaveState('idle'); setSaveMsg('') }
  }
  const patchActive = (patch: Partial<AugPreset>) =>
    commit({ ...data, presets: data.presets.map(p => p.id === active.id ? { ...p, ...patch } : p) })

  // 预设操作。切换：干净时从本地文件重读后切到该预设（看到盘上真相）；有未保存修改时留内存切换（避免丢失）
  const switchPreset = (id: string) => {
    if (id === active.id) return
    if (dirty) commit({ ...data, activeId: id })
    else reloadFromLocal(id).catch(() => commit({ ...data, activeId: id }))
  }
  // 新建 = 克隆当前默认预设（active，Owner：新建都是默认加装层的复制粘贴），非空白
  const cloneOf = (src: AugPreset, name: string): AugPreset => ({
    ...src, id: genId('p_'), name,
    base_positive: { ...src.base_positive }, base_negative: { ...src.base_negative },
    extra_blocks: src.extra_blocks.map(b => ({ ...b, id: genId('eb_') })),
    chars: src.chars.map(c => ({ ...c, id: genId('ac_'), extras: (c.extras || []).map(e => ({ ...e, id: genId('eb_') })) })),
    char_references: src.char_references.map(r => ({ ...r, id: genId('cr_') })),   // 换新 id 防隐私 blob 串号
    replacements: { ...src.replacements, rules: src.replacements.rules.map(r => ({ ...r, id: genId('r_') })) },
  })
  const addPreset = () => { const p = cloneOf(active, `预设${data.presets.length + 1}`); commit({ activeId: p.id, presets: [...data.presets, p] }) }
  const duplicatePreset = () => {
    const copy = cloneOf(active, active.name + ' 副本')
    commit({ activeId: copy.id, presets: [...data.presets, copy] })
  }
  const renamePreset = () => { const n = window.prompt('预设名称', active.name); if (n && n.trim()) patchActive({ name: n.trim() }) }
  const deletePreset = () => {
    if (data.presets.length <= 1) return
    if (!window.confirm(`删除预设「${active.name}」？此操作不可撤销。`)) return
    const rest = data.presets.filter(p => p.id !== active.id)
    commit({ activeId: rest[0].id, presets: rest })
  }
  const setGroup = () => {
    const g = window.prompt('把当前预设放进哪个分组？（留空=未分组）', active.group || '')
    if (g !== null) commit({ ...data, presets: data.presets.map(p => p.id === active.id ? { ...p, group: g.trim() } : p) })
  }
  // 组标题重命名：改整组的 group 名（组可编辑）
  const renameGroup = (old: string) => {
    const g = window.prompt(`重命名分组「${old || '未分组'}」（留空=并入未分组）`, old)
    if (g === null || g.trim() === old) return
    commit({ ...data, presets: data.presets.map(p => (p.group || '') === old ? { ...p, group: g.trim() } : p) })
  }
  // 预设按 group 归并（保序）；'' = 未分组
  const groupOrder: string[] = []
  const grouped = new Map<string, AugPreset[]>()
  for (const p of data.presets) {
    const g = p.group || ''
    if (!grouped.has(g)) { grouped.set(g, []); groupOrder.push(g) }
    grouped.get(g)!.push(p)
  }
  const hasGroups = groupOrder.some(g => g !== '')
  // 分组自动配色（无需手设·自然区分）：按分组出现顺序从精选色相盘取，稳定且互相区分
  const GROUP_HUES = [265, 330, 205, 28, 150, 48, 300, 178, 95, 240]
  const nonEmptyGroups = groupOrder.filter(g => g !== '')
  const groupHue = (g: string): number | null => g ? GROUP_HUES[nonEmptyGroups.indexOf(g) % GROUP_HUES.length] : null
  // 拖拽排序（镜像懒狗库）：仅在【同一分组内】重排，任何拖拽都不改 group（备注：拖拽不导致组变化）。
  const dragGroup = dragId ? (data.presets.find(p => p.id === dragId)?.group || '') : null
  const arrange = (group: string, beforeId: string | null) => {
    if (!dragId || dragGroup !== group) { setDragId(null); setOver(null); return }  // 跨组忽略
    const sub = grouped.get(group) || []
    const moved = sub.find(p => p.id === dragId)
    if (!moved) { setDragId(null); setOver(null); return }
    const newSub = augPlaceBefore(sub, moved, beforeId)                // 组内新序，group 不变
    const flat = groupOrder.flatMap(g => g === group ? newSub : (grouped.get(g) || []))
    commit({ ...data, presets: flat }); setDragId(null); setOver(null)
  }

  // 子项编辑
  const patchBase = (key: 'base_positive' | 'base_negative', p: Partial<AugBaseBlock>) =>
    patchActive({ [key]: { ...active[key], ...p } } as Partial<AugPreset>)
  const patchChar = (id: string, p: Partial<AugChar>) => patchActive({ chars: active.chars.map(c => c.id === id ? { ...c, ...p } : c) })
  const addChar = () => patchActive({ chars: [...active.chars, newAugChar(active.chars.length + 1)] })
  const removeChar = (id: string) => patchActive({ chars: active.chars.filter(c => c.id !== id) })
  // 参考加装（多张）：按 id 逐张编辑/增删
  const patchCharRefAt = (id: string, p: Partial<AugCharRefBase>) =>
    patchActive({ char_references: active.char_references.map(r => r.id === id ? { ...r, ...p } : r) })
  const addCharRef = () => patchActive({ char_references: [...active.char_references, newAugCharRef()] })
  const removeCharRef = (id: string) => patchActive({ char_references: active.char_references.filter(r => r.id !== id) })
  const patchRepl = (p: Partial<AugPreset['replacements']>) => patchActive({ replacements: { ...active.replacements, ...p } })
  const updateRule = (id: string, p: Partial<ReplRule>) => patchRepl({ rules: active.replacements.rules.map(r => r.id === id ? { ...r, ...p } : r) })
  const addRule = () => patchRepl({ rules: [...active.replacements.rules, { id: genId('r_'), from: '', to: '', enabled: true, wholeWord: true, isPrivate: true, role: 'main' }] })
  const removeRule = (id: string) => patchRepl({ rules: active.replacements.rules.filter(r => r.id !== id) })
  // 角色归属切换：同步派生 char_index（女2→2、其他→3、主要/女1→1；仅存不消费）
  const setCharRole = (id: string, role: AugRole) => patchChar(id, { role, char_index: roleToCharIndex(role) })
  // 提示词加装·额外框
  const addExtra = (kind: 'positive' | 'negative') => patchActive({ extra_blocks: [...active.extra_blocks, newExtraBlock(kind)] })
  const patchExtra = (id: string, p: Partial<AugExtraBlock>) => patchActive({ extra_blocks: active.extra_blocks.map(b => b.id === id ? { ...b, ...p } : b) })
  const removeExtra = (id: string) => patchActive({ extra_blocks: active.extra_blocks.filter(b => b.id !== id) })
  // 角色额外框（其他效果，拼进同一角色槽）
  const addCharExtra = (cid: string, kind: 'positive' | 'negative') => patchChar(cid, { extras: [...(active.chars.find(c => c.id === cid)?.extras || []), newExtraBlock(kind)] })
  const patchCharExtra = (cid: string, eid: string, p: Partial<AugExtraBlock>) => {
    const c = active.chars.find(x => x.id === cid); if (!c) return
    patchChar(cid, { extras: c.extras.map(e => e.id === eid ? { ...e, ...p } : e) })
  }
  const removeCharExtra = (cid: string, eid: string) => {
    const c = active.chars.find(x => x.id === cid); if (!c) return
    patchChar(cid, { extras: c.extras.filter(e => e.id !== eid) })
  }

  const dim = { opacity: active.enabled ? 1 : 0.5, pointerEvents: active.enabled ? 'auto' as const : 'none' as const }
  // 一套预设涉及哪些女主 cast（用于顶部摘要提示）
  const usedRoles = new Set<AugRole>([
    active.base_positive, active.base_negative, ...active.char_references,
    ...active.extra_blocks, ...active.chars, ...active.replacements.rules,
  ].map(u => (u as { role?: AugRole }).role || 'main'))
  const castSummary = (['f1', 'f2', 'other'] as AugRole[]).filter(r => usedRoles.has(r))
    .map(r => AUG_ROLE_OPTS.find(o => o.v === r)!.label)

  // 区块卡片外壳（四区块统一外观）— 纯函数返回 JSX，避免 render 内组件重挂载导致 textarea 掉焦
  const blockCard = (n: string, title: string, hint: string, children: ReactNode) => (
    <div className="aug-block-card">
      <div className="aug-block-head"><span className="aug-block-n">{n}</span><b>{title}</b><span className="aug-block-hint">{hint}</span></div>
      {children}
    </div>
  )

  const renderBase = (key: 'base_positive' | 'base_negative', label: string) => {
    const b = active[key]
    return (
      <div className="aug-unit-row">
        <input type="checkbox" checked={b.enabled} onChange={e => patchBase(key, { enabled: e.target.checked })} title="启用此块" />
        <span className="aug-unit-label">{label}</span>
        <AutoGrowTextarea value={b.text} onChange={v => patchBase(key, { text: v })} minRows={1}
          placeholder={b.isPrivate ? '隐私内容（存 nai_augment_private.json，AI 不读）' : '留空则不加装'} />
        <RoleSelect role={b.role} roleLabel={b.roleLabel} onRole={r => patchBase(key, { role: r })} onLabel={s => patchBase(key, { roleLabel: s })} compact />
        <select value={b.position} onChange={e => patchBase(key, { position: e.target.value as 'prefix' | 'suffix' })} title="加在 prompt 前还是后">
          <option value="prefix">前缀</option>
          <option value="suffix">后缀</option>
        </select>
        <button className={`assembly-privacy-toggle ${b.isPrivate ? 'locked' : ''}`} onClick={() => patchBase(key, { isPrivate: !b.isPrivate })}
          title={b.isPrivate ? '隐私（AI 不可见）— 点击转公开' : '公开（AI 可见）— 点击转隐私'}>
          {b.isPrivate ? '隐私' : '公开'}
        </button>
      </div>
    )
  }

  // 通用额外框行（提示词加装 / 角色额外框共用；差异只在 onPatch/onRemove 回调）
  const extraRow = (b: AugExtraBlock, onPatch: (p: Partial<AugExtraBlock>) => void, onRemove: () => void) => (
    <div className={`aug-unit-row aug-extra-row r-${b.role}`} key={b.id}>
      <input type="checkbox" checked={b.enabled} onChange={e => onPatch({ enabled: e.target.checked })} title="启用此额外框" />
      <AutoGrowTextarea value={b.text} onChange={v => onPatch({ text: v })} minRows={1}
        placeholder={b.isPrivate ? `隐私${b.kind === 'negative' ? '负' : '正'}面词（额外框）` : `${b.kind === 'negative' ? '负' : '正'}面词（额外框）`} />
      <RoleSelect role={b.role} roleLabel={b.roleLabel} onRole={r => onPatch({ role: r })} onLabel={s => onPatch({ roleLabel: s })} compact />
      <select value={b.position} onChange={e => onPatch({ position: e.target.value as 'prefix' | 'suffix' })} title="加在 prompt 前还是后">
        <option value="prefix">前缀</option>
        <option value="suffix">后缀</option>
      </select>
      <button className={`assembly-privacy-toggle ${b.isPrivate ? 'locked' : ''}`} onClick={() => onPatch({ isPrivate: !b.isPrivate })}
        title={b.isPrivate ? '隐私（AI 不可见）— 点击转公开' : '公开（AI 可见）— 点击转隐私'}>
        {b.isPrivate ? '隐私' : '公开'}
      </button>
      <button className="btn btn-secondary btn-small aug-extra-del" onClick={onRemove} title="删除此额外框">×</button>
    </div>
  )
  const renderExtra = (b: AugExtraBlock) => extraRow(b, p => patchExtra(b.id, p), () => removeExtra(b.id))
  const extraPos = active.extra_blocks.filter(b => b.kind === 'positive')
  const extraNeg = active.extra_blocks.filter(b => b.kind === 'negative')

  // ── 提示词加装 区块内容 ──
  const promptBlock = (
    <div className="nai-default-blocks">
      {renderBase('base_positive', '正面词')}
      {extraPos.map(renderExtra)}
      <button className="btn btn-secondary btn-small aug-add-extra" onClick={() => addExtra('positive')} title="给正面词加一个额外框（可单独设归属，给女2/特殊留空间）">+ 加正面框</button>
      {renderBase('base_negative', '负面词')}
      {extraNeg.map(renderExtra)}
      <button className="btn btn-secondary btn-small aug-add-extra" onClick={() => addExtra('negative')} title="给负面词加一个额外框">+ 加负面框</button>
    </div>
  )

  // ── 角色加装 区块内容 ──
  const charBlock = (
    <div className="nai-default-blocks">
      {active.chars.length === 0 && <p className="nai-section-hint">（暂无角色，点下方「+ 增加角色」）</p>}
      {active.chars.map(c => (
        <div key={c.id} className={`aug-char-card r-${c.role}`}>
          <div className="aug-char-head">
            <input type="checkbox" checked={c.enabled} onChange={e => patchChar(c.id, { enabled: e.target.checked })} title="启用此角色" />
            <input className="aug-char-name" value={c.name} onChange={e => patchChar(c.id, { name: e.target.value })} placeholder="角色名" />
            <RoleSelect role={c.role} roleLabel={c.roleLabel} onRole={r => setCharRole(c.id, r)} onLabel={s => patchChar(c.id, { roleLabel: s })} />
            <button className={`assembly-privacy-toggle ${c.isPrivate ? 'locked' : ''}`} onClick={() => patchChar(c.id, { isPrivate: !c.isPrivate })}
              title={c.isPrivate ? '隐私（AI 不可见）— 点击转公开' : '公开（AI 可见）— 点击转隐私'}>
              {c.isPrivate ? '隐私' : '公开'}
            </button>
            <button className="btn btn-secondary btn-small aug-char-pos" onClick={() => setPosModalCharId(c.id)}
              title={`无现成角色时新建落位（x=${c.x}, y=${c.y}）`}>📍</button>
            <select value={c.position} onChange={e => patchChar(c.id, { position: e.target.value as 'prefix' | 'suffix' })} title="拼在角色 prompt 前/后">
              <option value="prefix">前缀</option>
              <option value="suffix">后缀</option>
            </select>
            <button className="btn btn-secondary btn-small aug-char-del" onClick={() => removeChar(c.id)} title="删除此角色">×</button>
          </div>
          <div className="aug-char-body">
            <AutoGrowTextarea value={c.text} onChange={v => patchChar(c.id, { text: v })} minRows={1}
              placeholder={c.isPrivate ? '隐私正面词' : '角色正面词'} />
            <AutoGrowTextarea value={c.negative} onChange={v => patchChar(c.id, { negative: v })} minRows={1}
              placeholder={c.isPrivate ? '隐私负面词' : '角色负面词'} />
          </div>
          {/* 角色额外框：其他效果，拼进本角色同一槽（正/负按 kind）；各带独立归属 */}
          {(c.extras || []).length > 0 && (
            <div className="aug-char-extras">
              {c.extras.map(e => extraRow(e, p => patchCharExtra(c.id, e.id, p), () => removeCharExtra(c.id, e.id)))}
            </div>
          )}
          <div className="aug-char-extra-add">
            <button className="btn btn-secondary btn-small" onClick={() => addCharExtra(c.id, 'positive')} title="给本角色加一个正面效果框（拼进同一角色槽，可单独设归属）">+ 效果·正</button>
            <button className="btn btn-secondary btn-small" onClick={() => addCharExtra(c.id, 'negative')} title="给本角色加一个负面效果框">+ 效果·负</button>
          </div>
        </div>
      ))}
      <button className="btn btn-secondary btn-small" onClick={addChar}>+ 增加角色</button>
    </div>
  )

  const modalChar = posModalCharId ? active.chars.find(c => c.id === posModalCharId) : null

  return (
    <div className="nai-params-editor">
      <p className="nai-section-hint">
        一套预设 = <b>① 角色加装 · ② 提示词加装 · ③ 关键词替换 · ④ 参考加装</b>，整套一起存/切换。
        每个输入框可挂<b>归属标签（主要/女1/女2/其他）</b>：<b>主要</b>=无条件always装（默认/旧行为）；<b>女1·女2</b>=仅该女出现在本图时装，出场女主自动紧凑落槽、女角排最前。同时要「主要」又要「特殊」时，点框下的 <b>+加框</b> 给特殊留空间。
        带 <b>★</b> 的是<b>默认加装预设</b>——「走加装层」不指定就套它；chip 可<b>拖动</b>排序/改组。
        仅 <b>AI 对话批量跑图</b>（bare CLI / json-stdin 显式 --augment）套用默认预设，webapp 队列、scenario 不套。勾「隐私」的内容存 nai_augment_private.json，AI 不读。
        编辑实时进<b>浏览器本地草稿</b>；点 <b>💾 保存到本地</b> 才写盘（跑图读的是写盘后的值）。
      </p>

      {/* 预设拉选：chip 卡片，★=默认加装预设（activeId）。按 group 分组；拖动=组内排序（懒狗式落点预览），拖拽不改组，组名点标题可改 */}
      <div className="aug-preset-wrap">
        {groupOrder.map(g => (
          <div key={g || '__ungrouped'} className={'aug-preset-group' + (g ? ' colored' : '')}
            style={g ? ({ ['--g-hue']: String(groupHue(g)) } as CSSProperties) : undefined}>
            {hasGroups && (
              <span className="aug-preset-glabel" onClick={() => renameGroup(g)} title="点击重命名此分组（组可编辑）">
                {g || '未分组'} <span className="aug-preset-gedit">✎</span>
              </span>
            )}
            <div className={'aug-preset-picker' + (dragGroup === g ? ' dropzone' : '')}
              onDragOver={e => { if (dragId && dragGroup === g) { e.preventDefault(); setOver(augPickBefore(e.currentTarget, e.clientX, e.clientY, dragId)) } }}
              onDrop={e => { if (dragId && dragGroup === g) { e.preventDefault(); arrange(g, over === '__end__' ? null : over) } }}>
              {augPreviewList(grouped.get(g) || [], dragId, over).map(p => (
                <button key={p.id} type="button" draggable data-augid={p.id}
                  onDragStart={e => { setDragId(p.id); e.dataTransfer.effectAllowed = 'move' }}
                  onDragEnd={() => { setDragId(null); setOver(null) }}
                  className={`aug-preset-chip${p.id === active.id ? ' active' : ''}${p.enabled ? '' : ' disabled'}${dragId === p.id ? ' dragging' : ''}`}
                  onClick={() => switchPreset(p.id)}
                  title={p.id === active.id ? '当前默认加装预设（走加装层套它）· 拖动可在本组内排序' : `切到「${p.name}」并设为默认 · 拖动可在本组内排序`}>
                  <span className="aug-preset-star">{p.id === active.id ? '★' : '☆'}</span>
                  <span className="aug-preset-name">{p.name}</span>
                  {!p.enabled && <span className="aug-preset-off">停用</span>}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="aug-preset-actions">
          <button className="btn btn-secondary btn-small" onClick={addPreset} title="新建 = 克隆当前默认预设（不再是空白）">+ 新建（克隆默认）</button>
          <button className="btn btn-secondary btn-small" onClick={duplicatePreset} title="复制当前预设为副本">复制</button>
          <button className="btn btn-secondary btn-small" onClick={renamePreset}>重命名</button>
          <button className="btn btn-secondary btn-small" onClick={setGroup} title="把当前预设放进某分组（留空=未分组）；拖拽不改组，改组走这里">分组…</button>
          <button className="btn btn-secondary btn-small" onClick={deletePreset} disabled={data.presets.length <= 1}>删除</button>
        </div>
      </div>

      {/* 保存到本地栏（自动保存开时=空闲 1.2s 自动写盘；仍保留立即保存/重读兜底） */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <label className="aug-autosave-toggle" title="自动保存：编辑停 1.2 秒自动写盘（失败有红字提示、浏览器草稿始终兜底不丢）。关掉则回到纯手动，点「立即保存」才写盘">
          <input type="checkbox" checked={autoSave} onChange={e => setAutoSave(e.target.checked)} />
          <span>自动保存{autoSave ? '（开）' : '（关）'}</span>
        </label>
        <button className="btn btn-small" onClick={saveToLocal} disabled={saveState === 'saving'}
          style={{ background: dirty ? 'var(--warning, #e08a00)' : 'var(--success, #2e7d32)', color: '#fff', fontWeight: 600 }}
          title="立刻把整个加装层写入本地文件（公开→nai_config.json，隐私→nai_augment_private.json）。批量跑图读的就是这里">
          💾 {saveState === 'saving' ? '保存中…' : '立即保存'}{dirty ? ' ●' : ''}
        </button>
        <button className="btn btn-secondary btn-small" onClick={() => {
          if (dirty && !window.confirm('从本地文件重读会丢弃当前未保存的修改，确定？')) return
          reloadFromLocal().catch(() => { /* ignore */ })
        }} title="丢弃内存改动，从盘上文件重新载入">🔄 从本地重读</button>
        {saveState === 'saving'
          ? <span style={{ fontSize: 12, color: '#888' }}>保存中…</span>
          : dirty
            ? <span style={{ fontSize: 12, color: 'var(--warning, #e08a00)' }}>● 有改动{restored ? '（草稿恢复态·不会自动写盘，需点💾确认）' : autoSave ? '（稍后自动写盘…）' : '（跑图读盘上旧值，记得保存）'}</span>
            : saveState === 'saved'
              ? <span style={{ fontSize: 12, color: 'var(--success, #4caf50)' }}>✓ 已保存 {saveMsg}</span>
              : <span style={{ fontSize: 12, color: '#888' }}>已与本地文件一致</span>}
        {saveState === 'error' && <span style={{ fontSize: 12, color: 'var(--danger, #d33)' }}>✗ 保存失败：{saveMsg}（改动仍在浏览器草稿里，不会丢）</span>}
      </div>

      {restored && (
        <div style={{ fontSize: 12, color: 'var(--warning, #e08a00)', background: 'rgba(224,138,0,0.1)', border: '1px solid var(--warning, #e08a00)', borderRadius: 6, padding: '6px 10px', marginBottom: 8 }}>
          已从浏览器本地草稿恢复上次<b>未保存</b>的修改。确认无误后点「💾 保存到本地」正式写盘；想放弃改动点「🔄 从本地重读」。
        </div>
      )}

      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <input type="checkbox" checked={active.enabled} onChange={e => patchActive({ enabled: e.target.checked })} />
        <span>启用此预设（关闭则批量跑图不套任何加装/替换）</span>
      </label>

      {castSummary.length > 0 && (
        <div className="aug-cast-summary" title="本预设含条件内容：仅相应女主出现在本图时才装">
          本预设含条件内容：<b>{castSummary.join(' / ')}</b> 专属 —— 跑图按帧 cast（出场女主）自动装配：未出现的女主对应内容不装、出场女角紧凑落槽（CLI --swap-aw --augment 已生效）
        </div>
      )}

      <div style={dim}>
        {/* 顶部两栏：① 角色加装（左） | ② 提示词加装（右）；窄屏自动堆叠 */}
        <div className="aug-two-col">
          {blockCard('①', '角色加装', '每角色一枚归属（女1/女2…）；出场女主自动紧凑落槽、女角排最前', charBlock)}
          {blockCard('②', '提示词加装', 'base 正/负 + 额外框；特殊效果=带归属的普通正面词', promptBlock)}
        </div>

        {blockCard('③', '关键词替换', '在①②之后执行的最后一道全文替换', (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <input type="checkbox" checked={active.replacements.enabled} onChange={e => patchRepl({ enabled: e.target.checked })} />
              <span>启用替换规则</span>
            </label>
            <div className="nai-default-blocks" style={{ opacity: active.replacements.enabled ? 1 : 0.5, pointerEvents: active.replacements.enabled ? 'auto' : 'none' }}>
              {active.replacements.rules.length === 0 && <p className="nai-section-hint">（暂无规则）</p>}
              {active.replacements.rules.map(r => (
                <div className="aug-repl-row" key={r.id}>
                  <input type="checkbox" checked={r.enabled} onChange={e => updateRule(r.id, { enabled: e.target.checked })} title="启用此规则" />
                  <AutoGrowTextarea value={r.from} onChange={v => updateRule(r.id, { from: v })} minRows={1}
                    placeholder={r.isPrivate ? '隐私源词（每行一个）' : '源词（每行一个）'} />
                  <span className="aug-repl-arrow">→</span>
                  <AutoGrowTextarea value={r.to} onChange={v => updateRule(r.id, { to: v })} minRows={1}
                    placeholder={r.isPrivate ? '隐私目标词' : '目标词'} />
                  <RoleSelect role={r.role || 'main'} roleLabel={r.roleLabel} onRole={rr => updateRule(r.id, { role: rr })} onLabel={s => updateRule(r.id, { roleLabel: s })} compact />
                  <button className="btn btn-secondary btn-small" onClick={() => updateRule(r.id, { wholeWord: !r.wholeWord })}
                    title={r.wholeWord ? '整词匹配（girl 不命中 1girl）— 点击切子串' : '子串匹配（girl 命中 1girl）— 点击切整词'}>
                    {r.wholeWord ? '整词' : '子串'}
                  </button>
                  <button className={`assembly-privacy-toggle ${r.isPrivate ? 'locked' : ''}`} onClick={() => updateRule(r.id, { isPrivate: !r.isPrivate })}
                    title={r.isPrivate ? '隐私（AI 不可见）— 点击转公开' : '公开（AI 可见）— 点击转隐私'}>
                    {r.isPrivate ? '隐私' : '公开'}
                  </button>
                  <button className="btn btn-secondary btn-small" onClick={() => removeRule(r.id)} title="删除">×</button>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 8 }}>
              <button className="btn btn-secondary btn-small" onClick={addRule}>+ 新增规则</button>
            </div>
          </>
        ))}

        {/* ④ 参考加装：多张列表（role/cast 门控挑张·NAI 多图=整图 blend 非逐槽绑定）；默认折叠省地 */}
        <div className="aug-block-card">
          <button type="button" className="aug-block-head aug-block-collapse" onClick={() => setRefOpen(o => !o)}
            title="固定角色参考（Precise Reference）— 点击展开/收起">
            <span className="aug-block-n">④</span><b>参考加装</b>
            <span className="aug-block-hint">
              固定角色参考（Precise Reference）· {(() => {
                const n = active.char_references.filter(r => r.enabled).length
                return n > 0 ? `${n} 张启用 · ~${n * 5} Anlas/图` : '未启用'
              })()}
            </span>
            <span className="aug-collapse-caret">{refOpen ? '▲' : '▼'}</span>
          </button>
          {refOpen && (
            <>
              <p className="nai-section-hint">
                多张参考为 NAI【整图级 blend】、非逐槽绑定——归属（女1/女2）只决定该帧<b>附哪几张</b>（按 cast 门控：
                f1/f2 仅该女出场帧才附、特殊需点名、主要无 cast 时照附）。<b>双女同框帧附两张会互相混合</b>。
                成本按张数叠加（每张 ~5 Anlas）。
              </p>
              {active.char_references.map(cr => (
                <div key={cr.id} style={{ borderTop: '1px solid rgba(128,128,128,0.25)', paddingTop: 8, marginTop: 8 }}>
                  <div className="aug-unit-inline">
                    <span className="aug-unit-label">归属</span>
                    <RoleSelect role={cr.role || 'main'} roleLabel={cr.roleLabel}
                      onRole={r => patchCharRefAt(cr.id, { role: r })} onLabel={s => patchCharRefAt(cr.id, { roleLabel: s })} />
                    <button className="btn btn-secondary btn-small" style={{ marginLeft: 'auto' }}
                      onClick={() => removeCharRef(cr.id)}>移除本张</button>
                  </div>
                  <AugCharRefEditor cr={cr} onPatch={p => patchCharRefAt(cr.id, p)}
                    onClear={() => patchCharRefAt(cr.id, { image_b64: '', fileName: '', enabled: false })} />
                </div>
              ))}
              <div style={{ marginTop: 8 }}>
                <button className="btn btn-secondary btn-small" onClick={addCharRef}>+ 加参考</button>
              </div>
            </>
          )}
        </div>
      </div>

      {modalChar && (
        <PositionGridModal value={{ x: modalChar.x, y: modalChar.y }}
          onConfirm={pos => { if (pos) patchChar(modalChar.id, { x: pos.x, y: pos.y }); setPosModalCharId(null) }}
          onCancel={() => setPosModalCharId(null)} />
      )}
    </div>
  )
}

// ── 角色加装层编辑器（character_layers）──
// 可复用的【单角色】私设单元（如 "adult woman A"）：persona + 整图级参考图 + 替换，存成命名配置。
// 与加装预设独立并存；隐私存 data/nai_character_layers_private.json（AI 只认名字、读不到内容）。
// 跑图时在手动挡卡片「角色提示词」区把某角色加装层指派到某角色槽（见 CharactersEditor）。
type CharLayersData = { layers: CharLayer[] }
const CHAR_LAYER_DRAFT_KEY = 'owner:charlayer:draft'
// persona.text 兼容：旧扁平 string → {front_full: string}；对象原样；空 → {front_full:''}
function normPersonaText(t: unknown): ViewVariantTexts {
  if (typeof t === 'string') return { front_full: t }
  if (t && typeof t === 'object') { const o = t as ViewVariantTexts; return { ...o, front_full: o.front_full ?? '' } }
  return { front_full: '' }
}
function newCharLayer(name: string): CharLayer {
  return {
    id: genId('cl_'), name, enabled: true,
    persona: { text: { front_full: '' }, negative: '', position: 'suffix', isPrivate: true },
    char_reference: defaultCharRef(),
    replacements: { enabled: true, rules: [] },
  }
}
function normalizeCharLayer(l: Partial<CharLayer>): CharLayer {
  const p = l.persona
  const repl = l.replacements
  return {
    id: l.id || genId('cl_'),
    name: l.name || '未命名',
    enabled: l.enabled !== false,
    persona: {
      text: normPersonaText(p?.text),
      negative: typeof p?.negative === 'string' ? p.negative : '',
      position: p?.position === 'prefix' ? 'prefix' : 'suffix',
      isPrivate: p?.isPrivate !== false,
    },
    char_reference: { ...defaultCharRef(), ...(l.char_reference || {}) },
    replacements: { enabled: repl?.enabled !== false, rules: Array.isArray(repl?.rules) ? repl!.rules : [] },
  }
}
function readCharLayerDraft(): CharLayersData | null {
  try {
    const raw = localStorage.getItem(CHAR_LAYER_DRAFT_KEY)
    if (!raw) return null
    const obj = JSON.parse(raw)
    if (obj && Array.isArray(obj.layers)) return obj as CharLayersData
  } catch { /* ignore */ }
  return null
}

function CharLayerEditor({ characters }: { characters: Character[] }) {
  const [data, setData] = useState<CharLayersData | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [restored, setRestored] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveMsg, setSaveMsg] = useState('')
  const [showAllViews, setShowAllViews] = useState(false)   // 展开其余 9 个视角变体
  const [importing, setImporting] = useState(false)         // 从角色库导入对话框

  useEffect(() => {
    let cancelled = false
    fetch('/api/nai/char-layers')
      .then(r => r.json())
      .then((d: CharLayersData) => {
        if (cancelled) return
        const draft = readCharLayerDraft()
        if (draft) { setData({ layers: draft.layers.map(normalizeCharLayer) }); setDirty(true); setRestored(true) }
        else { setData({ layers: (d.layers || []).map(normalizeCharLayer) }); setDirty(false) }
      })
      .catch(() => {
        if (cancelled) return
        const draft = readCharLayerDraft()
        if (draft) { setData({ layers: draft.layers.map(normalizeCharLayer) }); setDirty(true); setRestored(true) }
        else setData({ layers: [] })
      })
    return () => { cancelled = true }
  }, [])

  const commit = (next: CharLayersData) => {
    setData(next)
    try { localStorage.setItem(CHAR_LAYER_DRAFT_KEY, JSON.stringify(next)) } catch { /* quota */ }
    setDirty(true)
    if (saveState !== 'idle') { setSaveState('idle'); setSaveMsg('') }
  }

  const saveToLocal = async () => {
    if (!data) return
    setSaveState('saving'); setSaveMsg('')
    try {
      const res = await fetch('/api/nai/char-layers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || (j && j.error)) throw new Error((j && j.error) || `HTTP ${res.status}`)
      try { localStorage.removeItem(CHAR_LAYER_DRAFT_KEY) } catch { /* ignore */ }
      setDirty(false); setRestored(false); setSaveState('saved'); setSaveMsg(nowClock())
    } catch (e) {
      setSaveState('error'); setSaveMsg(e instanceof Error ? e.message : String(e))
    }
  }
  const reloadFromLocal = async () => {
    const res = await fetch('/api/nai/char-layers')
    const server = await res.json()
    setData({ layers: (server.layers || []).map(normalizeCharLayer) })
    try { localStorage.removeItem(CHAR_LAYER_DRAFT_KEY) } catch { /* ignore */ }
    setDirty(false); setRestored(false); setSaveState('idle'); setSaveMsg('')
  }

  if (!data) return <div className="nai-params-editor"><p className="nai-section-hint">加载中…</p></div>

  const editing = data.layers.find(l => l.id === editingId) || null
  const patchLayer = (id: string, patch: Partial<CharLayer>) =>
    commit({ layers: data.layers.map(l => l.id === id ? { ...l, ...patch } : l) })
  const addLayer = () => { const l = newCharLayer(`adult woman ${String.fromCharCode(65 + data.layers.length)}`); commit({ layers: [...data.layers, l] }); setEditingId(l.id) }
  const dupLayer = (l: CharLayer) => {
    const copy: CharLayer = {
      ...l, id: genId('cl_'), name: l.name + ' 副本',
      persona: { ...l.persona, text: { ...l.persona.text } }, char_reference: { ...l.char_reference },
      replacements: { ...l.replacements, rules: l.replacements.rules.map(r => ({ ...r, id: genId('r_') })) },
    }
    commit({ layers: [...data.layers, copy] }); setEditingId(copy.id)
  }
  const renameLayer = (l: CharLayer) => { const n = window.prompt('角色加装层名称', l.name); if (n && n.trim()) patchLayer(l.id, { name: n.trim() }) }
  const removeLayer = (l: CharLayer) => {
    if (!window.confirm(`删除角色加装层「${l.name}」？此操作不可撤销。`)) return
    commit({ layers: data.layers.filter(x => x.id !== l.id) })
    if (editingId === l.id) setEditingId(null)
  }

  const patchPersona = (p: Partial<CharLayer['persona']>) => editing && patchLayer(editing.id, { persona: { ...editing.persona, ...p } })
  // 改某个 view 的 persona.text 变体
  const patchPersonaText = (view: ViewKey, value: string) =>
    editing && patchPersona({ text: { ...editing.persona.text, [view]: value } })
  // 从角色库导入：把 Character.traits(ViewVariantTexts) 拷进 persona.text、negative_text 拷进 persona.negative
  const importFromCharacter = (c: Character) => {
    if (!editing) return
    patchPersona({ text: { ...c.traits, front_full: c.traits?.front_full ?? '' }, negative: c.negative_text || '' })
    setImporting(false)
  }
  const patchCharRef = (p: Partial<CharLayer['char_reference']>) => editing && patchLayer(editing.id, { char_reference: { ...editing.char_reference, ...p } })
  const patchRepl = (p: Partial<CharLayer['replacements']>) => editing && patchLayer(editing.id, { replacements: { ...editing.replacements, ...p } })
  const addRule = () => editing && patchRepl({ rules: [...editing.replacements.rules, { id: genId('r_'), from: '', to: '', enabled: true, wholeWord: true, isPrivate: true }] })
  const updateRule = (rid: string, p: Partial<ReplRule>) => editing && patchRepl({ rules: editing.replacements.rules.map(r => r.id === rid ? { ...r, ...p } : r) })
  const removeRule = (rid: string) => editing && patchRepl({ rules: editing.replacements.rules.filter(r => r.id !== rid) })

  const subhead = (t: string) => <div className="nai-aug-subhead" style={{ fontWeight: 600, fontSize: 13, margin: '14px 0 4px', borderTop: '1px solid var(--border, #333)', paddingTop: 12 }}>{t}</div>

  return (
    <div className="nai-params-editor">
      <p className="nai-section-hint">
        每个角色加装层 = <b>单角色 persona（私设）+ 整图级参考图 + 替换</b>，存成命名配置（如 <b>adult woman A</b>）。
        在手动挡卡片「角色提示词」区把某层<b>指派到某角色槽</b>即可跑图（角色1上 A、角色2上 B）。
        勾「隐私」的内容明文存本地 <b>nai_character_layers_private.json</b>，AI 只认名字、看不到内容。
        ⚠ 参考图为<b>整图级</b>（NAI 限制，绑不到具体角色槽）；指派多层时只取第一张 enabled 的生效。
        编辑实时存浏览器本地草稿；点 <b>💾 保存到本地</b> 才写盘（跑图读写盘值）。
      </p>

      {/* 层列表 */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontSize: 12, color: '#888' }}>编辑层</span>
        <select value={editingId || ''} onChange={e => setEditingId(e.target.value || null)} style={{ minWidth: 160 }}>
          <option value="">（选择要编辑的层）</option>
          {data.layers.map(l => <option key={l.id} value={l.id}>{l.name}{l.enabled ? '' : '（停用）'}</option>)}
        </select>
        <button className="btn btn-secondary btn-small" onClick={addLayer}>+ 新建层</button>
        {editing && <button className="btn btn-secondary btn-small" onClick={() => dupLayer(editing)}>复制</button>}
        {editing && <button className="btn btn-secondary btn-small" onClick={() => renameLayer(editing)}>重命名</button>}
        {editing && <button className="btn btn-secondary btn-small" onClick={() => removeLayer(editing)}>删除</button>}
      </div>

      {/* 保存栏 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <button className="btn btn-small" onClick={saveToLocal} disabled={saveState === 'saving'}
          style={{ background: dirty ? 'var(--warning, #e08a00)' : 'var(--success, #2e7d32)', color: '#fff', fontWeight: 600 }}
          title="把全部角色加装层写入本地（公开→nai_config.json，隐私→nai_character_layers_private.json）">
          💾 {saveState === 'saving' ? '保存中…' : '保存到本地'}{dirty ? ' ●' : ''}
        </button>
        <button className="btn btn-secondary btn-small" onClick={() => {
          if (dirty && !window.confirm('从本地文件重读会丢弃当前未保存的修改，确定？')) return
          reloadFromLocal().catch(() => { /* ignore */ })
        }}>🔄 从本地重读</button>
        {dirty
          ? <span style={{ fontSize: 12, color: 'var(--warning, #e08a00)' }}>● 有未保存修改</span>
          : saveState === 'saved'
            ? <span style={{ fontSize: 12, color: 'var(--success, #4caf50)' }}>✓ 已保存 {saveMsg}</span>
            : <span style={{ fontSize: 12, color: '#888' }}>已与本地文件一致</span>}
        {saveState === 'error' && <span style={{ fontSize: 12, color: 'var(--danger, #d33)' }}>✗ 保存失败：{saveMsg}</span>}
      </div>

      {restored && (
        <div style={{ fontSize: 12, color: 'var(--warning, #e08a00)', background: 'rgba(224,138,0,0.1)', border: '1px solid var(--warning, #e08a00)', borderRadius: 6, padding: '6px 10px', marginBottom: 8 }}>
          已从浏览器本地草稿恢复上次<b>未保存</b>的修改。确认后点「💾 保存到本地」写盘；放弃点「🔄 从本地重读」。
        </div>
      )}

      {!editing ? (
        <p className="nai-section-hint">{data.layers.length ? '选择上方一个层进行编辑，或「+ 新建层」。' : '还没有角色加装层，点「+ 新建层」创建（如 adult woman A）。'}</p>
      ) : (
        <div style={{ opacity: editing.enabled ? 1 : 0.5, pointerEvents: editing.enabled ? 'auto' : 'none' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, pointerEvents: 'auto' }}>
            <input type="checkbox" checked={editing.enabled} onChange={e => patchLayer(editing.id, { enabled: e.target.checked })} />
            <span>启用此层（停用则指派时不生效）</span>
          </label>

          <div className="nai-aug-subhead" style={{ fontWeight: 600, fontSize: 13, margin: '2px 0 4px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>① 角色 persona（私设核心 · 按视角变体）</span>
            <button className="btn btn-secondary btn-small" onClick={() => setImporting(true)} disabled={characters.length === 0}
              title="从角色库导入：把该角色的 10 视角特征(traits)拷进 persona，再手改私设/勾隐私">📚 从角色库导入</button>
            <button className={`assembly-privacy-toggle ${editing.persona.isPrivate ? 'locked' : ''}`} onClick={() => patchPersona({ isPrivate: !editing.persona.isPrivate })}
              style={{ marginLeft: 'auto' }}
              title={editing.persona.isPrivate ? '隐私（整个 persona 存独立隐私文件·AI 不读）— 点击转公开' : '公开（AI 可见）— 点击转隐私'}>
              {editing.persona.isPrivate ? '隐私' : '公开'}
            </button>
          </div>
          <p className="nai-section-hint" style={{ marginTop: 0 }}>
            正面 persona 按视角存变体——典型只填 <b>front_full</b>（基线，含 blue eyes 等五官）+ <b>back_full</b>（背面，去掉看不到的五官）；
            其余视角留空自动回落。提交时按该帧 view 选对应变体。
          </p>
          <div className="nai-default-blocks">
            <div className="nai-default-blocks-row" style={{ display: 'grid', gridTemplateColumns: '110px 1fr auto', gap: 6, alignItems: 'start' }}>
              <span className="nai-section-hint" style={{ margin: 0, alignSelf: 'center' }}>front_full（基线）</span>
              <AutoGrowTextarea value={editing.persona.text.front_full || ''} onChange={v => patchPersonaText('front_full', v)} minRows={1}
                placeholder={editing.persona.isPrivate ? '隐私 persona（存 nai_character_layers_private.json，AI 不读）' : '角色身份/特征 persona（如 adult woman, blue eyes, long hair）'} />
              <select value={editing.persona.position} onChange={e => patchPersona({ position: e.target.value as 'prefix' | 'suffix' })} title="拼在被指派角色槽 prompt 前还是后">
                <option value="prefix">前缀</option>
                <option value="suffix">后缀</option>
              </select>
            </div>
            <div style={{ marginTop: 4 }}>
              <button className="btn btn-secondary btn-small" onClick={() => setShowAllViews(v => !v)}>
                {showAllViews ? '▾ 收起其他视角变体' : '▸ 其他视角变体（留空回落 front_full）'}
              </button>
            </div>
            {showAllViews && VIEW_KEYS.filter(k => k !== 'front_full').map(k => (
              <div key={k} className="nai-default-blocks-row" style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 6, alignItems: 'start', marginTop: 4 }}>
                <span className="nai-section-hint" style={{ margin: 0, alignSelf: 'center' }}>{k}</span>
                <AutoGrowTextarea value={editing.persona.text[k] || ''} onChange={v => patchPersonaText(k, v)} minRows={1}
                  placeholder="留空=回落 front_full（back_* 帧建议去掉 eyes/face 类五官）" />
              </div>
            ))}
            <div className="nai-default-blocks-row" style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 6, alignItems: 'start', marginTop: 8 }}>
              <span className="nai-section-hint" style={{ margin: 0, alignSelf: 'center' }}>负面词（统一）</span>
              <AutoGrowTextarea value={editing.persona.negative} onChange={v => patchPersona({ negative: v })} minRows={1}
                placeholder={editing.persona.isPrivate ? '隐私负面词（不分视角）' : '角色负面词（不分视角）'} />
            </div>
          </div>

          {importing && (
            <div className="modal-overlay" onClick={() => setImporting(false)}>
              <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }}>
                <button className="modal-close" onClick={() => setImporting(false)}>×</button>
                <h3>从角色库导入特征</h3>
                <p className="nai-section-hint">选一个角色，把它的 10 视角特征(traits)拷进当前 persona（会覆盖现有 persona 文本）。导入后记得手改私设、勾隐私。</p>
                <div style={{ maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {characters.map(c => (
                    <button key={c.id} className="btn btn-secondary" style={{ textAlign: 'left' }}
                      onClick={() => importFromCharacter(c)}>{c.name}</button>
                  ))}
                  {characters.length === 0 && <p className="nai-section-hint">（角色库为空）</p>}
                </div>
              </div>
            </div>
          )}

          {subhead('② 整图级参考图（Director Reference·只取第一张指派层生效）')}
          <AugCharRefEditor cr={editing.char_reference} onPatch={patchCharRef}
            onClear={() => patchCharRef({ image_b64: '', fileName: '', enabled: false })} />

          {subhead('③ 替换规则（注入 persona 之后的最后一道）')}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <input type="checkbox" checked={editing.replacements.enabled} onChange={e => patchRepl({ enabled: e.target.checked })} />
            <span>启用替换规则</span>
          </label>
          <div className="nai-default-blocks" style={{ opacity: editing.replacements.enabled ? 1 : 0.5, pointerEvents: editing.replacements.enabled ? 'auto' : 'none' }}>
            {editing.replacements.rules.length === 0 && <p className="nai-section-hint">（暂无规则）</p>}
            {editing.replacements.rules.map(r => (
              <div className="nai-default-blocks-row" key={r.id}
                style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto 1fr auto auto auto', gap: 6, alignItems: 'start' }}>
                <input type="checkbox" checked={r.enabled} onChange={e => updateRule(r.id, { enabled: e.target.checked })} title="启用此规则" />
                <AutoGrowTextarea value={r.from} onChange={v => updateRule(r.id, { from: v })} minRows={1}
                  placeholder={r.isPrivate ? '隐私源词（每行一个）' : '源词（每行一个）'} />
                <span style={{ alignSelf: 'center' }}>→</span>
                <AutoGrowTextarea value={r.to} onChange={v => updateRule(r.id, { to: v })} minRows={1}
                  placeholder={r.isPrivate ? '隐私目标词' : '目标词'} />
                <button className="btn btn-secondary btn-small" onClick={() => updateRule(r.id, { wholeWord: !r.wholeWord })}
                  title={r.wholeWord ? '整词匹配 — 点击切子串' : '子串匹配 — 点击切整词'}>{r.wholeWord ? '整词' : '子串'}</button>
                <button className={`assembly-privacy-toggle ${r.isPrivate ? 'locked' : ''}`} onClick={() => updateRule(r.id, { isPrivate: !r.isPrivate })}
                  title={r.isPrivate ? '隐私 — 点击转公开' : '公开 — 点击转隐私'}>{r.isPrivate ? '隐私' : '公开'}</button>
                <button className="btn btn-secondary btn-small" onClick={() => removeRule(r.id)} title="删除">×</button>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 8 }}>
            <button className="btn btn-secondary btn-small" onClick={addRule}>+ 新增规则</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── 固定加装层里的「固定角色参考」编辑器（Precise Reference）──
// 上传一张参考图后，bare CLI 批量跑图的每一张都会自动套用（每张 ~5 Anlas、仅 V4.5、与 Vibe 互斥）。
// 隐私图的 base64 存 private_blocks.json（AI 不读），公开图内联 nai_config。
function AugCharRefEditor({ cr, onPatch, onClear }: {
  cr?: AugCharRefBase              // 单张编辑器（无 id·预设多参考逐张复用 + CharLayer 单参考沿用）
  onPatch: (p: Partial<AugCharRefBase>) => void
  onClear: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const onPickFile = async (file: File | undefined) => {
    if (!file) return
    setBusy(true); setErr(null)
    try {
      const b64 = await encodeCharReferenceImage(file)
      onPatch({ image_b64: b64, fileName: file.name, enabled: true })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const hasImg = !!cr?.image_b64
  return (
    <div className="nai-params-editor" style={{ marginTop: 0 }}>
      <p className="nai-section-hint">
        bare CLI 批量跑图时<b>每张图</b>自动套用此参考图锁定角色/画风。<b>仅 V4.5 模型</b>、与 Vibe 互斥、
        <b style={{ color: '#d88' }}>每张图额外消耗 ~5 Anlas</b>（批量会叠加，注意成本）。图片自动 letterbox。
      </p>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {hasImg ? (
          <img src={`data:image/png;base64,${cr!.image_b64}`} alt="固定角色参考"
            style={{ width: 80, height: 120, objectFit: 'contain', background: '#000', borderRadius: 6 }} />
        ) : (
          <div style={{ width: 80, height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.2)', borderRadius: 6, fontSize: 12, color: '#888', textAlign: 'center' }}>
            未选择
          </div>
        )}
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label className="nai-add-block" style={{ cursor: busy ? 'default' : 'pointer', display: 'inline-block' }}>
              {busy ? '处理中…' : hasImg ? '更换参考图' : '+ 选择参考图'}
              <input type="file" accept="image/*" style={{ display: 'none' }} disabled={busy}
                onChange={e => { onPickFile(e.target.files?.[0]); e.target.value = '' }} />
            </label>
            {hasImg && (
              <button className="nai-add-block" onClick={onClear}>移除</button>
            )}
            <button className={`assembly-privacy-toggle ${cr?.isPrivate ? 'locked' : ''}`}
              onClick={() => onPatch({ isPrivate: !(cr?.isPrivate ?? true) })}
              title={cr?.isPrivate ? '隐私（图存 private_blocks.json，AI 不读）— 点击转公开' : '公开（图内联 nai_config，AI 可见）— 点击转隐私'}>
              {cr?.isPrivate ? '隐私' : '公开'}
            </button>
          </div>
          {cr?.fileName && <div style={{ fontSize: 12, color: '#888', marginTop: 6 }}>{cr.fileName}</div>}
          {err && <div className="nai-batch-card-error" style={{ marginTop: 6 }}>⚠ {err}</div>}
        </div>
      </div>

      {hasImg && (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={!!cr?.enabled} onChange={e => onPatch({ enabled: e.target.checked })} />
            <span>启用固定角色参考（批量每张图套用）</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 110 }}>Strength {(cr?.strength ?? 1).toFixed(2)}</span>
            <input type="range" min={0} max={1} step={0.05} value={cr?.strength ?? 1}
              style={{ flex: 1 }} onChange={e => onPatch({ strength: Number(e.target.value) })} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 110 }}>Fidelity {(cr?.fidelity ?? 1).toFixed(2)}</span>
            <input type="range" min={0} max={1} step={0.05} value={cr?.fidelity ?? 1}
              style={{ flex: 1 }} onChange={e => onPatch({ fidelity: Number(e.target.value) })} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 110 }}>参考模式</span>
            <select value={charRefMode(cr)} style={{ flex: 1 }}
              onChange={e => onPatch({ base_caption: e.target.value as CharRefMode })}>
              {CHAR_REF_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </label>
        </div>
      )}
    </div>
  )
}

// ── 批次设置编辑器（乐观更新） ──
function BatchSettingsEditor({ batch: batchCfg, onChangeField, activeBatchMode, variantDistribution }: {
  batch: NaiConfigPublic['batch']
  onChangeField: (k: keyof NonNullable<NaiConfigPublic['batch']>, v: unknown) => void
  activeBatchMode: boolean
  variantDistribution: { label: string; count: number }[]
}) {
  return (
    <div className="nai-params-editor">
      {activeBatchMode && variantDistribution.length > 0 && (
        <div style={{
          padding: '8px 10px', marginBottom: 8,
          background: 'linear-gradient(135deg, #dbeafe, #bfdbfe)',
          border: '1px solid #3b82f6', borderRadius: 4,
          fontSize: 11, color: '#1e40af',
        }}>
          ℹ 批量模式：总张数仍由「生成图片总数」决定，按 round-robin 平摊给 {variantDistribution.length} 个变体 →
          <strong> {variantDistribution.map(d => `${d.label}×${d.count}`).join(' / ')}</strong>
        </div>
      )}
      <ParamField label="每批次几张（连续跑 N 张后 sleep）" value={batchCfg?.batch_count} onChange={(v) => onChangeField('batch_count', v)}
        type="number" min={1} max={999} hideClear />
      <ParamField label="生成图片总数"
        value={batchCfg?.number_of_requests} onChange={(v) => onChangeField('number_of_requests', v)}
        type="number" min={0} max={9999} hideClear />
      <ParamField label="批次间隔（秒）" value={batchCfg?.interval_seconds} onChange={(v) => onChangeField('interval_seconds', v)}
        type="float" step={0.1} hideClear />
      <ParamField label="随机波动最小值" value={batchCfg?.interval_jitter_min} onChange={(v) => onChangeField('interval_jitter_min', v)}
        type="float" step={0.1} hideClear />
      <ParamField label="随机波动最大值" value={batchCfg?.interval_jitter_max} onChange={(v) => onChangeField('interval_jitter_max', v)}
        type="float" step={0.1} hideClear />
      <ParamField label="429 时快速重试" value={batchCfg?.retry_on_429_enabled} onChange={(v) => onChangeField('retry_on_429_enabled', v)}
        type="bool" hideClear />
      <ParamField label="429 重试等待（秒）" value={batchCfg?.retry_on_429_delay_sec} onChange={(v) => onChangeField('retry_on_429_delay_sec', v)}
        type="number" hideClear />
      <ParamField label="最大重试次数" value={batchCfg?.max_retries} onChange={(v) => onChangeField('max_retries', v)}
        type="number" hideClear />

      <div className="nai-params-actions">
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          ✓ 改动自动保存（500ms 后写入 nai_config.json），立即生效
        </span>
      </div>
    </div>
  )
}

// ── 通用参数字段 ──
function ParamField({
  label, value, onChange, type, choices, min, max, step, disabled, hideClear,
}: {
  label: string
  value: unknown
  onChange: (v: unknown) => void
  type: 'number' | 'float' | 'select' | 'bool' | 'textarea'
  choices?: string[]
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  hideClear?: boolean
}) {
  const isSet = value !== undefined && value !== null && value !== ''

  return (
    <div className="nai-param-field">
      <label className="nai-param-label">
        {label}
        {isSet && !hideClear && <span className="nai-param-set">●</span>}
      </label>
      <div className="nai-param-control">
        {type === 'select' && (
          <select value={(value as string) ?? ''} onChange={e => onChange(e.target.value)} disabled={disabled}>
            <option value="">（默认）</option>
            {choices?.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        {type === 'number' && (
          <input type="number" value={(value as number | string) ?? ''}
            min={min} max={max}
            onChange={e => onChange(e.target.value === '' ? undefined : parseInt(e.target.value))}
            disabled={disabled} />
        )}
        {type === 'float' && (
          <input type="number" value={(value as number | string) ?? ''}
            min={min} max={max} step={step ?? 0.1}
            onChange={e => onChange(e.target.value === '' ? undefined : parseFloat(e.target.value))}
            disabled={disabled} />
        )}
        {type === 'bool' && (
          <input type="checkbox" checked={!!value}
            onChange={e => onChange(e.target.checked)} disabled={disabled} />
        )}
        {type === 'textarea' && (
          <AutoGrowTextarea className="nai-block-text" value={(value as string) ?? ''}
            onChange={v => onChange(v)} disabled={disabled} />
        )}
        {!hideClear && isSet && (
          <button className="btn-icon btn-icon-danger" onClick={() => onChange(undefined)}
            disabled={disabled} title="清除覆盖">×</button>
        )}
      </div>
    </div>
  )
}

// ── 对话框 ──
function SaveDialog({ onSave, onClose }: { onSave: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState('')
  return (
    <div className="nai-batch-dialog-overlay" onClick={onClose}>
      <div className="nai-batch-dialog" onClick={e => e.stopPropagation()}>
        <h4>保存当前队列为...</h4>
        <input type="text" placeholder="计划名称" value={name}
          onChange={e => setName(e.target.value)} autoFocus
          onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onSave(name) }} />
        <div className="nai-batch-dialog-actions">
          <button className="btn btn-secondary btn-small" onClick={onClose}>取消</button>
          <button className="btn btn-primary btn-small" onClick={() => onSave(name)} disabled={!name.trim()}>保存</button>
        </div>
      </div>
    </div>
  )
}

function LoadDialog({ plans, onLoad, onDelete, onClose }: {
  plans: { id: string; name: string; updatedAt: string; itemCount: number }[]
  onLoad: (id: string) => void; onDelete: (id: string) => void; onClose: () => void
}) {
  return (
    <div className="nai-batch-dialog-overlay" onClick={onClose}>
      <div className="nai-batch-dialog" onClick={e => e.stopPropagation()}>
        <h4>加载已保存的计划</h4>
        {plans.length === 0 ? <p>暂无保存的计划。</p> : (
          <ul className="nai-batch-saved-list">
            {plans.map(p => (
              <li key={p.id}>
                <button className="nai-batch-saved-load" onClick={() => onLoad(p.id)}>
                  <div className="nai-batch-saved-name">{p.name}</div>
                  <div className="nai-batch-saved-meta">{p.itemCount} 个任务 · {new Date(p.updatedAt).toLocaleString()}</div>
                </button>
                <button className="btn-icon btn-icon-danger" onClick={() => onDelete(p.id)} title="删除">×</button>
              </li>
            ))}
          </ul>
        )}
        <div className="nai-batch-dialog-actions">
          <button className="btn btn-secondary btn-small" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}
