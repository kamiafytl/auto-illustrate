import { useMemo, useState } from 'react'
import { createRecord, deleteRecord, updateRecord } from '../api'
import type { CharacterRecord, DataRecord, TableManifest, ToastState, ViewMap } from '../types'
import { viewKeys, viewLabels } from '../types'

type Props = {
  manifest: TableManifest
  records: DataRecord[]
  loading: boolean
  onReload: () => Promise<void>
  onToast: (toast: ToastState) => void
}

function valueText(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : String(value)
}

function asCharacter(record: DataRecord): CharacterRecord {
  return {
    id: valueText(record.id),
    name: valueText(record.name),
    preview_image: typeof record.preview_image === 'string' ? record.preview_image : null,
    traits: isViewMap(record.traits) ? record.traits : emptyViews(),
    outfits: Array.isArray(record.outfits) ? record.outfits.map(asOutfit) : [],
    negative_text: valueText(record.negative_text),
    __file: valueText(record.__file),
  }
}

function asOutfit(value: unknown) {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  // 先铺原始对象，保留 UI 不渲染的额外字段（如 outfit.note），再规范化已知字段，
  // 避免「outfits 整体替换」时丢字段（服务端只对记录顶层做保留式 merge，嵌套数组是整体覆盖）。
  return {
    ...record,
    id: valueText(record.id),
    name: valueText(record.name),
    preview_image: typeof record.preview_image === 'string' ? record.preview_image : null,
    tags: isViewMap(record.tags) ? record.tags : emptyViews(),
    negative_text: valueText(record.negative_text),
  }
}

