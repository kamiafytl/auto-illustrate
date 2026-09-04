import { useMemo, useState } from 'react'
import { createRecord, deleteRecord, imageUrl, updateRecord } from '../api'
import type { DataRecord, TableManifest, ToastState } from '../types'
import { recipeBlocks, tagBlocks } from '../types'

type FieldSpec = {
  key: string
  label: string
  kind: 'text' | 'textarea' | 'select'
  options?: string[]
  required?: boolean
}

type Props = {
  manifest: TableManifest
  records: DataRecord[]
  loading: boolean
  onReload: () => Promise<void>
  onToast: (toast: ToastState) => void
}

type DraftState = {
  mode: 'create' | 'edit'
  source?: DataRecord
  values: Record<string, string>
}

const fieldSpecs: Record<string, FieldSpec[]> = {
  recipes: [
    { key: 'id', label: 'ID', kind: 'text' },
    { key: 'name', label: '中文/名称', kind: 'text', required: true },
    { key: 'block', label: 'Block', kind: 'select', options: recipeBlocks, required: true },
    { key: 'category', label: '中类', kind: 'text' },
    { key: 'group', label: '小类', kind: 'text' },
    { key: 'tags', label: '英文 Tags', kind: 'textarea' },
    { key: 'note', label: '备注', kind: 'textarea' },
    { key: 'image', label: '图片路径', kind: 'text' },
    { key: 'source', label: '来源', kind: 'text' },
  ],
  tags: [
    { key: 'tag', label: '英文 Tag', kind: 'textarea', required: true },
    { key: 'name_zh', label: '中文名', kind: 'text' },
    { key: 'block', label: 'Block', kind: 'select', options: tagBlocks, required: true },
    { key: 'category', label: '中类', kind: 'text' },
    { key: 'note', label: '备注', kind: 'textarea' },
    { key: 'image', label: '图片路径', kind: 'text' },
  ],
  inspirations: [
    { key: 'id', label: 'ID', kind: 'text' },
    { key: 'text', label: '内容', kind: 'textarea', required: true },
    { key: 'type', label: '类型', kind: 'text' },
    { key: 'image', label: '图片路径', kind: 'text' },
    { key: 'note', label: '备注', kind: 'textarea' },
    { key: 'created', label: '创建时间', kind: 'text' },
  ],
  research: [
    { key: 'id', label: 'ID', kind: 'text' },
    { key: 'text', label: '课题', kind: 'textarea', required: true },
    { key: 'category', label: '中类', kind: 'text' },
    { key: 'status', label: '状态', kind: 'text' },
    { key: 'created', label: '创建时间', kind: 'text' },
  ],
}

function valueText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  return String(value)
}

function emptyDraft(specs: FieldSpec[], manifest: TableManifest, blockFilter: string): Record<string, string> {
  const draft = Object.fromEntries(specs.map((spec) => [spec.key, '']))
  if (manifest.blockField && blockFilter !== 'all') draft[manifest.blockField] = blockFilter
  return draft
}

function recordDraft(record: DataRecord, specs: FieldSpec[]): Record<string, string> {
  return Object.fromEntries(specs.map((spec) => [spec.key, valueText(record[spec.key])]))
}

function toPayload(values: Record<string, string>, specs: FieldSpec[]): DataRecord {
  return specs.reduce<DataRecord>((payload, spec) => {
    const raw = values[spec.key] ?? ''
    payload[spec.key] = raw.trim() === '' && spec.key === 'image' ? null : raw
    return payload
  }, {})
}

function searchableText(record: DataRecord): string {
  return ['id', 'tag', 'name', 'name_zh', 'category', 'group', 'text', 'type', 'status', 'block', 'note', 'tags']
    .map((key) => valueText(record[key]))
    .join('\n')
    .toLowerCase()
}

