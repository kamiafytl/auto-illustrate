// 角色大类（E2 蓝图 §二/§三）：旧独立 tab CharacterManager.tsx 功能清单逐项对照移植（差异点4，
// 旧 tab 保留到 E5 才删）：角色卡列表/搜索/新建/删除、traits 10 视角矩阵、角色级负面词、
// 衣柜（增删改/默认衣服/衣服级负面词/预览图上传）、debounce 自动保存+同步指示、token 预算警告。
// 数据同源：useCharacters 共享 store（/api/characters 同端点）；预览图 /api/save-image 同端点。
// 新增（E2 动线）：角色卡与每套衣服带「选入编辑器」（卡内嵌该角色绑定衣柜=原则⑦双入口）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Character, Outfit, Perspective, Composition, ViewKey, ViewVariantTexts } from '../../types'
import { PERSPECTIVES, COMPOSITIONS, VIEW_KEYS } from '../../types'
import { useCharacters, emptyCharacter, emptyOutfit } from '../../hooks/useCharacters'
import { CopyBtn, PickBtn, matchText, slugId } from './parts'
import { applyCharacter, applyOutfit, type DocMutator } from './selectToEditor'
import { copyText } from '../../utils/clipboard'

// ── token 估算（= CharacterManager 原样） ──
function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if ((code >= 0x3000 && code <= 0x9fff) || (code >= 0xff00 && code <= 0xffef)) cjk++
    else other++
  }
  return Math.ceil(cjk + other / 4)
}

const TOKEN_WARN_THRESHOLD = 200

type SyncState = 'idle' | 'pending' | 'saved' | 'error'

function vk(p: Perspective, c: Composition): ViewKey {
  return `${p}_${c}` as ViewKey
}

function pickCopySource(texts: ViewVariantTexts, perspective: Perspective): string {
  const sameFull = texts[vk(perspective, 'full')]
  if (sameFull) return sameFull
  const otherFull = texts[vk(perspective === 'front' ? 'back' : 'front', 'full')]
  if (otherFull) return otherFull
  return texts.front_full || ''
}

function placeholderForCell(perspective: Perspective, composition: Composition): string {
  if (perspective === 'front' && composition === 'full') return '必填基线，例如：1girl, long black hair, blue eyes...'
  if (perspective === 'back' && composition === 'full') return '留空 → 用 front_full'
  if (perspective === 'back') return `留空 → back_full → front_${composition} → front_full`
  return '留空 → front_full'
}

export function CharactersPane({ search, onApply }: { search: string; onApply: (mutator: DocMutator) => void }) {
  const { characters, loading, saveCharacter, deleteCharacter } = useCharacters()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const selected = useMemo(() => characters.find((c) => c.id === selectedId) ?? null, [characters, selectedId])

  const filtered = useMemo(
    () => characters.filter((c) => matchText(search, c.name, c.note, ...c.outfits.map((o) => o.name))),
    [characters, search],
  )

  const handleNew = useCallback(async () => {
    const c = emptyCharacter()
    const ok = await saveCharacter(c)
    if (ok) setSelectedId(c.id)
  }, [saveCharacter])

  const handleDelete = useCallback(
    async (id: string) => {
      if (!confirm('确认删除该角色？')) return
      await deleteCharacter(id)
      if (selectedId === id) setSelectedId(null)
    },
    [deleteCharacter, selectedId],
  )

  return (
    <div>
      <div className="lib-section-header">角色 —— 角色卡 + 卡内嵌该角色绑定衣柜（同一份数据也汇总在原料·衣服格）</div>
      <div className="lib-group-header">
        角色卡 <span className="lib-header-count">({filtered.length})</span>
        <span className="lib-header-note">
          <button className="ltg-pick" type="button" onClick={handleNew}>+ 新建角色</button>
        </span>
      </div>
      {loading && <p className="lib-empty-hint">加载中...</p>}
      {!loading && filtered.length === 0 && <p className="lib-empty-hint">{search ? '没有匹配的角色' : '还没有角色，点上面「+ 新建角色」'}</p>}
      <div className="lib-char-grid">
        {filtered.map((c) => (
          <div
            key={c.id}
            id={slugId('characters', c.id)}
            className={`lib-char-card ${c.id === selectedId ? 'active' : ''}`}
            onClick={() => setSelectedId(c.id === selectedId ? null : c.id)}
          >
            <PreviewImage kind="char" id={c.id} size={80} readonly />
            <div className="lib-char-card-body">
              <div className="lib-char-card-name">{c.name || '未命名'}</div>
              <div className="lib-char-card-meta">{c.outfits.length} 套衣服 · 点击{c.id === selectedId ? '收起' : '展开'}编辑</div>
              {c.note && <div className="lib-char-card-note">{c.note}</div>}
              <div className="lib-btn-row" onClick={(event) => event.stopPropagation()}>
                <CopyBtn text={c.traits.front_full || ''} />
                <PickBtn onPick={() => onApply(applyCharacter(c))} />
              </div>
            </div>
          </div>
        ))}
      </div>
      {selected && (
        <CharacterEditor
          key={selected.id}
          character={selected}
          onSave={saveCharacter}
          onDelete={() => handleDelete(selected.id)}
          onApply={onApply}
        />
      )}
    </div>
  )
}

