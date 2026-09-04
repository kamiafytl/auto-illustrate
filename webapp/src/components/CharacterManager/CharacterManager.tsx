import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import type { Character, Outfit, Perspective, Composition, ViewKey, ViewVariantTexts } from '../../types'
import { PERSPECTIVES, COMPOSITIONS, VIEW_KEYS } from '../../types'
import { useCharacters, emptyCharacter, emptyOutfit } from '../../hooks/useCharacters'
import SearchBar from '../common/SearchBar'
import AutoGrowTextarea from '../common/AutoGrowTextarea'

// ── token 估算工具（粗略：英文 4 字符 ≈ 1 token，中文 1 字 ≈ 1 token） ──
function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    // CJK 范围：基本汉字 + 假名等
    if ((code >= 0x3000 && code <= 0x9fff) || (code >= 0xff00 && code <= 0xffef)) cjk++
    else other++
  }
  return Math.ceil(cjk + other / 4)
}

const TOKEN_WARN_THRESHOLD = 200

// 同步指示符状态
type SyncState = 'idle' | 'pending' | 'saved' | 'error'

// 拼接 ViewKey
function vk(p: Perspective, c: Composition): ViewKey {
  return `${p}_${c}` as ViewKey
}

// 取某个 cell 复制时的最佳 fallback 源（用于"复制 full"按钮）
// 规则：同视角的 _full → 反视角的 _full → front_full
function pickCopySource(texts: ViewVariantTexts, perspective: Perspective): string {
  const sameFull = texts[vk(perspective, 'full')]
  if (sameFull) return sameFull
  const otherFull = texts[vk(perspective === 'front' ? 'back' : 'front', 'full')]
  if (otherFull) return otherFull
  return texts.front_full || ''
}

// 单元格的占位提示文案（fallback 链可视化）
function placeholderForCell(perspective: Perspective, composition: Composition): string {
  if (perspective === 'front' && composition === 'full') {
    return '必填基线，例如：1girl, long black hair, blue eyes...'
  }
  // back_X 缺 → back_full → front_X → front_full
  if (perspective === 'back' && composition === 'full') {
    return '留空 → 用 front_full'
  }
  if (perspective === 'back') {
    return `留空 → back_full → front_${composition} → front_full`
  }
  // front 的非 full
  return `留空 → front_full`
}

// ── 主组件 ──
export default function CharacterManager() {
  const charsHook = useCharacters()
  const { characters, loading, saveCharacter, deleteCharacter } = charsHook

  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // 用 selectedId 解析当前编辑对象（从 hook 列表中取，保证乐观更新后立即可见）
  const selected = useMemo(
    () => characters.find(c => c.id === selectedId) ?? null,
    [characters, selectedId]
  )

  // 自动选第一个（如果当前未选）
  useEffect(() => {
    if (!loading && !selectedId && characters.length > 0) {
      setSelectedId(characters[0].id)
    }
  }, [loading, selectedId, characters])

  const filtered = useMemo(() => {
    if (!search.trim()) return characters
    const q = search.toLowerCase()
    return characters.filter(c =>
      c.name.toLowerCase().includes(q) ||
      (c.note || '').toLowerCase().includes(q)
    )
  }, [characters, search])

  const handleNew = useCallback(async () => {
    const c = emptyCharacter()
    const ok = await saveCharacter(c)
    if (ok) setSelectedId(c.id)
  }, [saveCharacter])

  const handleDelete = useCallback(async (id: string) => {
    if (!confirm('确认删除该角色？')) return
    await deleteCharacter(id)
    if (selectedId === id) setSelectedId(null)
  }, [deleteCharacter, selectedId])

  return (
    <div className="char-mgr">
      {/* 左栏：角色列表 */}
      <aside className="char-mgr-sidebar">
        <div className="char-mgr-sidebar-toolbar">
          <SearchBar value={search} onChange={setSearch} placeholder="搜索角色..." />
          <button className="btn btn-primary btn-small char-mgr-new-btn" onClick={handleNew}>
            + 新建角色
          </button>
        </div>
        <div className="char-mgr-list">
          {loading && <div className="char-mgr-empty">加载中...</div>}
          {!loading && filtered.length === 0 && (
            <div className="char-mgr-empty">{search ? '没有匹配的角色' : '还没有角色，点上面「+ 新建角色」'}</div>
          )}
          {filtered.map(c => (
            <CharacterCard
              key={c.id}
              character={c}
              active={c.id === selectedId}
              onClick={() => setSelectedId(c.id)}
            />
          ))}
        </div>
      </aside>

      {/* 右栏：编辑器 */}
      <main className="char-mgr-main">
        {selected ? (
          <CharacterEditor
            key={selected.id}
            character={selected}
            onSave={saveCharacter}
            onDelete={() => handleDelete(selected.id)}
          />
        ) : (
          <div className="char-mgr-placeholder">
            <p>从左侧选择一个角色，或者新建一个开始</p>
          </div>
        )}
      </main>
    </div>
  )
}