function groupByCategory(records: DataRecord[]): Array<[string, DataRecord[]]> {
  const groups = new Map<string, DataRecord[]>()
  for (const record of records) {
    const category = valueText(record.category) || '未分类'
    groups.set(category, [...(groups.get(category) ?? []), record])
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh-Hans-CN'))
}

function primaryText(record: DataRecord, tableKey: string): string {
  if (tableKey === 'tags') return valueText(record.tag)
  if (tableKey === 'recipes') return valueText(record.tags) || valueText(record.id)
  return valueText(record.text) || valueText(record.id)
}

function secondaryText(record: DataRecord, tableKey: string): string {
  if (tableKey === 'tags') return valueText(record.name_zh)
  if (tableKey === 'recipes') return valueText(record.name)
  return [valueText(record.type), valueText(record.status)].filter(Boolean).join(' / ')
}

export default function TableView({ manifest, records, loading, onReload, onToast }: Props) {
  const specs = fieldSpecs[manifest.key] ?? []
  const [query, setQuery] = useState('')
  const [blockFilter, setBlockFilter] = useState('all')
  const [draft, setDraft] = useState<DraftState | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const blocks = useMemo(() => {
    if (!manifest.blockField) return []
    return [...new Set(records.map((record) => valueText(record[manifest.blockField || ''])).filter(Boolean))].sort()
  }, [manifest.blockField, records])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return records.filter((record) => {
      const blockOk = !manifest.blockField || blockFilter === 'all' || valueText(record[manifest.blockField]) === blockFilter
      return blockOk && (!needle || searchableText(record).includes(needle))
    })
  }, [blockFilter, manifest.blockField, query, records])

  const grouped = useMemo(() => groupByCategory(filtered), [filtered])

  const beginCreate = () => {
    setError('')
    setDraft({ mode: 'create', values: emptyDraft(specs, manifest, blockFilter) })
  }

  const beginEdit = (record: DataRecord) => {
    setError('')
    setDraft({ mode: 'edit', source: record, values: recordDraft(record, specs) })
  }

  const updateDraft = (key: string, value: string) => {
    setDraft((current) => (current ? { ...current, values: { ...current.values, [key]: value } } : current))
  }

  const saveDraft = async () => {
    if (!draft) return
    const missing = specs.find((spec) => spec.required && draft.values[spec.key].trim() === '')
    if (missing) {
      setError(`请填写${missing.label}`)
      return
    }
    setSaving(true)
    setError('')
    try {
      const payload = toPayload(draft.values, specs)
      if (draft.mode === 'create') {
        if (valueText(payload[manifest.idField]) === '') delete payload[manifest.idField]
        await createRecord(manifest.key, payload)
        onToast({ tone: 'success', message: '新增成功' })
      } else if (draft.source) {
        const file = valueText(draft.source.__file)
        const id = valueText(draft.source[manifest.idField])
        await updateRecord(manifest.key, file, id, payload)
        onToast({ tone: 'success', message: '保存成功' })
      }
      setDraft(null)
      await onReload()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存失败')
      onToast({ tone: 'danger', message: caught instanceof Error ? caught.message : '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  const removeRecord = async (record: DataRecord) => {
    const id = valueText(record[manifest.idField])
    if (!window.confirm(`确认删除 ${id || '这条记录'}？`)) return
    setSaving(true)
    setError('')
    try {
      await deleteRecord(manifest.key, valueText(record.__file), id)
      if (draft?.source === record) setDraft(null)
      onToast({ tone: 'success', message: '删除成功' })
      await onReload()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '删除失败'
      setError(message)
      onToast({ tone: 'danger', message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="workspace">
      <div className="list-pane">
        <div className="toolbar">
          <input
            className="search-input"
            placeholder="搜索中文、英文、分类..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {manifest.blockField ? (
            <select className="filter-select" value={blockFilter} onChange={(event) => setBlockFilter(event.target.value)}>
              <option value="all">全部 block</option>
              {blocks.map((block) => (
                <option value={block} key={block}>
                  {block}
                </option>
              ))}
            </select>
          ) : null}
          <button className="btn success" type="button" onClick={beginCreate} disabled={!manifest.editable}>
            新增
          </button>
        </div>

        <div className="meta-line">
          {loading ? '加载中...' : `${filtered.length} / ${records.length} 条`}
          {error ? <span className="inline-error">{error}</span> : null}
        </div>

        <div className="groups">
          {grouped.map(([category, items]) => (
            <section className="data-group" key={category}>
              <div className="group-title">
                <span>{category}</span>
                <em>{items.length}</em>
              </div>
              <div className="excel-list">
                {items.map((record) => {
                  const id = valueText(record[manifest.idField])
                  const img = imageUrl(record.image)
                  return (
                    <div className="excel-row" key={`${valueText(record.__file)}:${id}`}>
                      <div className="cell english" title={primaryText(record, manifest.key)}>
                        {primaryText(record, manifest.key) || id}
                      </div>
                      <div className="cell chinese" title={secondaryText(record, manifest.key)}>
                        {secondaryText(record, manifest.key) || ' '}
                      </div>
                      <div className="cell muted">{valueText(record.block) || valueText(record.category)}</div>
                      <div className="row-actions">
                        {img ? (
                          <span className="image-hover">
                            图
                            <span className="image-popover">
                              <img src={img} alt="" />
                            </span>
                          </span>
                        ) : null}
                        <button className="btn small accent" type="button" onClick={() => beginEdit(record)}>
                          编辑
                        </button>
                        <button className="btn small danger" type="button" onClick={() => void removeRecord(record)}>
                          删除
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      </div>

      <aside className="editor-pane">
        {draft ? (
          <>
            <div className="editor-head">
              <div>
                <strong>{draft.mode === 'create' ? '新增记录' : '编辑记录'}</strong>
                <span>{manifest.label}</span>
              </div>
              <button className="btn small" type="button" onClick={() => setDraft(null)}>
                关闭
              </button>
            </div>
            <div className="form-grid">
              {specs.map((spec) => (
                <label className="field" key={spec.key}>
                  <span>{spec.label}</span>
                  {spec.kind === 'textarea' ? (
                    <textarea value={draft.values[spec.key] ?? ''} onChange={(event) => updateDraft(spec.key, event.target.value)} />
                  ) : spec.kind === 'select' ? (
                    <select value={draft.values[spec.key] ?? ''} onChange={(event) => updateDraft(spec.key, event.target.value)}>
                      <option value="">未设置</option>
                      {(spec.options ?? []).map((option) => (
                        <option value={option} key={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input value={draft.values[spec.key] ?? ''} onChange={(event) => updateDraft(spec.key, event.target.value)} />
                  )}
                </label>
              ))}
            </div>
            <div className="editor-actions">
              <button className="btn success" type="button" onClick={() => void saveDraft()} disabled={saving}>
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </>
        ) : (
          <div className="empty-editor">选择一行编辑，或新增记录。</div>
        )}
      </aside>
    </section>
  )
}