// ── 编辑器（= CharacterManager.CharacterEditor 原样：本地草稿+debounce 保存） ──
function CharacterEditor({ character, onSave, onDelete, onApply }: {
  character: Character
  onSave: (c: Character) => Promise<boolean>
  onDelete: () => void
  onApply: (mutator: DocMutator) => void
}) {
  const [draft, setDraft] = useState<Character>(character)
  const [sync, setSync] = useState<SyncState>('idle')

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
      setTimeout(() => setSync((s) => (s === 'saved' ? 'idle' : s)), 2000)
    } else {
      setSync('error')
    }
  }, [onSave])

  const scheduleSave = useCallback(() => {
    setSync('pending')
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(flushSave, 500)
  }, [flushSave])

  useEffect(() => () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      flushSave()
    }
  }, [flushSave])

  const patch = useCallback((p: Partial<Character>) => {
    setDraft((d) => ({ ...d, ...p }))
    scheduleSave()
  }, [scheduleSave])

  const patchTraits = useCallback((key: ViewKey, value: string | undefined) => {
    setDraft((d) => {
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
    setDraft((d) => ({ ...d, outfits: [...d.outfits, emptyOutfit()] }))
    scheduleSave()
  }, [scheduleSave])

  const updateOutfit = useCallback((outfitId: string, p: Partial<Outfit>) => {
    setDraft((d) => ({ ...d, outfits: d.outfits.map((o) => (o.id === outfitId ? { ...o, ...p } : o)) }))
    scheduleSave()
  }, [scheduleSave])

  const removeOutfit = useCallback((outfitId: string) => {
    if (!confirm('删除这套衣服？')) return
    setDraft((d) => ({
      ...d,
      outfits: d.outfits.filter((o) => o.id !== outfitId),
      default_outfit: d.default_outfit === outfitId ? undefined : d.default_outfit,
    }))
    scheduleSave()
  }, [scheduleSave])

  const setDefaultOutfit = useCallback((outfitId: string | undefined) => {
    patch({ default_outfit: outfitId })
  }, [patch])

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
    <div className="lib-cm-main">
      <header className="lib-cm-header">
        <PreviewImage kind="char" id={draft.id} size={140} />
        <div className="lib-cm-header-fields">
          <input className="lib-cm-name-input" value={draft.name} onChange={(e) => patch({ name: e.target.value })} placeholder="角色名" />
          <input className="lib-cm-note-input" value={draft.note || ''} onChange={(e) => patch({ note: e.target.value })} placeholder="备注（仅本地展示）" />
          <div className="lib-cm-header-row">
            <SyncIndicator state={sync} />
            <PickBtn onPick={() => onApply(applyCharacter(draft))} />
            <button className="knx-btn knx-btn-danger" type="button" onClick={onDelete}>删除角色</button>
          </div>
        </div>
      </header>

      {overBudget && (
        <div className="lib-cm-budget-warn">
          ⚠ 估算 traits.front_full + 单套衣服.front_full ≈ <strong>{totalEstimate}</strong> tokens，超过建议上限 {TOKEN_WARN_THRESHOLD}。建议精简文本，否则 NAI prompt 可能溢出。
        </div>
      )}

      <section className="lib-cm-section">
        <h3 className="lib-cm-section-title">🎭 角色特征（视角 × 构图 = 10 组合）</h3>
        <p className="lib-cm-section-hint">
          默认只显示 <strong>front_full 基线（必填）</strong>，点「展开」编辑其他视角。留空的组合按 fallback 链取值：back_X 缺 → back_full → front_X → front_full。
        </p>
        <VariantsMatrix texts={draft.traits} onChange={patchTraits} />
        <div className="lib-cm-negative">
          <label className="lib-cm-negative-label">
            🚫 角色级负面词
            <span className="lib-cm-negative-hint">
              出图时自动并入该角色 char-level 负向，叠加到该角色<strong>所有衣服</strong>。不占用正向 prompt 预算。⚠ 勿放与自身 cosplay 正向冲突的词。
            </span>
          </label>
          <textarea
            className="lib-cm-negative-textarea"
            value={draft.negative_text || ''}
            onChange={(e) => patch({ negative_text: e.target.value })}
            placeholder="如 short hair, very short hair（逗号分隔，留空=无角色级负面）"
          />
        </div>
      </section>

      <section className="lib-cm-section lib-cm-outfits-panel">
        <h3 className="lib-cm-section-title">👗 绑定衣柜（原则⑦：同一份数据也汇总在原料·衣服格）</h3>
        <p className="lib-cm-section-hint">每套衣服默认只显示缩略图 + 正·全身，点「展开」编辑全部 10 组合视角。选一个作为「默认衣服」。</p>
        <div className="lib-cm-outfits">
          {draft.outfits.length === 0 && <div className="lib-empty-hint">还没有衣服，点下方「+ 新衣服」</div>}
          {draft.outfits.map((o) => (
            <OutfitCard
              key={o.id}
              outfit={o}
              isDefault={draft.default_outfit === o.id}
              onUpdate={(p) => updateOutfit(o.id, p)}
              onRemove={() => removeOutfit(o.id)}
              onSetDefault={() => setDefaultOutfit(draft.default_outfit === o.id ? undefined : o.id)}
              onPick={() => onApply(applyOutfit(draft, o.id))}
            />
          ))}
        </div>
        <button className="knx-btn" type="button" onClick={addOutfit}>+ 新衣服</button>
      </section>

      <footer className="lib-cm-footer">
        <SyncIndicator state={sync} />
        <button className="knx-btn knx-btn-primary" type="button" onClick={flushSave}>✓ 立即保存到 characters.json</button>
      </footer>
    </div>
  )
}