// ── 左栏卡片 ──
function CharacterCard({ character, active, onClick }: {
  character: Character
  active: boolean
  onClick: () => void
}) {
  return (
    <button className={`char-mgr-card ${active ? 'active' : ''}`} onClick={onClick}>
      <PreviewImage
        kind="char"
        id={character.id}
        size={80}
        readonly
      />
      <div className="char-mgr-card-body">
        <div className="char-mgr-card-name">{character.name || '未命名'}</div>
        <div className="char-mgr-card-meta">{character.outfits.length} 套衣服</div>
        {character.note && <div className="char-mgr-card-note">{character.note}</div>}
      </div>
    </button>
  )
}

// ── 右栏编辑器 ──
function CharacterEditor({ character, onSave, onDelete }: {
  character: Character
  onSave: (c: Character) => Promise<boolean>
  onDelete: () => void
}) {
  // 本地草稿：所有 input 改动先存这里实现乐观更新，blur 后 debounce 保存
  const [draft, setDraft] = useState<Character>(character)
  const [sync, setSync] = useState<SyncState>('idle')

  // 外部 character 引用变化时（例如其他面板编辑后重新加载）同步草稿
  // 仅当 id 切换或 updatedAt 改变时才覆盖（避免边敲边被覆盖）
  const lastSeenUpdatedRef = useRef<string | undefined>(character.updatedAt)
  useEffect(() => {
    if (character.id !== draft.id) {
      setDraft(character)
      lastSeenUpdatedRef.current = character.updatedAt
      setSync('idle')
      return
    }
    if (character.updatedAt && character.updatedAt !== lastSeenUpdatedRef.current && sync === 'idle') {
      setDraft(character)
      lastSeenUpdatedRef.current = character.updatedAt
    }
  }, [character, draft.id, sync])

  // ── debounce 保存 ──
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingDraftRef = useRef<Character>(draft)
  pendingDraftRef.current = draft

  const flushSave = useCallback(async () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    const toSave = pendingDraftRef.current
    setSync('pending')
    const ok = await onSave(toSave)
    if (ok) {
      lastSeenUpdatedRef.current = new Date().toISOString()
      setSync('saved')
      // 2秒后回到 idle
      setTimeout(() => setSync(s => s === 'saved' ? 'idle' : s), 2000)
    } else {
      setSync('error')
    }
  }, [onSave])

  const scheduleSave = useCallback(() => {
    setSync('pending')
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(flushSave, 500)
  }, [flushSave])

  // 卸载或切换角色前 flush
  useEffect(() => () => { if (debounceRef.current) { clearTimeout(debounceRef.current); flushSave() } }, [flushSave])

  // ── 草稿修改工具 ──
  const patch = useCallback((p: Partial<Character>) => {
    setDraft(d => ({ ...d, ...p }))
    scheduleSave()
  }, [scheduleSave])

  const patchTraits = useCallback((key: ViewKey, value: string | undefined) => {
    setDraft(d => {
      const next: ViewVariantTexts = { ...d.traits }
      if (key === 'front_full') {
        next.front_full = value ?? ''
      } else {
        if (value === undefined) delete next[key]
        else next[key] = value
      }
      return { ...d, traits: next }
    })
    scheduleSave()
  }, [scheduleSave])

  const addOutfit = useCallback(() => {
    setDraft(d => ({ ...d, outfits: [...d.outfits, emptyOutfit()] }))
    scheduleSave()
  }, [scheduleSave])

  const updateOutfit = useCallback((outfitId: string, p: Partial<Outfit>) => {
    setDraft(d => ({
      ...d,
      outfits: d.outfits.map(o => o.id === outfitId ? { ...o, ...p } : o),
    }))
    scheduleSave()
  }, [scheduleSave])

  const removeOutfit = useCallback((outfitId: string) => {
    if (!confirm('删除这套衣服？')) return
    setDraft(d => ({
      ...d,
      outfits: d.outfits.filter(o => o.id !== outfitId),
      default_outfit: d.default_outfit === outfitId ? undefined : d.default_outfit,
    }))
    scheduleSave()
  }, [scheduleSave])

  const setDefaultOutfit = useCallback((outfitId: string | undefined) => {
    patch({ default_outfit: outfitId })
  }, [patch])

  // ── token 警告：traits.front_full + 最大单套 outfit.front_full ──
  const traitsFullTokens = estimateTokens(draft.traits.front_full || '')
  const maxOutfitFullTokens = useMemo(() => {
    let max = 0
    for (const o of draft.outfits) {
      const t = estimateTokens(o.tags.front_full || '')
      if (t > max) max = t
    }
    return max
  }, [draft.outfits])
  const totalEstimate = traitsFullTokens + maxOutfitFullTokens
  const overBudget = totalEstimate > TOKEN_WARN_THRESHOLD

  return (
    <div className="char-mgr-editor">
      {/* 顶部：名字 / 预览图 / 删除 / 同步指示 */}
      <header className="char-mgr-editor-header">
        <PreviewImage kind="char" id={draft.id} size={140} />
        <div className="char-mgr-editor-header-fields">
          <input
            className="char-mgr-name-input"
            value={draft.name}
            onChange={e => patch({ name: e.target.value })}
            placeholder="角色名"
          />
          <input
            className="char-mgr-note-input"
            value={draft.note || ''}
            onChange={e => patch({ note: e.target.value })}
            placeholder="备注（仅本地展示）"
          />
          <div className="char-mgr-editor-header-row">
            <SyncIndicator state={sync} />
            <button className="btn btn-danger btn-small" onClick={onDelete}>删除角色</button>
          </div>
        </div>
      </header>

      {/* token 总预算警告 */}
      {overBudget && (
        <div className="char-mgr-budget-warn">
          ⚠ 估算 traits.front_full + 单套衣服.front_full ≈ <strong>{totalEstimate}</strong> tokens，超过建议上限 {TOKEN_WARN_THRESHOLD}。建议精简文本，否则 NAI prompt 可能溢出。
        </div>
      )}

      {/* 角色特征区段 */}
      <section className="char-mgr-section char-mgr-section-traits">
        <h3 className="char-mgr-section-title">🎭 角色特征（视角 × 构图 = 10 组合）</h3>
        <p className="char-mgr-section-hint">
          默认只显示 <strong>front_full 基线（必填）</strong>，点「展开」编辑其他视角。
          留空的组合按 fallback 链取值：back_X 缺 → back_full → front_X → front_full。
        </p>
        <VariantsMatrix
          texts={draft.traits}
          onChange={patchTraits}
        />
        <div className="char-mgr-negative">
          <label className="char-mgr-negative-label">
            🚫 角色级负面词
            <span className="char-mgr-negative-hint">
              出图时自动并入该角色 char-level 负向，叠加到该角色<strong>所有衣服</strong>。不占用正向 prompt 预算。
              用于强化默认状态（如长发披发 → 负 short hair）。⚠ 勿放与自身 cosplay 正向冲突的词（如该角色有双马尾 cosplay，就别在这放 twintails）。
            </span>
          </label>
          <AutoGrowTextarea
            className="char-mgr-negative-textarea"
            value={draft.negative_text || ''}
            onChange={v => patch({ negative_text: v })}
            minRows={2}
            placeholder="如 short hair, very short hair（逗号分隔，留空=无角色级负面）"
          />
        </div>
      </section>

      {/* 衣服库区段 */}
      <section className="char-mgr-section char-mgr-section-outfits">
        <h3 className="char-mgr-section-title">👗 衣服库</h3>
        <p className="char-mgr-section-hint">
          每套衣服默认只显示缩略图 + 正·全身，点「展开」编辑全部 10 组合视角。选一个作为「默认衣服」(出图时未指定 outfit 时用它)。
        </p>
        <div className="char-mgr-outfits">
          {draft.outfits.length === 0 && (
            <div className="char-mgr-empty">还没有衣服，点下方「+ 新衣服」</div>
          )}
          {draft.outfits.map(o => (
            <OutfitCard
              key={o.id}
              outfit={o}
              isDefault={draft.default_outfit === o.id}
              onUpdate={p => updateOutfit(o.id, p)}
              onRemove={() => removeOutfit(o.id)}
              onSetDefault={() => setDefaultOutfit(draft.default_outfit === o.id ? undefined : o.id)}
            />
          ))}
        </div>
        <button className="btn btn-secondary btn-small char-mgr-add-outfit" onClick={addOutfit}>
          + 新衣服
        </button>
      </section>

      {/* 底部：手动保存按钮（保险用，正常 blur 已自动保存） */}
      <footer className="char-mgr-editor-footer">
        <SyncIndicator state={sync} />
        <button className="btn btn-primary" onClick={flushSave}>
          ✓ 立即保存到 characters.json
        </button>
      </footer>
    </div>
  )
}

