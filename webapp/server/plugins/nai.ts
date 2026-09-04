import { type Plugin } from 'vite'
import path from 'path'
import fs from 'fs'
import { spawnSync } from 'node:child_process'

export function naiPlugin(rootDir: string): Plugin {
  const repoRoot = path.resolve(rootDir, '..')
  const configPath = path.join(repoRoot, 'data', 'nai_config.json')
  const plansDir = path.join(repoRoot, 'data', 'batch_plans')

  function readBody(req: { on: (e: string, cb: (d: Buffer | undefined) => void) => void }): Promise<string> {
    return new Promise(resolve => {
      let body = ''
      req.on('data', (chunk: Buffer | undefined) => { if (chunk) body += chunk.toString() })
      req.on('end', () => resolve(body))
    })
  }

  // 返回前端可见的 NAI 配置（剔除 api_key 等敏感字段）
  function loadPublicConfig(): Record<string, unknown> {
    if (!fs.existsSync(configPath)) return { configured: false }
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      return {
        configured: !!cfg.api_key,
        default_params: cfg.default_params || {},
        batch: cfg.batch || {},
        size_presets: cfg.size_presets || [],
        default_base_blocks: cfg.default_base_blocks || {},
        output_folder: cfg.output_folder || '',
      }
    } catch {
      return { configured: false }
    }
  }

  // ★加装层 persona 独立文件(2026-06-16 从 private_blocks 物理分离)：根除"组装棚 /api/assembly/private
  // 覆盖写抹掉加装层 persona"的 bug。本文件只存 persona、由本插件独占读写;组装棚隐私 block 仍在 private_blocks。
  const augPrivatePath = path.join(repoRoot, 'data', 'nai_augment_private.json')

  // 读加装层 persona: { <presetId>: blob }(blob = base_positive/base_negative/chars/charref_image/repl)
  function readAugPrivate(): Record<string, Record<string, unknown>> {
    try {
      if (fs.existsSync(augPrivatePath)) return JSON.parse(fs.readFileSync(augPrivatePath, 'utf-8'))
    } catch { /* ignore */ }
    return {}
  }

  // ★角色加装层 persona 独立文件（增量并存）：与 nai_augment_private 物理隔离=两套 GC 各管各的——
  // 防 savePresets 的 GC 按 preset keepIds 删孤儿时误删角色加装层 persona（即"persona 反复丢失"那类 bug）。
  // 本文件只存角色加装层 persona，由本插件 saveCharLayers 独占读写。
  const charLayerPrivatePath = path.join(repoRoot, 'data', 'nai_character_layers_private.json')

  // 读角色加装层 persona: { <layerId>: blob }(blob = persona{text,negative} / charref_image / repl{ruleId:{from,to}})
  function readCharLayerPrivate(): Record<string, Record<string, unknown>> {
    try {
      if (fs.existsSync(charLayerPrivatePath)) return JSON.parse(fs.readFileSync(charLayerPrivatePath, 'utf-8'))
    } catch { /* ignore */ }
    return {}
  }

  // ── 加装预设（augmentation_presets）读写 ──
  // 一套预设 = 提示词加装(base 正/负 + 多角色) + 角色参考 + 替换规则。
  // 隐私内容按预设 ID 命名空间存 private_blocks 的单个 blob `nai_augpreset:<presetId>`：
  //   { base_positive, base_negative, chars:{<charId>:{text,negative}}, char_extras:{<extraId>:text}, extra:{<id>:text},
  //     charref_images:{<refId>:b64}(多参考·新), charref_image(旧单键·读兼容), repl:{<ruleId>:{from,to}} }
  // 隐私边界仅针对 AI（AI 不读 private 文件、不调本接口）。
  type PresetObj = Record<string, unknown>

  // GET：把隐私内容从 blob 合并回各预设，返回 { activeId, presets[] } 供浏览器编辑
  function loadPresetsFull(): { activeId: string; presets: PresetObj[] } {
    const empty = { activeId: '', presets: [] as PresetObj[] }
    if (!fs.existsSync(configPath)) return empty
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      const store = cfg.augmentation_presets
      if (!store || !Array.isArray(store.presets)) return empty
      const augPriv = readAugPrivate()
      const presets = store.presets.map((p: PresetObj) => {
        const blob = (augPriv[p.id as string] as Record<string, unknown>) || {}
        const out: PresetObj = { ...p }
        for (const bk of ['base_positive', 'base_negative'] as const) {
          const b = p[bk] as Record<string, unknown> | undefined
          if (b && typeof b === 'object') {
            out[bk] = b.isPrivate ? { ...b, text: (blob[bk] as string) || '' } : b
          }
        }
        const blobChars = (blob.chars as Record<string, { text?: string; negative?: string; front_text?: string }>) || {}
        const blobCharExtras = (blob.char_extras as Record<string, string>) || {}
        // 角色额外框（extras）：隐私块 text 从 blob.char_extras[<extraId>] 取回（不论父角色公开/隐私都各自处理）
        const restoreCharExtras = (c: Record<string, unknown>): Record<string, unknown> => {
          if (!Array.isArray(c.extras)) return c
          return { ...c, extras: c.extras.map((e: Record<string, unknown>) =>
            e.isPrivate && e.id ? { ...e, text: blobCharExtras[e.id as string] || '' } : e) }
        }
        out.chars = (Array.isArray(p.chars) ? p.chars : []).map((c: Record<string, unknown>) => {
          const privateChar = blobChars[c.id as string] || {}
          const withText = c.isPrivate
            ? { ...c, text: privateChar.text || '', negative: privateChar.negative || '' }
            : c
          // front_text 是新增正面栏隐私正文：无论父角色是否公开，都只从 blob.chars 回填。
          const withFront = ('front_text' in c || typeof privateChar.front_text === 'string')
            ? { ...withText, front_text: privateChar.front_text || '' }
            : withText
          return restoreCharExtras(withFront)
        })
        // 提示词加装·额外框：隐私块的 text 从 blob.extra[<id>] 取回（镜像 chars）
        const blobExtra = (blob.extra as Record<string, string>) || {}
        if (Array.isArray(p.extra_blocks)) {
          out.extra_blocks = p.extra_blocks.map((b: Record<string, unknown>) =>
            b.isPrivate && b.id ? { ...b, text: blobExtra[b.id as string] || '' } : b)
        }
        // 参考加装（多张·2026-07-12 多参考化）：私图从 blob.charref_images[<refId>] 取回（镜像 char_extras 多键模式）。
        // 旧单键迁移读：无 char_references 列表时把旧 char_reference（私图=blob.charref_image）迁为单元素列表。
        const blobCrImgs = (blob.charref_images as Record<string, string>) || {}
        if (Array.isArray(p.char_references)) {
          out.char_references = p.char_references.map((cr: Record<string, unknown>) =>
            cr.isPrivate ? { ...cr, image_b64: blobCrImgs[String(cr.id || '')] || '' } : cr)
        } else {
          const cr = p.char_reference as Record<string, unknown> | undefined
          if (cr && typeof cr === 'object') {
            out.char_references = [cr.isPrivate ? { ...cr, image_b64: (blob.charref_image as string) || '' } : cr]
            delete out.char_reference
          }
        }
        const rep = p.replacements as Record<string, unknown> | undefined
        if (rep && typeof rep === 'object') {
          const blobRepl = (blob.repl as Record<string, { from?: string; to?: string; word?: string }>) || {}
          const rules = (Array.isArray(rep.rules) ? rep.rules : []).map((r: Record<string, unknown>) => {
            if (r.isPrivate && r.id) {
              const pv = blobRepl[r.id as string] || {}
              return { ...r, from: pv.from || '', to: pv.to || '', ...(r.kind === 'delete' ? { word: pv.word || pv.from || '' } : {}) }
            }
            return r
          })
          out.replacements = { ...rep, rules }
        }
        return out
      })
      return { activeId: store.activeId || (presets[0]?.id as string) || '', presets }
    } catch {
      return empty
    }
  }

  // POST：按 isPrivate 把每套预设的隐私内容抽进各自 blob，nai_config 里置空；GC 已删预设的孤儿 blob
  function savePresets(body: { activeId?: string; presets?: PresetObj[] }): void {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    const augPriv = readAugPrivate()
    const inPresets = Array.isArray(body.presets) ? body.presets : []
    const keepIds = new Set<string>()

    const outPresets = inPresets.map((p: PresetObj) => {
      const id = String(p.id || '')
      keepIds.add(id)
      const blob: Record<string, unknown> = {}
      const out: PresetObj = { ...p }
      for (const bk of ['base_positive', 'base_negative'] as const) {
        const b = p[bk] as Record<string, unknown> | undefined
        if (b && typeof b === 'object') {
          if (b.isPrivate) {
            blob[bk] = typeof b.text === 'string' ? b.text : ''
            out[bk] = { ...b, text: '' }
          } else {
            out[bk] = b
          }
        }
      }
      const blobChars: Record<string, { text: string; negative: string; front_text?: string }> = {}
      const blobCharExtras: Record<string, string> = {}
      // 角色额外框：隐私块 text 抽进 blob.char_extras[<extraId>]、公开侧置空（不论父角色公开/隐私，各额外框按自身 isPrivate 处理）
      const stripCharExtras = (c: Record<string, unknown>): Record<string, unknown> => {
        if (!Array.isArray(c.extras)) return c
        return { ...c, extras: c.extras.map((e: Record<string, unknown>) => {
          if (e.isPrivate && e.id) { blobCharExtras[String(e.id)] = typeof e.text === 'string' ? e.text : ''; return { ...e, text: '' } }
          return e
        }) }
      }
      out.chars = (Array.isArray(p.chars) ? p.chars : []).map((c: Record<string, unknown>) => {
        let oc = c
        const privateChar: { text: string; negative: string; front_text?: string } = {
          text: '', negative: '',
        }
        if (c.isPrivate) {
          privateChar.text = typeof c.text === 'string' ? c.text : ''
          privateChar.negative = typeof c.negative === 'string' ? c.negative : ''
          oc = { ...c, text: '', negative: '' }
        }
        if ('front_text' in c) {
          privateChar.front_text = typeof c.front_text === 'string' ? c.front_text : ''
          oc = { ...oc, front_text: '' }
        }
        if (c.isPrivate || 'front_text' in c) blobChars[String(c.id)] = privateChar
        return stripCharExtras(oc)
      })
      if (Object.keys(blobChars).length) blob.chars = blobChars
      if (Object.keys(blobCharExtras).length) blob.char_extras = blobCharExtras
      // 提示词加装·额外框：隐私块 text 抽进 blob.extra[<id>]，公开侧置空（镜像 chars，防私词漏进 nai_config）
      const blobExtra: Record<string, string> = {}
      out.extra_blocks = (Array.isArray(p.extra_blocks) ? p.extra_blocks : []).map((b: Record<string, unknown>) => {
        if (b.isPrivate && b.id) {
          blobExtra[String(b.id)] = typeof b.text === 'string' ? b.text : ''
          return { ...b, text: '' }
        }
        return b
      })
      if (Object.keys(blobExtra).length) blob.extra = blobExtra
      // 参考加装（多张）：私图抽进 blob.charref_images[<refId>]、公开侧置空（镜像 char_extras 多键模式）。
      // blob 每次 fresh 重建 → 删参考/删预设时孤儿键与旧单键 charref_image 自然消失=自动 GC。
      const blobCrImgs: Record<string, string> = {}
      if (Array.isArray(p.char_references)) {
        out.char_references = p.char_references.map((cr: Record<string, unknown>) => {
          if (cr.isPrivate && cr.id) {
            blobCrImgs[String(cr.id)] = typeof cr.image_b64 === 'string' ? cr.image_b64 : ''
            return { ...cr, image_b64: '' }
          }
          return cr
        })
      }
      if (Object.keys(blobCrImgs).length) blob.charref_images = blobCrImgs
      // 旧单键写兼容（双读兜底·未升级前端仍发 char_reference 时不丢图；正常升级后前端只发 char_references）
      const cr = p.char_reference as Record<string, unknown> | undefined
      if (cr && typeof cr === 'object') {
        if (cr.isPrivate) {
          blob.charref_image = typeof cr.image_b64 === 'string' ? cr.image_b64 : ''
          out.char_reference = { ...cr, image_b64: '' }
        } else {
          out.char_reference = cr
        }
      }
      const rep = p.replacements as Record<string, unknown> | undefined
      if (rep && typeof rep === 'object') {
        const blobRepl: Record<string, { from: string; to: string; word?: string }> = {}
        const rules = (Array.isArray(rep.rules) ? rep.rules : []).map((r: Record<string, unknown>) => {
          if (r.isPrivate && r.id) {
            blobRepl[String(r.id)] = {
              from: typeof r.from === 'string' ? r.from : '',
              to: typeof r.to === 'string' ? r.to : '',
              ...(r.kind === 'delete' ? { word: typeof r.word === 'string' ? r.word : (typeof r.from === 'string' ? r.from : '') } : {}),
            }
            return { ...r, from: '', to: '', ...(r.kind === 'delete' ? { word: '' } : {}) }
          }
          return r
        })
        if (Object.keys(blobRepl).length) blob.repl = blobRepl
        out.replacements = { ...rep, rules }
      }
      if (Object.keys(blob).length) augPriv[id] = blob
      else delete augPriv[id]
      return out
    })

    // GC：删除所有不再对应现存预设的 persona blob
    for (const k of Object.keys(augPriv)) {
      if (!keepIds.has(k)) delete augPriv[k]
    }

    cfg.augmentation_presets = { activeId: body.activeId || (outPresets[0]?.id as string) || '', presets: outPresets }
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8')
    fs.mkdirSync(path.dirname(augPrivatePath), { recursive: true })
    fs.writeFileSync(augPrivatePath, JSON.stringify(augPriv, null, 2), 'utf-8')
  }

  // ── 角色加装层（character_layers）读写 ──
  // 每个层 = 单角色 persona + 整图级参考图 + 替换规则；隐私内容按 layerId 存【独立文件】nai_character_layers_private.json。
  // 与 augmentation_presets 完全独立并存：本组 CRUD 绝不触碰 augPrivatePath / augmentation_presets。
  type LayerObj = Record<string, unknown>

  // GET：把隐私内容从 blob 合并回各层，返回 { layers[] } 供浏览器编辑
  function loadCharLayersFull(): { layers: LayerObj[] } {
    if (!fs.existsSync(configPath)) return { layers: [] }
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      const store = cfg.character_layers
      if (!store || !Array.isArray(store.layers)) return { layers: [] }
      const priv = readCharLayerPrivate()
      const layers = store.layers.map((l: LayerObj) => {
        const blob = (priv[l.id as string] as Record<string, unknown>) || {}
        const out: LayerObj = { ...l }
        const p = l.persona as Record<string, unknown> | undefined
        if (p && typeof p === 'object') {
          const bp = (blob.persona as Record<string, unknown>) || {}
          // persona.text=ViewVariantTexts(对象·10 视角变体)；negative 单条字符串
          out.persona = p.isPrivate ? { ...p, text: (bp.text as Record<string, unknown>) || {}, negative: (bp.negative as string) || '' } : p
        }
        const cr = l.char_reference as Record<string, unknown> | undefined
        if (cr && typeof cr === 'object') {
          out.char_reference = cr.isPrivate ? { ...cr, image_b64: (blob.charref_image as string) || '' } : cr
        }
        const rep = l.replacements as Record<string, unknown> | undefined
        if (rep && typeof rep === 'object') {
          const blobRepl = (blob.repl as Record<string, { from?: string; to?: string }>) || {}
          const rules = (Array.isArray(rep.rules) ? rep.rules : []).map((r: Record<string, unknown>) => {
            if (r.isPrivate && r.id) {
              const pv = blobRepl[r.id as string] || {}
              return { ...r, from: pv.from || '', to: pv.to || '' }
            }
            return r
          })
          out.replacements = { ...rep, rules }
        }
        return out
      })
      return { layers }
    } catch {
      return { layers: [] }
    }
  }

  // POST：按 isPrivate 把每层隐私抽进各自 blob，nai_config 里置空；【独立 GC】只删本库孤儿，绝不碰 augPrivatePath
  function saveCharLayers(body: { layers?: LayerObj[] }): void {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    const priv = readCharLayerPrivate()
    const inLayers = Array.isArray(body.layers) ? body.layers : []
    const keepIds = new Set<string>()

    const outLayers = inLayers.map((l: LayerObj) => {
      const id = String(l.id || '')
      keepIds.add(id)
      const blob: Record<string, unknown> = {}
      const out: LayerObj = { ...l }
      const p = l.persona as Record<string, unknown> | undefined
      if (p && typeof p === 'object') {
        if (p.isPrivate) {
          // text=ViewVariantTexts 对象整块进隐私文件、公开壳置空对象；negative 单条
          blob.persona = { text: (p.text && typeof p.text === 'object') ? p.text : {}, negative: typeof p.negative === 'string' ? p.negative : '' }
          out.persona = { ...p, text: {}, negative: '' }
        } else {
          out.persona = p
        }
      }
      const cr = l.char_reference as Record<string, unknown> | undefined
      if (cr && typeof cr === 'object') {
        if (cr.isPrivate) {
          blob.charref_image = typeof cr.image_b64 === 'string' ? cr.image_b64 : ''
          out.char_reference = { ...cr, image_b64: '' }
        } else {
          out.char_reference = cr
        }
      }
      const rep = l.replacements as Record<string, unknown> | undefined
      if (rep && typeof rep === 'object') {
        const blobRepl: Record<string, { from: string; to: string }> = {}
        const rules = (Array.isArray(rep.rules) ? rep.rules : []).map((r: Record<string, unknown>) => {
          if (r.isPrivate && r.id) {
            blobRepl[String(r.id)] = { from: typeof r.from === 'string' ? r.from : '', to: typeof r.to === 'string' ? r.to : '' }
            return { ...r, from: '', to: '' }
          }
          return r
        })
        if (Object.keys(blobRepl).length) blob.repl = blobRepl
        out.replacements = { ...rep, rules }
      }
      if (Object.keys(blob).length) priv[id] = blob
      else delete priv[id]
      return out
    })

    // 独立 GC：只删本库孤儿（keepIds 仅来自本库 layers）——绝不触碰 nai_augment_private.json
    for (const k of Object.keys(priv)) {
      if (!keepIds.has(k)) delete priv[k]
    }

    cfg.character_layers = { layers: outLayers }
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8')
    fs.mkdirSync(path.dirname(charLayerPrivatePath), { recursive: true })
    fs.writeFileSync(charLayerPrivatePath, JSON.stringify(priv, null, 2), 'utf-8')
  }

  // ── NAI 提交：全部翻译为终端统一工单，Node 不直连 NAI ──

  function resolveOutputDir(cfg: Record<string, unknown>): string {
    const folder = (cfg.output_folder as string) || 'output/nai'
    return path.isAbsolute(folder) ? folder : path.join(repoRoot, folder)
  }

  // 复用公开侧唯一翻译层 terminal_bridge，禁止在 TypeScript 内再造一份 RenderJob 格式。
  // stdout 只有脱敏投递回执；私密预设只在终端 worker 内合并。
  function runSubmitViaTerminal(payload: Record<string, unknown>, flags: string[]): Record<string, unknown> {
    const bridge = path.join(repoRoot, 'tools', 'terminal_bridge.py')
    const r = spawnSync('python3', ['-u', bridge, '--json-stdin', ...flags], {
      input: JSON.stringify(payload),
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    })
    const out = (r.stdout || '')
    const err = (r.stderr || '')
    if (r.status !== 0) {
      return { ok: false, error: (err || out || `terminal_bridge.py exit ${r.status}`).slice(-1600) }
    }
    try {
      const line = out.trim().split(/\r?\n/).filter(Boolean).at(-1) || ''
      return JSON.parse(line) as Record<string, unknown>
    } catch {
      return { ok: false, error: `终端回执解析失败：${(out || err).slice(-800)}` }
    }
  }

  // 旧读写函数暂留作迁移考古，但没有任何 HTTP 路由可调用它们。
  void loadPresetsFull
  void savePresets
  void loadCharLayersFull
  void saveCharLayers

  return {
    name: 'nai-bridge',
    configureServer(server) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      server.middlewares.use(async (req: any, res: any, next: any) => {
        const url = req.url as string | undefined
        if (!url) return next()
        if (!url.startsWith('/api/nai/') && !url.startsWith('/api/batch-plans')) return next()

        const send = (data: unknown, status = 200) => {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(data))
        }

        try {
          // ── NAI 配置（前端用）──
          if (url === '/api/nai/config' && req.method === 'GET') {
            return send(loadPublicConfig())
          }

          // ── 网页加装层编辑已正式退役 ──
          // 端点保留 410 回执，避免旧前端/脚本误以为保存成功；不再读写任何私设内容。
          if ((url === '/api/nai/aug-presets' || url === '/api/nai/char-layers')
              && (req.method === 'GET' || req.method === 'POST')) {
            return send({
              ok: false,
              retired: true,
              error: '网页加装层编辑已退役；请在“NAI 出图终端”桌面 App 中查看和修改预设。',
            }, 410)
          }

          // ── NAI 单次投递（前端循环调用，每次投 1 张工单） ──
          // body 是公开 payload，服务端只送给 terminal_bridge 翻译为统一工单：
          //   { positive, negative?, characters?, params?, count?, seed?, prefix?, char_reference? }
          // 顶层 char_reference 由 terminal_bridge 无损搬进工单；内部展开数组则由 bridge 明确拒绝。
          if (url === '/api/nai/submit' && req.method === 'POST') {
            const body = JSON.parse(await readBody(req))
            // 默认 count=1（前端循环时每次跑 1 张）
            if (body.count === undefined) body.count = 1
            const cfg = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf-8')) : {}
            // subfolder→output 折叠：对全部提交生效（不再仅加装分支）
            const baseOutput = body.output
              ? (path.isAbsolute(body.output) ? body.output : path.join(repoRoot, body.output))
              : resolveOutputDir(cfg)
            const subfolder = body.subfolder ? String(body.subfolder).replace(/[/\\:*?"<>|]/g, '_').slice(0, 80) : ''
            const outputDir = subfolder ? path.join(baseOutput, subfolder) : baseOutput
            const flags: string[] = []
            if (body.augment) flags.push('--augment')
            const result = runSubmitViaTerminal({
              positive: body.positive, negative: body.negative, characters: body.characters,
              params: body.params, count: body.count, seed: body.seed,
              prefix: body.prefix ?? '', output: outputDir,
              char_reference: body.char_reference,       // 显式角色参考（Precise Reference）→ 脚本内 letterbox+构造
              char_layer_assign: body.char_layer_assign,
              char_layer_views: body.char_layer_views,   // {slot: viewKey} 按帧 view 选 persona 变体
            }, flags)
            return send(result, result.ok ? 202 : 503)
          }

          // ── NAI 输出图片代理（前端预览用，浏览器读不到 file:// 路径，必须走 HTTP） ──
          // GET /api/nai/file?path=<absolute-path>
          // 安全：仅允许返回 nai 输出根目录之下的文件
          if (url.startsWith('/api/nai/file') && req.method === 'GET') {
            const u = new URL(url, 'http://localhost')
            const filePath = u.searchParams.get('path') || ''
            if (!filePath || !path.isAbsolute(filePath)) {
              res.writeHead(400); res.end('bad path'); return
            }
            const cfg = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf-8')) : {}
            const allowedRoot = path.resolve(resolveOutputDir(cfg))
            const resolved = path.resolve(filePath)
            if (!resolved.startsWith(allowedRoot + path.sep) && resolved !== allowedRoot) {
              res.writeHead(403); res.end('forbidden'); return
            }
            if (!fs.existsSync(resolved)) {
              res.writeHead(404); res.end('not found'); return
            }
            const ext = path.extname(resolved).toLowerCase()
            const ct = ext === '.png' ? 'image/png'
              : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
              : ext === '.webp' ? 'image/webp'
              : 'application/octet-stream'
            res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-store' })
            fs.createReadStream(resolved).pipe(res)
            return
          }

          // ── 更新全局默认参数 + 批次设置（写回 nai_config.json） ──
          // body: { default_params?: {...}, batch?: {...} }
          // 不允许通过此接口修改 api_key / proxy / output_folder（敏感字段保护）
          if (url === '/api/nai/defaults' && req.method === 'POST') {
            const body = JSON.parse(await readBody(req))
            if (!fs.existsSync(configPath)) return send({ error: 'nai_config.json 不存在' }, 404)
            const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
            if (body.default_params && typeof body.default_params === 'object') {
              cfg.default_params = { ...cfg.default_params, ...body.default_params }
            }
            if (body.batch && typeof body.batch === 'object') {
              cfg.batch = { ...cfg.batch, ...body.batch }
            }
            if (Array.isArray(body.size_presets)) {
              cfg.size_presets = body.size_presets
            }
            if (Array.isArray(body.default_base_blocks)) {
              // 新结构：数组替换
              cfg.default_base_blocks = body.default_base_blocks
            } else if (body.default_base_blocks && typeof body.default_base_blocks === 'object') {
              // 向后兼容：旧 Record 结构合并到现有
              cfg.default_base_blocks = Array.isArray(cfg.default_base_blocks)
                ? cfg.default_base_blocks  // 已经是新结构，旧 patch 忽略
                : { ...cfg.default_base_blocks, ...body.default_base_blocks }
            }
            fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8')
            return send({ ok: true })
          }

          // ── batch_plans CRUD ──
          // GET /api/batch-plans — 列出
          if (url === '/api/batch-plans' && req.method === 'GET') {
            if (!fs.existsSync(plansDir)) return send([])
            const files = fs.readdirSync(plansDir).filter(f => f.endsWith('.json'))
            const meta = files.map(f => {
              try {
                const data = JSON.parse(fs.readFileSync(path.join(plansDir, f), 'utf-8'))
                return { id: data.id, name: data.name, updatedAt: data.updatedAt, itemCount: data.items?.length || 0 }
              } catch { return null }
            }).filter(Boolean)
            return send(meta)
          }

          // GET /api/batch-plans/:id — 读取
          if (url.startsWith('/api/batch-plans/') && req.method === 'GET') {
            const id = url.replace('/api/batch-plans/', '').replace(/\?.*$/, '')
            const file = path.join(plansDir, `${id}.json`)
            if (!fs.existsSync(file)) return send({ error: 'not found' }, 404)
            return send(JSON.parse(fs.readFileSync(file, 'utf-8')))
          }

          // POST /api/batch-plans — 保存/覆盖
          if (url === '/api/batch-plans' && req.method === 'POST') {
            const body = JSON.parse(await readBody(req))
            if (!body.id || !body.name) return send({ error: 'id and name required' }, 400)
            fs.mkdirSync(plansDir, { recursive: true })
            const file = path.join(plansDir, `${body.id}.json`)
            fs.writeFileSync(file, JSON.stringify(body, null, 2), 'utf-8')
            return send({ ok: true })
          }

          // DELETE /api/batch-plans/:id — 删除
          if (url.startsWith('/api/batch-plans/') && req.method === 'DELETE') {
            const id = url.replace('/api/batch-plans/', '').replace(/\?.*$/, '')
            const file = path.join(plansDir, `${id}.json`)
            if (fs.existsSync(file)) fs.unlinkSync(file)
            return send({ ok: true })
          }

          next()
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          send({ error: msg }, 500)
        }
      })
    },
  }
}