// ── 10 组合矩阵（= CharacterManager.VariantsMatrix 原样） ──
function VariantsMatrix({ texts, onChange, expanded: expandedProp, onToggleExpanded }: {
  texts: ViewVariantTexts
  onChange: (key: ViewKey, value: string | undefined) => void
  expanded?: boolean
  onToggleExpanded?: () => void
}) {
  const [internalExpanded, setInternalExpanded] = useState(false)
  const expanded = expandedProp ?? internalExpanded
  const toggle = onToggleExpanded ?? (() => setInternalExpanded((e) => !e))
  const filledExtras = VIEW_KEYS.filter((k) => k !== 'front_full' && texts[k]?.trim()).length

  return (
    <div className="lib-cm-matrix">
      {!expanded ? (
        <MatrixCell perspective="front" composition="full" texts={texts} onChange={onChange} />
      ) : (
        <>
          <div className="lib-cm-matrix-header">
            <div />
            {PERSPECTIVES.map((p) => (
              <div key={p.id} className="lib-cm-matrix-col-label">
                <strong>{p.label}</strong>
                <span className="lib-cm-matrix-col-hint">{p.hint}</span>
              </div>
            ))}
          </div>
          {COMPOSITIONS.map((comp) => (
            <div key={comp.id} className="lib-cm-matrix-row">
              <div className="lib-cm-matrix-label">
                <strong>{comp.label}</strong>
                <span className="lib-cm-matrix-row-hint">{comp.hint}</span>
              </div>
              {PERSPECTIVES.map((p) => (
                <MatrixCell key={p.id} perspective={p.id} composition={comp.id} texts={texts} onChange={onChange} />
              ))}
            </div>
          ))}
        </>
      )}
      <button type="button" className="lib-cm-matrix-toggle" onClick={toggle}>
        {expanded ? '▲ 收起（只看正·全身）' : `▼ 展开全部 10 组合视角（牛仔/上半/中身/下半 + 背面）${filledExtras ? ` · 已填 ${filledExtras} 个` : ''}`}
      </button>
    </div>
  )
}

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

  const onToggleEnable = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (isRequired) return
    onChange(key, e.target.checked ? '' : undefined)
  }

  const onCopyFull = () => {
    onChange(key, pickCopySource(texts, perspective))
  }

  const cellClasses = ['lib-cm-cell', !enabled ? 'disabled' : '', overWarn ? 'over-warn' : ''].filter(Boolean).join(' ')

  return (
    <div className={cellClasses}>
      <div className="lib-cm-cell-header">
        <label className="lib-cm-cell-toggle">
          {isRequired ? (
            <span className="lib-cm-required-tag">必填</span>
          ) : (
            <input type="checkbox" checked={enabled} onChange={onToggleEnable} title="启用此组合（关闭=按 fallback 链取值）" />
          )}
          <code className="lib-cm-cell-key">{key}</code>
        </label>
        {composition !== 'full' || perspective !== 'front' ? (
          <button type="button" className="lib-cm-copy-full" title={`复制 ${perspective}_full 的内容到这里`} onClick={onCopyFull}>
            📋 复制 full
          </button>
        ) : null}
      </div>
      <textarea
        className="lib-cm-textarea"
        value={display}
        onChange={(e) => onChange(key, e.target.value)}
        disabled={!isRequired && !enabled}
        placeholder={placeholderForCell(perspective, composition)}
      />
      <div className="lib-cm-cell-stats">
        {display.length} 字 · 约 {tokens} tokens
        {overWarn && <span className="lib-cm-token-warn"> ⚠ 偏长</span>}
      </div>
    </div>
  )
}