// ── 10 组合矩阵编辑器（角色 traits 与 outfit tags 共用） ──
// 默认折叠：只显示 front_full 基线，点「展开」才显示 2 列（视角）× 5 行（构图）全矩阵
function VariantsMatrix({ texts, onChange, expanded: expandedProp, onToggleExpanded }: {
  texts: ViewVariantTexts
  onChange: (key: ViewKey, value: string | undefined) => void
  // 可选受控：不传则自己管理（角色特征用内部 state，衣服卡片用外部 state 以联动整行宽度）
  expanded?: boolean
  onToggleExpanded?: () => void
}) {
  const [internalExpanded, setInternalExpanded] = useState(false)
  const expanded = expandedProp ?? internalExpanded
  const toggle = onToggleExpanded ?? (() => setInternalExpanded(e => !e))
  // 已填写的非基线变体数量（折叠时提示用）
  const filledExtras = VIEW_KEYS.filter(k => k !== 'front_full' && (texts[k]?.trim())).length

  return (
    <div className="char-mgr-matrix">
      {!expanded ? (
        // 折叠态：只显示正·全身基线一格，占满宽度
        <div className="char-mgr-matrix-primary">
          <MatrixCell
            perspective="front"
            composition="full"
            texts={texts}
            onChange={onChange}
          />
        </div>
      ) : (
        <>
          {/* 顶部视角标签行 */}
          <div className="char-mgr-matrix-header">
            <div className="char-mgr-matrix-corner" />
            {PERSPECTIVES.map(p => (
              <div key={p.id} className="char-mgr-matrix-col-label">
                <strong>{p.label}</strong>
                <span className="char-mgr-matrix-col-hint">{p.hint}</span>
              </div>
            ))}
          </div>

          {/* 每行一个构图 */}
          {COMPOSITIONS.map(comp => (
            <div key={comp.id} className="char-mgr-matrix-row">
              <div className="char-mgr-matrix-label">
                <strong>{comp.label}</strong>
                <span className="char-mgr-matrix-row-hint">{comp.hint}</span>
              </div>
              {PERSPECTIVES.map(p => (
                <MatrixCell
                  key={p.id}
                  perspective={p.id}
                  composition={comp.id}
                  texts={texts}
                  onChange={onChange}
                />
              ))}
            </div>
          ))}
        </>
      )}

      <button
        type="button"
        className="char-mgr-matrix-toggle"
        onClick={toggle}
      >
        {expanded
          ? '▲ 收起（只看正·全身）'
          : `▼ 展开全部 10 组合视角（牛仔/上半/中身/下半 + 背面）${filledExtras ? ` · 已填 ${filledExtras} 个` : ''}`}
      </button>
    </div>
  )
}

