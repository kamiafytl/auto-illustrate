import { useState, useCallback } from 'react'
import type { LoraEntry, TriggerVariant } from '../../types/production'
import { BLOCK_LABELS, type PromptBlock } from '../../types'
import type { useComfyUI } from '../../hooks/useComfyUI'

interface LoraManagerProps {
  loras: LoraEntry[]
  onLorasChange: (loras: LoraEntry[]) => void
  comfyUI: ReturnType<typeof useComfyUI>
}

function newLoraEntry(): LoraEntry {
  return {
    id: `lora-${Date.now()}`,
    filename: '',
    name: '',
    block: 'character',
    defaultWeight: 1.0,
    triggerVariants: [{ name: '默认', tags: '' }],
    note: '',
  }
}

export default function LoraManager({ loras, onLorasChange, comfyUI }: LoraManagerProps) {
  const [editing, setEditing] = useState<LoraEntry | null>(null)
  const [comfyLoraList, setComfyLoraList] = useState<string[]>([])
  const [loadingList, setLoadingList] = useState(false)

  const fetchLoraList = useCallback(async () => {
    setLoadingList(true)
    const list = await comfyUI.fetchModels('loras')
    setComfyLoraList(list)
    setLoadingList(false)
  }, [comfyUI])

  const saveLora = async (entry: LoraEntry) => {
    try {
      await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'loras', data: entry }),
      })
      const exists = loras.find(l => l.id === entry.id)
      if (exists) {
        onLorasChange(loras.map(l => l.id === entry.id ? entry : l))
      } else {
        onLorasChange([...loras, entry])
      }
      setEditing(null)
    } catch (err) {
      console.error('保存LoRA失败:', err)
    }
  }

  const deleteLora = async (id: string) => {
    if (!confirm('确定删除这个LoRA？')) return
    try {
      await fetch('/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'loras', id }),
      })
      onLorasChange(loras.filter(l => l.id !== id))
    } catch (err) {
      console.error('删除LoRA失败:', err)
    }
  }

  return (
    <div className="lora-manager">
      <div className="lora-toolbar">
        <button className="btn btn-primary" onClick={() => setEditing(newLoraEntry())}>
          + 新增LoRA
        </button>
        <button
          className="btn btn-secondary"
          onClick={fetchLoraList}
          disabled={loadingList || !comfyUI.conn.connected}
          title={comfyUI.conn.connected ? '从ComfyUI获取LoRA文件列表' : 'ComfyUI未连接'}
        >
          {loadingList ? '获取中...' : '从ComfyUI获取列表'}
        </button>
      </div>

      {loras.length === 0 && !editing && (
        <p className="lora-empty">还没有注册的LoRA。点击"新增LoRA"开始添加。</p>
      )}

      {loras.length > 0 && (
        <table className="lora-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>文件名</th>
              <th>区块</th>
              <th>权重</th>
              <th>变体数</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {loras.map(lora => (
              <tr key={lora.id}>
                <td className="lora-name">{lora.name || '(未命名)'}</td>
                <td className="lora-filename" title={lora.filename}>{lora.filename}</td>
                <td>{BLOCK_LABELS[lora.block as PromptBlock] || lora.block}</td>
                <td>{lora.defaultWeight}</td>
                <td>{lora.triggerVariants.length}</td>
                <td className="lora-actions">
                  <button className="btn-small btn-edit" onClick={() => setEditing({ ...lora })}>编辑</button>
                  <button className="btn-small btn-delete" onClick={() => deleteLora(lora.id)}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <LoraEditModal
          entry={editing}
          comfyLoraList={comfyLoraList}
          comfyConnected={comfyUI.conn.connected}
          loadingList={loadingList}
          onFetchList={fetchLoraList}
          onSave={saveLora}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  )
}

// LoRA编辑Modal
function LoraEditModal({ entry, comfyLoraList, comfyConnected, loadingList, onFetchList, onSave, onCancel }: {
  entry: LoraEntry
  comfyLoraList: string[]
  comfyConnected: boolean
  loadingList: boolean
  onFetchList: () => void
  onSave: (entry: LoraEntry) => void
  onCancel: () => void
}) {
  const [form, setForm] = useState<LoraEntry>({ ...entry })

  const updateVariant = (index: number, field: keyof TriggerVariant, value: string) => {
    const variants = [...form.triggerVariants]
    variants[index] = { ...variants[index], [field]: value }
    setForm({ ...form, triggerVariants: variants })
  }

  const addVariant = () => {
    setForm({
      ...form,
      triggerVariants: [...form.triggerVariants, { name: '', tags: '' }],
    })
  }

  const removeVariant = (index: number) => {
    if (form.triggerVariants.length <= 1) return
    setForm({
      ...form,
      triggerVariants: form.triggerVariants.filter((_, i) => i !== index),
    })
  }

  return (
    <div className="modal-overlay">
      <div className="modal-content lora-edit-modal">
        <h3>{entry.id.startsWith('lora-') && !entry.name ? '新增LoRA' : '编辑LoRA'}</h3>

        <div className="form-row">
          <label>显示名</label>
          <input
            type="text"
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            placeholder="如：角色A、画风B"
          />
        </div>

        <div className="form-row">
          <label>文件名</label>
          <div className="filename-picker">
            {comfyLoraList.length > 0 ? (
              <select
                value={form.filename}
                onChange={e => setForm({ ...form, filename: e.target.value })}
              >
                <option value="">-- 选择LoRA文件 --</option>
                {comfyLoraList.map(f => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={form.filename}
                onChange={e => setForm({ ...form, filename: e.target.value })}
                placeholder={comfyConnected ? '点右边按钮获取列表，或手动输入' : 'xxx.safetensors（ComfyUI未连接，手动输入）'}
              />
            )}
            <button
              className="btn-small btn-secondary"
              onClick={onFetchList}
              disabled={loadingList || !comfyConnected}
              title={comfyConnected ? '从ComfyUI获取LoRA文件列表' : 'ComfyUI未连接'}
            >
              {loadingList ? '...' : '获取列表'}
            </button>
          </div>
        </div>

        <div className="form-row">
          <label>影响区块</label>
          <select
            value={form.block}
            onChange={e => setForm({ ...form, block: e.target.value as PromptBlock })}
          >
            {Object.entries(BLOCK_LABELS).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </div>

        <div className="form-row">
          <label>默认权重</label>
          <input
            type="number"
            value={form.defaultWeight}
            onChange={e => {
              const val = parseFloat(e.target.value)
              setForm({ ...form, defaultWeight: isNaN(val) ? 1 : val })
            }}
            step={0.05}
            min={0}
            max={2}
          />
        </div>

        <div className="form-section">
          <label>Trigger Word变体</label>
          {form.triggerVariants.map((v, i) => (
            <div key={i} className="variant-row">
              <input
                type="text"
                className="variant-name"
                value={v.name}
                onChange={e => updateVariant(i, 'name', e.target.value)}
                placeholder="变体名"
              />
              <textarea
                className="variant-tags"
                value={v.tags}
                onChange={e => updateVariant(i, 'tags', e.target.value)}
                placeholder="trigger tags（逗号分隔）"
                rows={2}
              />
              <button
                className="btn-small btn-delete"
                onClick={() => removeVariant(i)}
                disabled={form.triggerVariants.length <= 1}
              >
                x
              </button>
            </div>
          ))}
          <button className="btn btn-secondary btn-add-variant" onClick={addVariant}>
            + 添加变体
          </button>
        </div>

        <div className="form-row">
          <label>备注</label>
          <textarea
            value={form.note}
            onChange={e => setForm({ ...form, note: e.target.value })}
            rows={2}
            placeholder="可选备注"
          />
        </div>

        <div className="modal-actions">
          <button className="btn btn-primary" onClick={() => onSave(form)} disabled={!form.filename}>
            保存
          </button>
          <button className="btn btn-secondary" onClick={onCancel}>取消</button>
        </div>
      </div>
    </div>
  )
}
