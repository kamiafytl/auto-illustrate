import { useState, useEffect, useMemo } from 'react'
import type { Recipe, TagEntry, Inspiration, TabId } from '../../types'
import { BLOCK_LABELS } from '../../types'

type EditTarget =
  | { type: 'recipe'; data: Recipe | null; navContext?: { block: string; category: string; group: string } }
  | { type: 'tag'; data: TagEntry | null; navContext?: { block: string; category: string } }
  | { type: 'inspiration'; data: Inspiration | null; navContext?: { inspType: string } }

interface EditorModalProps {
  target: EditTarget | null
  onSave: (type: TabId, data: unknown) => void
  onClose: () => void
  recipes: Recipe[]
  tags: TagEntry[]
}

export default function EditorModal({ target, onSave, onClose, recipes, tags }: EditorModalProps) {
  if (!target) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>×</button>
        {target.type === 'recipe' && (
          <RecipeForm
            data={target.data}
            onSave={d => onSave('recipes', d)}
            navContext={target.navContext}
            recipes={recipes}
          />
        )}
        {target.type === 'tag' && (
          <TagForm
            data={target.data}
            onSave={d => onSave('tags', d)}
            navContext={target.navContext}
            tags={tags}
          />
        )}
        {target.type === 'inspiration' && (
          <InspirationForm data={target.data} onSave={d => onSave('inspirations', d)} navContext={target.navContext} />
        )}
      </div>
    </div>
  )
}