// ── 单个矩阵单元格 ──
function MatrixCell({ perspective, composition, texts, onChange }: {
  perspective: Perspective
  composition: Composition
  texts: ViewVariantTexts
  onChange: (key: ViewKey, value: string | undefined) => void
}) {
  const key = vk(perspective, composition)
  const isRequired = key === 'front_full'
  const value = texts[key]
  const enabled = isRequired ? true : value !== undefined
  const display = value ?? ''
  const tokens = estimateTokens(display)
  const overWarn = tokens > TOKEN_WARN_THRESHOLD

  const onToggleEnable = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (isRequired) return
    if (e.target.checked) {
      // 启用 = 设为空字符串（不再 undefined）
      onChange(key, '')
    } else {
      onChange(key, undefined)
    }
  }, [isRequired, key, onChange])

  const onCopyFull = useCallback(() => {
    // 复制规则：同视角 _full → 反视角 _full → front_full
    const src = pickCopySource(texts, perspective)
    onChange(key, src)
  }, [texts, perspective, key, onChange])

  const cellClasses = [
    'char-mgr-matrix-cell',
    isRequired ? 'required' : '',
    !enabled ? 'disabled' : '',
    overWarn ? 'over-warn' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={cellClasses}>
      <div className="char-mgr-matrix-cell-header">
        <label className="char-mgr-matrix-cell-toggle">
          {isRequired ? (
            <span className="char-mgr-required-tag">必填</span>
          ) : (
            <input
              type="checkbox"
              checked={enabled}
              onChange={onToggleEnable}
              title="启用此组合（关闭=按 fallback 链取值）"
            />
          )}
          <code className="char-mgr-matrix-cell-key">{key}</code>
        </label>
        {composition !== 'full' || perspective !== 'front' ? (
          <button
            type="button"
            className="btn-icon char-mgr-matrix-copy"
            title={`复制 ${perspective}_full 的内容到这里（同视角缺则反视角→front_full）`}
            onClick={onCopyFull}
          >
            📋 复制 full
          </button>
        ) : null}
      </div>
      <AutoGrowTextarea
        className="char-mgr-matrix-textarea"
        value={display}
        onChange={v => onChange(key, v)}
        disabled={!isRequired && !enabled}
        minRows={2}
        placeholder={placeholderForCell(perspective, composition)}
      />
      <div className="char-mgr-matrix-cell-stats">
        {display.length} 字 · 约 {tokens} tokens
        {overWarn && <span className="char-mgr-token-warn"> ⚠ 偏长</span>}
      </div>
    </div>
  )
}