function isViewMap(value: unknown): value is ViewMap {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function emptyViews(): ViewMap {
  return Object.fromEntries(viewKeys.map((key) => [key, '']))
}

function newCharacter(): CharacterRecord {
  return {
    id: '',
    name: '',
    preview_image: null,
    traits: emptyViews(),
    outfits: [],
    negative_text: '',
  }
}

function searchText(record: CharacterRecord): string {
  const outfitText = record.outfits
    .flatMap((outfit) => [outfit.id, outfit.name, outfit.negative_text, ...Object.values(outfit.tags)])
    .join('\n')
  return [record.id, record.name, record.negative_text, ...Object.values(record.traits), outfitText].join('\n').toLowerCase()
}

function toPayload(character: CharacterRecord, omitEmptyId: boolean): DataRecord {
  const payload: DataRecord = {
    name: character.name,
    preview_image: character.preview_image || null,
    traits: character.traits,
    outfits: character.outfits,
    negative_text: character.negative_text || '',
  }
  if (!omitEmptyId || character.id.trim()) payload.id = character.id
  return payload
}

export default function CharactersView({ manifest, records, loading, onReload, onToast }: Props) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [draft, setDraft] = useState<CharacterRecord | null>(null)
  const [sourceRef, setSourceRef] = useState<{ file: string; id: string } | null>(null)
  const [mode, setMode] = useState<'create' | 'edit'>('edit')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const characters = useMemo(() => records.map(asCharacter), [records])
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? characters.filter((character) => searchText(character).includes(needle)) : characters
  }, [characters, query])

  const startCreate = () => {
    setMode('create')
    setDraft(newCharacter())
    setSourceRef(null)
    setExpanded('__new')
    setError('')
  }

  const startEdit = (character: CharacterRecord) => {
    setMode('edit')
    setDraft(structuredClone(character))
    setSourceRef({ file: valueText(character.__file), id: character.id })
    setExpanded(character.id)
    setError('')
  }

  const updateDraft = (patch: Partial<CharacterRecord>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current))
  }

  const updateTrait = (key: string, value: string) => {
    setDraft((current) => (current ? { ...current, traits: { ...current.traits, [key]: value } } : current))
  }

  const updateOutfit = (index: number, patch: Partial<CharacterRecord['outfits'][number]>) => {
    setDraft((current) => {
      if (!current) return current
      const outfits = current.outfits.map((outfit, outfitIndex) => (outfitIndex === index ? { ...outfit, ...patch } : outfit))
      return { ...current, outfits }
    })
  }

  const updateOutfitTag = (index: number, key: string, value: string) => {
    setDraft((current) => {
      if (!current) return current
      const outfits = current.outfits.map((outfit, outfitIndex) =>
        outfitIndex === index ? { ...outfit, tags: { ...outfit.tags, [key]: value } } : outfit,
      )
      return { ...current, outfits }
    })
  }

  const addOutfit = () => {
    setDraft((current) =>
      current
        ? {
            ...current,
            outfits: [...current.outfits, { id: '', name: '', preview_image: null, tags: emptyViews(), negative_text: '' }],
          }
        : current,
    )
  }

  const cancelEdit = () => {
    setDraft(null)
    setSourceRef(null)
  }

  const removeOutfit = (index: number) => {
    setDraft((current) => (current ? { ...current, outfits: current.outfits.filter((_, outfitIndex) => outfitIndex !== index) } : current))
  }

  const save = async () => {
    if (!draft) return
    if (!draft.name.trim()) {
      setError('请填写角色名称')
      return
    }
    setSaving(true)
    setError('')
    try {
      if (mode === 'create') {
        const record = await createRecord(manifest.key, toPayload(draft, true))
        onToast({ tone: 'success', message: '角色新增成功' })
        setExpanded(valueText(record.id))
      } else if (sourceRef) {
        await updateRecord(manifest.key, sourceRef.file, sourceRef.id, toPayload(draft, false))
        onToast({ tone: 'success', message: '角色保存成功' })
      }
      setDraft(null)
      setSourceRef(null)
      await onReload()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '保存失败'
      setError(message)
      onToast({ tone: 'danger', message })
    } finally {
      setSaving(false)
    }
  }

  const remove = async (character: CharacterRecord) => {
    if (!window.confirm(`确认删除角色 ${character.name || character.id}？`)) return
    setSaving(true)
    setError('')
    try {
      await deleteRecord(manifest.key, valueText(character.__file), character.id)
      if (expanded === character.id) setExpanded(null)
      onToast({ tone: 'success', message: '角色已删除' })
      await onReload()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '删除失败'
      setError(message)
      onToast({ tone: 'danger', message })
    } finally {
      setSaving(false)
    }
  }

  const activeDraft = draft

  return (
    <section className="characters-page">
      <div className="toolbar">
        <input
          className="search-input"
          placeholder="搜索角色名、ID、traits、服装 tags..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button className="btn success" type="button" onClick={startCreate}>
          新增角色
        </button>
      </div>
      <div className="meta-line">
        {loading ? '加载中...' : `${filtered.length} / ${records.length} 个角色`}
        {error ? <span className="inline-error">{error}</span> : null}
      </div>

      {activeDraft && expanded === '__new' ? (
        <CharacterEditor
          title="新增角色"
          draft={activeDraft}
          saving={saving}
          onChange={updateDraft}
          onTrait={updateTrait}
          onOutfit={updateOutfit}
          onOutfitTag={updateOutfitTag}
          onAddOutfit={addOutfit}
          onRemoveOutfit={removeOutfit}
          onSave={() => void save()}
          onCancel={cancelEdit}
        />
      ) : null}

      <div className="character-list">
        {filtered.map((character) => {
          const isOpen = expanded === character.id
          const editingThis = activeDraft && mode === 'edit' && activeDraft.id === character.id
          return (
            <article className="character-card" key={`${character.__file}:${character.id}`}>
              <header className="character-head">
                <button className="plain-toggle" type="button" onClick={() => setExpanded(isOpen ? null : character.id)}>
                  <strong>{character.name || character.id}</strong>
                  <span>{character.id}</span>
                </button>
                <div className="row-actions">
                  <button className="btn small accent" type="button" onClick={() => startEdit(character)}>
                    编辑
                  </button>
                  <button className="btn small danger" type="button" onClick={() => void remove(character)}>
                    删除
                  </button>
                </div>
              </header>
              {isOpen ? (
                editingThis && activeDraft ? (
                  <CharacterEditor
                    title="编辑角色"
                    draft={activeDraft}
                    saving={saving}
                    onChange={updateDraft}
                    onTrait={updateTrait}
                    onOutfit={updateOutfit}
                    onOutfitTag={updateOutfitTag}
                    onAddOutfit={addOutfit}
                    onRemoveOutfit={removeOutfit}
                    onSave={() => void save()}
                    onCancel={cancelEdit}
                  />
                ) : (
                  <CharacterSummary character={character} />
                )
              ) : null}
            </article>
          )
        })}
      </div>
    </section>
  )
}