// --- 配方编辑表单 ---
function RecipeForm({ data, onSave, navContext, recipes }: {
  data: Recipe | null
  onSave: (d: Recipe) => void
  navContext?: { block: string; category: string; group: string }
  recipes: Recipe[]
}) {
  const [form, setForm] = useState<Recipe>(() => {
    if (data) return data
    const block = navContext?.block || 'action'
    let category = navContext?.category || ''
    let group = navContext?.group || ''
    // 如果没有指定分类，用该block的第一个分类
    if (!category) {
      for (const r of recipes) {
        if (r.block === block && r.category) { category = r.category; break }
      }
    }
    // 如果没有指定分组，用该block+category的第一个分组
    if (!group) {
      for (const r of recipes) {
        if (r.block === block && r.category === category && r.group) { group = r.group; break }
      }
    }
    return {
      id: `recipe-${Date.now()}`,
      name: '', block, category, group,
      tags: '', note: '', image: null, source: 'manual' as const
    }
  })
  const [customCategory, setCustomCategory] = useState(false)
  const [customGroup, setCustomGroup] = useState(false)

  useEffect(() => {
    if (data) setForm(data)
  }, [data])

  const update = (field: keyof Recipe, value: string | null) => {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  const availableCategories = useMemo(() => {
    const cats = new Set<string>()
    for (const r of recipes) {
      if (r.block === form.block && r.category) cats.add(r.category)
    }
    return Array.from(cats)
  }, [recipes, form.block])

  const availableGroups = useMemo(() => {
    const groups = new Set<string>()
    for (const r of recipes) {
      if (r.block === form.block && r.category === form.category && r.group) groups.add(r.group)
    }
    return Array.from(groups)
  }, [recipes, form.block, form.category])

  const handleBlockChange = (block: string) => {
    const cats = new Set<string>()
    for (const r of recipes) {
      if (r.block === block && r.category) cats.add(r.category)
    }
    const catArr = Array.from(cats)
    const firstCat = catArr[0] || ''

    const groups = new Set<string>()
    for (const r of recipes) {
      if (r.block === block && r.category === firstCat && r.group) groups.add(r.group)
    }
    const groupArr = Array.from(groups)

    setForm(prev => ({ ...prev, block, category: firstCat, group: groupArr[0] || '' }))
    setCustomCategory(catArr.length === 0)
    setCustomGroup(groupArr.length === 0)
  }

  const handleCategoryChange = (category: string) => {
    const groups = new Set<string>()
    for (const r of recipes) {
      if (r.block === form.block && r.category === category && r.group) groups.add(r.group)
    }
    const groupArr = Array.from(groups)
    setForm(prev => ({ ...prev, category, group: groupArr[0] || '' }))
    setCustomGroup(groupArr.length === 0)
  }

  return (
    <div className="editor-form">
      <h2>{data ? '编辑配方' : '新增配方'}</h2>
      <label>
        名称
        <input value={form.name} onChange={e => update('name', e.target.value)} />
      </label>
      <label>
        区块
        <select value={form.block} onChange={e => handleBlockChange(e.target.value)}>
          {Object.entries(BLOCK_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </label>
      <label>
        分类
        {customCategory || availableCategories.length === 0 ? (
          <div className="combo-input">
            <input value={form.category} onChange={e => update('category', e.target.value)} placeholder="输入分类名..." />
            {availableCategories.length > 0 && (
              <button type="button" className="combo-toggle" onClick={() => setCustomCategory(false)}>选择</button>
            )}
          </div>
        ) : (
          <select value={form.category} onChange={e => {
            if (e.target.value === '__custom__') { setCustomCategory(true); update('category', '') }
            else handleCategoryChange(e.target.value)
          }}>
            {form.category && !availableCategories.includes(form.category) && (
              <option value={form.category}>{form.category}</option>
            )}
            {availableCategories.map(c => <option key={c} value={c}>{c}</option>)}
            <option value="__custom__">其他（手动输入）</option>
          </select>
        )}
      </label>
      <label>
        分组
        {customGroup || availableGroups.length === 0 ? (
          <div className="combo-input">
            <input value={form.group} onChange={e => update('group', e.target.value)} placeholder="输入分组名..." />
            {availableGroups.length > 0 && (
              <button type="button" className="combo-toggle" onClick={() => setCustomGroup(false)}>选择</button>
            )}
          </div>
        ) : (
          <select value={form.group} onChange={e => {
            if (e.target.value === '__custom__') { setCustomGroup(true); update('group', '') }
            else update('group', e.target.value)
          }}>
            {form.group && !availableGroups.includes(form.group) && (
              <option value={form.group}>{form.group}</option>
            )}
            {availableGroups.map(g => <option key={g} value={g}>{g}</option>)}
            <option value="__custom__">其他（手动输入）</option>
          </select>
        )}
      </label>
      {form.block === 'clothing' && form.category === '套装' ? (
        <>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
            10 视角×构图变体。tags（正·全身）为必填基线。中身/下半身互为兜底；其他留空 → back_X → back_full → front_X → front_full。
          </p>
          <label>
            Tags · 正·全身（基线，front_full，含鞋完整身体）
            <textarea rows={4} value={form.tags} onChange={e => update('tags', e.target.value)} />
          </label>
          <label>
            Tags · 正·牛仔（front_cowboy，大腿以上不含鞋）
            <textarea rows={3} value={form.tags_front_cowboy ?? form.tags_cowboy ?? ''} onChange={e => update('tags_front_cowboy', e.target.value)} />
          </label>
          <label>
            Tags · 正·上半身（front_upper，不含裙/下装）
            <textarea rows={3} value={form.tags_front_upper ?? form.tags_upper ?? ''} onChange={e => update('tags_front_upper', e.target.value)} />
          </label>
          <label>
            Tags · 正·中身（front_mid，腰部以下不含鞋·头出框）
            <textarea rows={3} value={form.tags_front_mid ?? ''} onChange={e => update('tags_front_mid', e.target.value)} />
          </label>
          <label>
            Tags · 正·下半身（front_lower，含鞋完整下半身）
            <textarea rows={3} value={form.tags_front_lower ?? ''} onChange={e => update('tags_front_lower', e.target.value)} />
          </label>
          <label>
            Tags · 背·全身（back_full）
            <textarea rows={3} value={form.tags_back_full ?? form.tags_back ?? ''} onChange={e => update('tags_back_full', e.target.value)} />
          </label>
          <label>
            Tags · 背·牛仔（back_cowboy）
            <textarea rows={3} value={form.tags_back_cowboy ?? ''} onChange={e => update('tags_back_cowboy', e.target.value)} />
          </label>
          <label>
            Tags · 背·上半身（back_upper）
            <textarea rows={3} value={form.tags_back_upper ?? ''} onChange={e => update('tags_back_upper', e.target.value)} />
          </label>
          <label>
            Tags · 背·中身（back_mid，腰部以下不含鞋）
            <textarea rows={3} value={form.tags_back_mid ?? ''} onChange={e => update('tags_back_mid', e.target.value)} />
          </label>
          <label>
            Tags · 背·下半身（back_lower，含鞋完整下半身）
            <textarea rows={3} value={form.tags_back_lower ?? ''} onChange={e => update('tags_back_lower', e.target.value)} />
          </label>
        </>
      ) : (
        <label>
          Tags
          <textarea rows={5} value={form.tags} onChange={e => update('tags', e.target.value)} />
        </label>
      )}
      {form.block === 'clothing' && (
        <label>
          🚫 负面词
          <textarea rows={2} value={form.negative_text ?? ''} onChange={e => update('negative_text', e.target.value)}
            placeholder="出图时并入负向（NAI 走 char-level negative），不占用正向预算。如帽衫 → hood up" />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            库内主版负面词。角色衣服(Character.outfits)单独维护各自的负面词，二者不自动同步。
          </span>
        </label>
      )}
      <label>
        备注
        <textarea rows={3} value={form.note} onChange={e => update('note', e.target.value)} />
      </label>
      <div className="form-actions">
        <button className="btn-save" onClick={() => onSave(form)}>保存</button>
      </div>
    </div>
  )
}

// --- Tag编辑表单 ---
function TagForm({ data, onSave, navContext, tags }: {
  data: TagEntry | null
  onSave: (d: TagEntry) => void
  navContext?: { block: string; category: string }
  tags: TagEntry[]
}) {
  const [form, setForm] = useState<TagEntry>(() => {
    if (data) return data
    const block = navContext?.block || 'expression'
    let category = navContext?.category || ''
    if (!category) {
      for (const t of tags) {
        if (t.block === block && t.category) { category = t.category; break }
      }
    }
    return { tag: '', name_zh: '', block, category, note: '', image: null }
  })
  const [customCategory, setCustomCategory] = useState(false)

  useEffect(() => {
    if (data) setForm(data)
  }, [data])

  const update = (field: keyof TagEntry, value: string | null) => {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  const availableCategories = useMemo(() => {
    const cats = new Set<string>()
    for (const t of tags) {
      if (t.block === form.block && t.category) cats.add(t.category)
    }
    return Array.from(cats)
  }, [tags, form.block])

  const handleBlockChange = (block: string) => {
    const cats = new Set<string>()
    for (const t of tags) {
      if (t.block === block && t.category) cats.add(t.category)
    }
    const catArr = Array.from(cats)
    setForm(prev => ({ ...prev, block, category: catArr[0] || '' }))
    setCustomCategory(catArr.length === 0)
  }

  return (
    <div className="editor-form">
      <h2>{data ? '编辑Tag' : '新增Tag'}</h2>
      <label>
        Tag
        <input value={form.tag} onChange={e => update('tag', e.target.value)} />
      </label>
      <label>
        中文名
        <input value={form.name_zh} onChange={e => update('name_zh', e.target.value)} />
      </label>
      <label>
        区块
        <select value={form.block} onChange={e => handleBlockChange(e.target.value)}>
          {Object.entries(BLOCK_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </label>
      <label>
        分类
        {customCategory || availableCategories.length === 0 ? (
          <div className="combo-input">
            <input value={form.category} onChange={e => update('category', e.target.value)} placeholder="输入分类名..." />
            {availableCategories.length > 0 && (
              <button type="button" className="combo-toggle" onClick={() => setCustomCategory(false)}>选择</button>
            )}
          </div>
        ) : (
          <select value={form.category} onChange={e => {
            if (e.target.value === '__custom__') { setCustomCategory(true); update('category', '') }
            else update('category', e.target.value)
          }}>
            {form.category && !availableCategories.includes(form.category) && (
              <option value={form.category}>{form.category}</option>
            )}
            {availableCategories.map(c => <option key={c} value={c}>{c}</option>)}
            <option value="__custom__">其他（手动输入）</option>
          </select>
        )}
      </label>
      <label>
        备注
        <textarea rows={3} value={form.note} onChange={e => update('note', e.target.value)} />
      </label>
      <div className="form-actions">
        <button className="btn-save" onClick={() => onSave(form)}>保存</button>
      </div>
    </div>
  )
}

// --- 灵感编辑表单 ---
function InspirationForm({ data, onSave, navContext }: {
  data: Inspiration | null
  onSave: (d: Inspiration) => void
  navContext?: { inspType: string }
}) {
  const [form, setForm] = useState<Inspiration>(() => data || {
    id: `insp-${Date.now()}`,
    text: '',
    type: (navContext?.inspType as Inspiration['type']) || '短故事',
    image: null,
    note: '',
    created: new Date().toISOString().slice(0, 10)
  })

  useEffect(() => {
    if (data) setForm(data)
  }, [data])

  const update = (field: keyof Inspiration, value: string | null) => {
    setForm(prev => ({ ...prev, [field]: value as never }))
  }

  return (
    <div className="editor-form">
      <h2>{data ? '编辑灵感' : '新增灵感'}</h2>
      <label>
        内容
        <textarea rows={4} value={form.text} onChange={e => update('text', e.target.value)} />
      </label>
      <label>
        类型
        <select value={form.type} onChange={e => update('type', e.target.value)}>
          <option value="长故事">长故事</option>
          <option value="短故事">短故事</option>
          <option value="视觉">视觉类</option>
          <option value="h视觉">h视觉</option>
        </select>
      </label>
      <label>
        备注
        <textarea rows={3} value={form.note} onChange={e => update('note', e.target.value)} />
      </label>
      <div className="form-actions">
        <button className="btn-save" onClick={() => onSave(form)}>保存</button>
      </div>
    </div>
  )
}
