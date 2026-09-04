import { useState, useMemo } from 'react'
import {
  PERSPECTIVES, COMPOSITIONS, getViewText,
  type Character, type Outfit, type Perspective, type Composition, type ViewKey,
} from '../../types'

interface Props {
  characters: Character[]
  onPick: (result: { name: string; text: string; negative: string; view: ViewKey }) => void
  onClose: () => void
}

/**
 * 角色选择对话框：选角色 → 选衣服 → 选视角(2) + 构图(4) → 确认
 * 输出 prompt = traits[v,c] + outfit.tags[v,c]
 * 输出 negative = 角色级负面词 + 所选衣服负面词（合并为该角色 char-level negative）
 */
export default function CharacterPickerDialog({ characters, onPick, onClose }: Props) {
  const [search, setSearch] = useState('')
  const [selectedCharId, setSelectedCharId] = useState<string | null>(null)
  const [selectedOutfitId, setSelectedOutfitId] = useState<string | null>(null)
  const [perspective, setPerspective] = useState<Perspective>('front')
  const [composition, setComposition] = useState<Composition>('full')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return characters
    return characters.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.outfits.some(o => o.name.toLowerCase().includes(q))
    )
  }, [characters, search])

  const selectedChar = characters.find(c => c.id === selectedCharId) || null
  const effectiveOutfit: Outfit | null = (() => {
    if (!selectedChar) return null
    if (selectedOutfitId === '__none__') return null
    if (selectedOutfitId) {
      const found = selectedChar.outfits.find(o => o.id === selectedOutfitId)
      if (found) return found
    }
    if (selectedChar.default_outfit) {
      const def = selectedChar.outfits.find(o => o.id === selectedChar.default_outfit)
      if (def) return def
    }
    return selectedChar.outfits[0] || null
  })()

  const preview = (() => {
    if (!selectedChar) return ''
    const traits = getViewText(selectedChar.traits, perspective, composition)
    const outfit = effectiveOutfit ? getViewText(effectiveOutfit.tags, perspective, composition) : ''
    const parts = [traits, outfit].filter(s => s.trim())
    return parts.join(', ')
  })()

  const tokenEstimate = (() => {
    let t = 0
    for (const ch of preview) {
      if (/[一-龥぀-ヿ]/.test(ch)) t += 1
      else t += 0.25
    }
    return Math.ceil(t)
  })()

  const handlePickChar = (c: Character) => {
    setSelectedCharId(c.id)
    setSelectedOutfitId(c.default_outfit || c.outfits[0]?.id || null)
  }

  // 合并角色级 + 衣服级负面词（去重、过滤空）→ 该角色 char-level negative
  const mergedNegative = (() => {
    if (!selectedChar) return ''
    const parts: string[] = []
    const push = (s?: string) => {
      for (const t of (s || '').split(',')) {
        const w = t.trim()
        if (w && !parts.includes(w)) parts.push(w)
      }
    }
    push(selectedChar.negative_text)
    push(effectiveOutfit?.negative_text)
    return parts.join(', ')
  })()

  const handleConfirm = () => {
    if (!selectedChar) return
    const p = PERSPECTIVES.find(x => x.id === perspective)
    const c = COMPOSITIONS.find(x => x.id === composition)
    const name = [selectedChar.name, effectiveOutfit?.name, `${p?.label}·${c?.label}`]
      .filter(Boolean).join(' / ')
    onPick({ name, text: preview, negative: mergedNegative, view: `${perspective}_${composition}` as ViewKey })
  }

  return (
    <div className="nai-batch-dialog-overlay" onClick={onClose}>
      <div className="char-picker-dialog" onClick={e => e.stopPropagation()}>
        <h4>从角色库选 — 选择角色、衣服、视角与构图</h4>

        {characters.length === 0 ? (
          <p className="char-picker-empty">尚未创建角色，去「角色」tab 创建一个。</p>
        ) : (
          <>
            <input type="text" className="char-picker-search"
              placeholder="按角色名 / 衣服名搜索..."
              value={search} onChange={e => setSearch(e.target.value)} />

            {/* ① 选角色 */}
            <div className="char-picker-section">
              <label className="char-picker-section-label">① 选角色</label>
              <div className="char-picker-grid">
                {filtered.map(c => (
                  <button key={c.id}
                    className={`char-picker-card ${selectedCharId === c.id ? 'active' : ''}`}
                    onClick={() => handlePickChar(c)}>
                    <div className="char-picker-card-preview">
                      <img src={`/data/images/char--${c.id}_full.webp`} alt={c.name}
                        onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                    </div>
                    <div className="char-picker-card-name">{c.name}</div>
                    <div className="char-picker-card-meta">{c.outfits.length} 套衣服</div>
                  </button>
                ))}
              </div>
            </div>

            {/* ② 选衣服 */}
            {selectedChar && (
              <div className="char-picker-section">
                <label className="char-picker-section-label">② 选衣服</label>
                {selectedChar.outfits.length === 0 ? (
                  <p className="char-picker-hint">该角色无衣服。仅用角色 traits。</p>
                ) : (
                  <div className="char-picker-outfits">
                    {selectedChar.outfits.map(o => (
                      <button key={o.id}
                        className={`char-picker-outfit-card ${effectiveOutfit?.id === o.id ? 'active' : ''}`}
                        onClick={() => setSelectedOutfitId(o.id)}>
                        <div className="char-picker-outfit-preview">
                          <img src={`/data/images/outfit--${o.id}_full.webp`} alt={o.name}
                            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                        </div>
                        <div className="char-picker-outfit-name">
                          {o.name}
                          {selectedChar.default_outfit === o.id && <span className="char-picker-default-tag">默认</span>}
                        </div>
                      </button>
                    ))}
                    <button
                      className={`char-picker-outfit-card no-outfit ${selectedOutfitId === '__none__' ? 'active' : ''}`}
                      onClick={() => setSelectedOutfitId('__none__')}
                      title="只用角色 traits，不加衣服">
                      <div className="char-picker-outfit-preview empty">∅</div>
                      <div className="char-picker-outfit-name">（不穿衣服 prompt）</div>
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ③ 选视角 */}
            {selectedChar && (
              <div className="char-picker-section">
                <label className="char-picker-section-label">③ 视角（角色朝向）</label>
                <div className="char-picker-views" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                  {PERSPECTIVES.map(p => (
                    <button key={p.id}
                      className={`char-picker-view ${perspective === p.id ? 'active' : ''}`}
                      onClick={() => setPerspective(p.id)}
                      title={p.hint}>
                      {p.label}
                      <span className="char-picker-view-hint">{p.hint}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* ④ 选构图 */}
            {selectedChar && (
              <div className="char-picker-section">
                <label className="char-picker-section-label">④ 构图（镜头范围）</label>
                <div className="char-picker-views">
                  {COMPOSITIONS.map(c => (
                    <button key={c.id}
                      className={`char-picker-view ${composition === c.id ? 'active' : ''}`}
                      onClick={() => setComposition(c.id)}
                      title={c.hint}>
                      {c.label}
                      <span className="char-picker-view-hint">{c.hint}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 预览 */}
            {selectedChar && preview && (
              <div className="char-picker-preview">
                <div className="char-picker-preview-header">
                  生成的 prompt 预览
                  <span className={`char-picker-token ${tokenEstimate > 60 ? 'warn' : ''}`}>
                    ≈ {tokenEstimate} tokens
                  </span>
                </div>
                <pre>{preview}</pre>
                {mergedNegative && (
                  <div className="char-picker-preview-neg">
                    <span className="char-picker-preview-neg-label">↳ char-level 负面词（自动并入该角色负向）</span>
                    <pre>{mergedNegative}</pre>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        <div className="nai-batch-dialog-actions">
          <button className="btn btn-secondary btn-small" onClick={onClose}>取消</button>
          <button className="btn btn-primary btn-small" onClick={handleConfirm}
            disabled={!selectedChar || !preview}>确认填入</button>
        </div>
      </div>
    </div>
  )
}