type EditorProps = {
  title: string
  draft: CharacterRecord
  saving: boolean
  onChange: (patch: Partial<CharacterRecord>) => void
  onTrait: (key: string, value: string) => void
  onOutfit: (index: number, patch: Partial<CharacterRecord['outfits'][number]>) => void
  onOutfitTag: (index: number, key: string, value: string) => void
  onAddOutfit: () => void
  onRemoveOutfit: (index: number) => void
  onSave: () => void
  onCancel: () => void
}

function CharacterEditor({
  title,
  draft,
  saving,
  onChange,
  onTrait,
  onOutfit,
  onOutfitTag,
  onAddOutfit,
  onRemoveOutfit,
  onSave,
  onCancel,
}: EditorProps) {
  return (
    <div className="character-editor">
      <div className="editor-head">
        <div>
          <strong>{title}</strong>
          <span>traits / outfits 会以完整嵌套对象保存</span>
        </div>
        <button className="btn small" type="button" onClick={onCancel}>
          关闭
        </button>
      </div>
      <div className="compact-fields">
        <label className="field">
          <span>ID</span>
          <input value={draft.id} onChange={(event) => onChange({ id: event.target.value })} />
        </label>
        <label className="field">
          <span>角色名</span>
          <input value={draft.name} onChange={(event) => onChange({ name: event.target.value })} />
        </label>
        <label className="field">
          <span>预览图</span>
          <input value={draft.preview_image ?? ''} onChange={(event) => onChange({ preview_image: event.target.value || null })} />
        </label>
      </div>
      <label className="field">
        <span>负面词</span>
        <textarea value={draft.negative_text ?? ''} onChange={(event) => onChange({ negative_text: event.target.value })} />
      </label>
      <h3>Traits</h3>
      <ViewTextareas values={draft.traits} onChange={onTrait} />
      <div className="subhead">
        <h3>Outfits</h3>
        <button className="btn small success" type="button" onClick={onAddOutfit}>
          新增服装
        </button>
      </div>
      {draft.outfits.map((outfit, index) => (
        <section className="outfit-editor" key={`${outfit.id}:${index}`}>
          <div className="compact-fields">
            <label className="field">
              <span>服装 ID</span>
              <input value={outfit.id} onChange={(event) => onOutfit(index, { id: event.target.value })} />
            </label>
            <label className="field">
              <span>服装名</span>
              <input value={outfit.name} onChange={(event) => onOutfit(index, { name: event.target.value })} />
            </label>
            <label className="field">
              <span>预览图</span>
              <input value={outfit.preview_image ?? ''} onChange={(event) => onOutfit(index, { preview_image: event.target.value || null })} />
            </label>
          </div>
          <ViewTextareas values={outfit.tags} onChange={(key, value) => onOutfitTag(index, key, value)} />
          <label className="field">
            <span>服装负面词</span>
            <textarea value={outfit.negative_text ?? ''} onChange={(event) => onOutfit(index, { negative_text: event.target.value })} />
          </label>
          <button className="btn small danger" type="button" onClick={() => onRemoveOutfit(index)}>
            删除服装
          </button>
        </section>
      ))}
      <div className="editor-actions">
        <button className="btn success" type="button" onClick={onSave} disabled={saving}>
          {saving ? '保存中...' : '保存角色'}
        </button>
      </div>
    </div>
  )
}

function ViewTextareas({ values, onChange }: { values: ViewMap; onChange: (key: string, value: string) => void }) {
  return (
    <div className="view-grid">
      {viewKeys.map((key) => (
        <label className="field" key={key}>
          <span>{viewLabels[key]}</span>
          <textarea value={values[key] ?? ''} onChange={(event) => onChange(key, event.target.value)} />
        </label>
      ))}
    </div>
  )
}

function CharacterSummary({ character }: { character: CharacterRecord }) {
  return (
    <div className="character-summary">
      <div className="view-grid">
        {viewKeys.map((key) => (
          <div className="summary-cell" key={key}>
            <span>{viewLabels[key]}</span>
            <p>{character.traits[key] || ' '}</p>
          </div>
        ))}
      </div>
      {character.outfits.length ? (
        <div className="outfit-list">
          {character.outfits.map((outfit, index) => (
            <div className="summary-cell" key={`${outfit.id}:${index}`}>
              <span>{outfit.name || outfit.id || `服装 ${index + 1}`}</span>
              <p>{Object.values(outfit.tags).filter(Boolean).slice(0, 3).join(' / ')}</p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