// ── 衣服卡片（= CharacterManager.OutfitCard + E2 双入口按钮） ──
function OutfitCard({ outfit, isDefault, onUpdate, onRemove, onSetDefault, onPick }: {
  outfit: Outfit
  isDefault: boolean
  onUpdate: (p: Partial<Outfit>) => void
  onRemove: () => void
  onSetDefault: () => void
  onPick: () => void
}) {
  const [expanded, setExpanded] = useState(false)

  const patchTags = (key: ViewKey, value: string | undefined) => {
    const next: ViewVariantTexts = { ...outfit.tags }
    if (key === 'front_full') {
      next.front_full = value ?? ''
    } else {
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    onUpdate({ tags: next })
  }

  return (
    <div className={`lib-cm-outfit ${isDefault ? 'is-default' : ''} ${expanded ? 'is-expanded' : ''}`}>
      <div className="lib-cm-outfit-header">
        <PreviewImage kind="outfit" id={outfit.id} size={80} />
        <div className="lib-cm-outfit-fields">
          <input className="lib-cm-outfit-name" value={outfit.name} onChange={(e) => onUpdate({ name: e.target.value })} placeholder="衣服名" />
          <input className="lib-cm-outfit-note" value={outfit.note || ''} onChange={(e) => onUpdate({ note: e.target.value })} placeholder="备注..." />
          <input
            className="lib-cm-outfit-negative"
            value={outfit.negative_text || ''}
            onChange={(e) => onUpdate({ negative_text: e.target.value })}
            placeholder="🚫 衣服负面词（如帽衫 → hood up；并入该角色 char-level 负向）"
            title="出图时与角色级负面词叠加，注入该角色 char-level negative。不占用正向 prompt。"
          />
          <div className="lib-cm-outfit-row">
            <label className="lib-cm-default-radio">
              <input type="radio" checked={isDefault} onChange={onSetDefault} />
              默认衣服
            </label>
            <span className="ltg-btns">
              <button className="ltg-copy" type="button" onClick={() => void copyText(outfit.tags.front_full || '')}>复制</button>
              <button className="ltg-pick" type="button" onClick={onPick}>选入编辑器</button>
              <button className="ltg-copy" type="button" style={{ background: 'var(--knx-danger)' }} onClick={onRemove} title="删除衣服">×</button>
            </span>
          </div>
        </div>
      </div>
      <VariantsMatrix texts={outfit.tags} onChange={patchTags} expanded={expanded} onToggleExpanded={() => setExpanded((e) => !e)} />
    </div>
  )
}

// ── 预览图（= CharacterManager.PreviewImage 原样：/api/save-image 同端点） ──
function PreviewImage({ kind, id, size, readonly }: {
  kind: 'char' | 'outfit'
  id: string
  size: number
  readonly?: boolean
}) {
  const [version, setVersion] = useState(() => Date.now())
  const [missing, setMissing] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const keyName = `${kind}--${id}`
  const url = `/data/images/${keyName}_full.webp?t=${version}`

  useEffect(() => {
    setMissing(false)
    setVersion(Date.now())
  }, [id])

  const handleFile = useCallback(async (file: File) => {
    const dataUrl = await resizeAndEncode(file)
    await fetch('/api/save-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: keyName, image: dataUrl }),
    })
    setMissing(false)
    setVersion(Date.now())
  }, [keyName])

  const onClick = (event: React.MouseEvent) => {
    if (readonly) return
    event.stopPropagation()
    fileInputRef.current?.click()
  }

  return (
    <div
      className={`lib-cm-preview ${readonly ? 'readonly' : ''}`}
      style={{ width: size, height: size }}
      onClick={onClick}
      title={readonly ? '' : '点击替换图片'}
    >
      {!missing ? (
        <img src={url} alt="" onError={() => setMissing(true)} />
      ) : (
        <div className="lib-cm-preview-placeholder">{readonly ? '无图' : '+ 上传'}</div>
      )}
      {!readonly && (
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void handleFile(f)
            e.target.value = ''
          }}
        />
      )}
    </div>
  )
}

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

function SyncIndicator({ state }: { state: SyncState }) {
  if (state === 'idle') return <span className="lib-cm-sync idle">　</span>
  if (state === 'pending') return <span className="lib-cm-sync pending">⏳ 同步中...</span>
  if (state === 'saved') return <span className="lib-cm-sync saved">✓ 已同步</span>
  return <span className="lib-cm-sync error">✗ 同步失败</span>
}
