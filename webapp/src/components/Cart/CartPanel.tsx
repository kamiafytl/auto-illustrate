import { useState } from 'react'
import type { Cart, CartItem, BlockRelation, BlockRelationType } from '../../types'
import { BLOCK_LABELS, BLOCK_ORDER, type PromptBlock } from '../../types'
import { copyText } from '../../utils/clipboard'

interface CartPanelProps {
  open: boolean
  onClose: () => void
  cart: Cart
  carts: Cart[]
  removeItem: (block: string, sourceId: string) => void
  clearCart: () => void
  renameCart: (name: string) => void
  exportText: () => string
  createNewCart: () => void
  switchCart: (id: string) => void
  deleteCart: (id: string) => void
  itemCount: number
  setBlockRelation: (block: string, relation: BlockRelation) => void
}

const RELATION_LABELS: Record<BlockRelationType, string> = {
  and: 'AND',
  or: 'OR',
  blend: 'Blend',
  schedule: 'Schedule',
}

function generateAutoName(cart: Cart): string {
  const names: string[] = []
  for (const b of BLOCK_ORDER) {
    const items = cart.blocks[b as string]
    if (!items) continue
    for (const item of items) {
      names.push(item.name_zh)
      if (names.length >= 3) return names.join('+')
    }
  }
  for (const [b, items] of Object.entries(cart.blocks)) {
    if (BLOCK_ORDER.includes(b as PromptBlock)) continue
    for (const item of items) {
      names.push(item.name_zh)
      if (names.length >= 3) return names.join('+')
    }
  }
  return names.length > 0 ? names.join('+') : '新小车'
}