// ── 衣服卡片 ──
function OutfitCard({ outfit, isDefault, onUpdate, onRemove, onSetDefault }: {
  outfit: Outfit
  isDefault: boolean
  onUpdate: (p: Partial<Outfit>) => void
  onRemove: () => void
  onSetDefault: () => void
}) {
  const [expanded, setExpanded] = useState(false)

  const patchTags = useCallback((key: ViewKey, value: string | undefined) => {
    const next: ViewVariantTexts = { ...outfit.tags }
    if (key === 'front_full') {
      next.front_full = value ?? ''
    } else {
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    onUpdate({ tags: next })
  }, [outfit.tags, onUpdate])

  return (
    <div className={`char-mgr-outfit ${isDefault ? 'is-default' : ''} ${expanded ? 'is-expanded' : ''}`}>
      <div className="char-mgr-outfit-header">
        <PreviewImage kind="outfit" id={outfit.id} size={80} />
        <div className="char-mgr-outfit-header-fields">
          <input
            className="char-mgr-outfit-name"
            value={outfit.name}
            onChange={e => onUpdate({ name: e.target.value })}
            placeholder="衣服名"
          />
          <input
            className="char-mgr-outfit-note"
            value={outfit.note || ''}
            onChange={e => onUpdate({ note: e.target.value })}
            placeholder="备注..."
          />
          <input
            className="char-mgr-outfit-negative"
            value={outfit.negative_text || ''}
            onChange={e => onUpdate({ negative_text: e.target.value })}
            placeholder="🚫 衣服负面词（如帽衫 → hood up；并入该角色 char-level 负向）"
            title="出图时与角色级负面词叠加，注入该角色 char-level negative。不占用正向 prompt。"
          />
          <div className="char-mgr-outfit-header-row">
            <label className="char-mgr-default-radio">
              <input type="radio" checked={isDefault} onChange={onSetDefault} />
              默认衣服
            </label>
            <button className="btn-icon btn-icon-danger" onClick={onRemove} title="删除衣服">×</button>
          </div>
        </div>
      </div>
      <VariantsMatrix
        texts={outfit.tags}
        onChange={patchTags}
        expanded={expanded}
        onToggleExpanded={() => setExpanded(e => !e)}
      />
    </div>
  )
}

// ── 预览图组件 ──
// kind=char → key=`char--<id>`；kind=outfit → key=`outfit--<id>`
// 后端通过 /api/save-image 上传，URL 形如 /data/images/<sanitizedKey>_full.webp
function PreviewImage({ kind, id, size, readonly }: {
  kind: 'char' | 'outfit'
  id: string
  size: number
  readonly?: boolean
}) {
  // 用版本戳触发缓存刷新（保存后递增）
  const [version, setVersion] = useState(() => Date.now())
  const [missing, setMissing] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const keyName = `${kind}--${id}`
  const url = `/data/images/${keyName}_full.webp?t=${version}`

  // id 切换时重置 missing 状态
  useEffect(() => { setMissing(false); setVersion(Date.now()) }, [id])

  const handleFile = useCallback(async (file: File) => {
    // 调用 useImageStore 的同款压缩流程：转 webp data URL
    const dataUrl = await resizeAndEncode(file)
    await fetch('/api/save-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: keyName, image: dataUrl }),
    })
    setMissing(false)
    setVersion(Date.now())
  }, [keyName])

  const onClick = () => {
    if (readonly) return
    fileInputRef.current?.click()
  }

  return (
    <div
      className={`char-mgr-preview ${readonly ? 'readonly' : ''}`}
      style={{ width: size, height: size }}
      onClick={onClick}
      title={readonly ? '' : '点击替换图片'}
    >
      {!missing ? (
        <img
          src={url}
          alt=""
          onError={() => setMissing(true)}
        />
      ) : (
        <div className="char-mgr-preview-placeholder">
          {readonly ? '无图' : '+ 上传'}
        </div>
      )}
      {!readonly && (
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={e => {
            const f = e.target.files?.[0]
            if (f) handleFile(f)
            e.target.value = ''
          }}
        />
      )}
    </div>
  )
}

// 复用 useImageStore 的压缩逻辑（独立实现，避免暴露 hook 内部）
async function resizeAndEncode(file: File, maxSize = 1200): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height))
      const w = Math.round(img.width * scale)
      const h = Math.round(img.height * scale)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0, w, h)
      resolve(canvas.toDataURL('image/webp', 0.85))
    }
    img.onerror = reject
    img.src = url
  })
}

// ── 同步指示符 ──
function SyncIndicator({ state }: { state: SyncState }) {
  if (state === 'idle') return <span className="char-mgr-sync idle">　</span>
  if (state === 'pending') return <span className="char-mgr-sync pending">⏳ 同步中...</span>
  if (state === 'saved') return <span className="char-mgr-sync saved">✓ 已同步</span>
  return <span className="char-mgr-sync error">✗ 同步失败</span>
}