export default function CartPanel({
  open, onClose, cart, carts,
  removeItem, clearCart, renameCart, exportText,
  createNewCart, switchCart, deleteCart, itemCount,
  setBlockRelation
}: CartPanelProps) {
  const [copied, setCopied] = useState(false)
  const [showSaved, setShowSaved] = useState(false)
  const [editingRelation, setEditingRelation] = useState<string | null>(null)
  const [editWeight, setEditWeight] = useState(0.5)

  if (!open) return null

  // 3.1: 复制后留在当前车，只命名+反馈，不新建
  const handleCopyAll = async () => {
    const text = exportText()
    if (!text) return
    const ok = await copyText(text)
    if (!ok) return
    renameCart(generateAutoName(cart))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Block排序
  const orderedBlocks: string[] = []
  const seen = new Set<string>()
  for (const b of BLOCK_ORDER) {
    if (cart.blocks[b] && cart.blocks[b].length > 0) {
      orderedBlocks.push(b)
      seen.add(b)
    }
  }
  for (const b of Object.keys(cart.blocks)) {
    if (!seen.has(b) && cart.blocks[b].length > 0) orderedBlocks.push(b)
  }

  return (
    <>
      <div className="cart-backdrop" onClick={onClose} />
      <div className="cart-panel">
        <div className="cart-header">
          <span className="cart-header-icon">Cart</span>
          <input
            className="cart-name-input"
            value={cart.name}
            onChange={e => renameCart(e.target.value)}
            placeholder="小车名称"
          />
          <button className="cart-close" onClick={onClose}>&times;</button>
        </div>

        <div className="cart-body">
          {orderedBlocks.length === 0 && (
            <p className="cart-empty">小车是空的。从配方库或Tag词典添加内容。</p>
          )}
          {orderedBlocks.map(block => {
            const items = cart.blocks[block]
            const recipes = items.filter((i: CartItem) => i.type === 'recipe')
            const components = items.filter((i: CartItem) => i.type === 'component')
            const tags = items.filter((i: CartItem) => i.type === 'tag')
            const relation = cart.blockRelations?.[block]

            const badgeFor = (type: CartItem['type']) =>
              type === 'recipe' ? '方' : type === 'component' ? '件' : 'T'

            const renderItem = (item: CartItem) => (
              <div key={item.sourceId} className={`cart-item cart-item-${item.type}`}>
                <span className={`cart-item-badge cart-badge-${item.type}`}>{badgeFor(item.type)}</span>
                <span className="cart-item-name" title={item.tag}>{item.name_zh}</span>
                <button
                  className="cart-item-remove"
                  onClick={() => removeItem(block, item.sourceId)}
                >&times;</button>
              </div>
            )

            return (
              <div key={block} className="cart-block">
                <div className="cart-block-header">
                  {BLOCK_LABELS[block as PromptBlock] || block}
                  <span className="cart-block-count">({items.length})</span>
                </div>
                {/* 配方列表，有关系标签时在配方之间显示 */}
                {recipes.map((item, idx) => (
                  <div key={item.sourceId}>
                    {renderItem(item)}
                    {relation && idx < recipes.length - 1 && (
                      <div
                        className={`cart-relation-label cart-relation-${relation.type}`}
                        onClick={() => {
                          if (relation.type === 'blend' || relation.type === 'schedule') {
                            setEditingRelation(block)
                            setEditWeight(relation.weights[1] ?? 0.5)
                          }
                        }}
                        title="点击修改关系"
                      >
                        {RELATION_LABELS[relation.type]}
                        {(relation.type === 'blend' || relation.type === 'schedule') &&
                          ` ${relation.weights.map(w => w.toFixed(2)).join('/')}`
                        }
                      </div>
                    )}
                  </div>
                ))}
                {/* 部件 */}
                {components.map(renderItem)}
                {/* Tags */}
                {tags.map(renderItem)}

                {/* 内联权重编辑器 */}
                {editingRelation === block && relation && (
                  <div className="cart-relation-editor">
                    <div className="cart-relation-editor-names">
                      <span>{recipes[0]?.name_zh}</span>
                      <span>{recipes[1]?.name_zh}</span>
                    </div>
                    <input
                      type="range"
                      min={0} max={1} step={0.05}
                      value={editWeight}
                      onChange={e => setEditWeight(+e.target.value)}
                    />
                    <div className="cart-relation-editor-values">
                      <span>{(1 - editWeight).toFixed(2)}</span>
                      <span>{editWeight.toFixed(2)}</span>
                    </div>
                    <div className="cart-relation-editor-actions">
                      <button onClick={() => setEditingRelation(null)}>取消</button>
                      <button onClick={() => {
                        setBlockRelation(block, {
                          ...relation,
                          weights: recipes.map((_, i) =>
                            i === 0 ? +(1 - editWeight).toFixed(2) : +editWeight.toFixed(2)
                          )
                        })
                        setEditingRelation(null)
                      }}>确认</button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="cart-footer">
          <div className="cart-main-actions">
            <button
              className={`cart-copy-all ${copied ? 'copied' : ''}`}
              onClick={handleCopyAll}
              disabled={itemCount === 0}
            >
              {copied ? '已复制并保存!' : `复制全部 (${itemCount})`}
            </button>
            <button
              className="cart-clear"
              onClick={() => { if (confirm('清空当前小车？')) clearCart() }}
              disabled={itemCount === 0}
            >
              清空
            </button>
          </div>

          {/* 3.4: 新建小车 — 显眼的大按钮 */}
          <button className="cart-new-prominent" onClick={createNewCart}>
            + 新建小车
          </button>

          <button className="cart-manage-toggle" onClick={() => setShowSaved(!showSaved)}>
            {showSaved ? '收起' : '管理小车'} ({carts.length})
          </button>

          {showSaved && (
            <div className="cart-manage-list">
              {carts.map(c => (
                <div key={c.id} className={`cart-manage-item ${c.id === cart.id ? 'active' : ''}`}>
                  {/* 3.3: 点名字直接切换 */}
                  <span
                    className={`cart-manage-name ${c.id !== cart.id ? 'switchable' : ''}`}
                    onClick={() => { if (c.id !== cart.id) switchCart(c.id) }}
                  >
                    {c.name}
                    {c.id === cart.id && <span className="cart-current-badge">当前</span>}
                  </span>
                  <div className="cart-manage-btns">
                    {carts.length > 1 && (
                      <button onClick={() => { if (confirm(`删除「${c.name}」？`)) deleteCart(c.id) }}>删</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
