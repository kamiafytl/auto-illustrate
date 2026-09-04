import { useState, useEffect } from 'react'
import { BLOCK_ORDER, BLOCK_LABELS, type PromptBlock } from '../../types'
import type { Cart } from '../../types'
import type { useAssembly } from '../../hooks/useAssembly'
import CopyButton from '../common/CopyButton'

interface AssemblyPanelProps {
  assembly: ReturnType<typeof useAssembly>
  cart: Cart
  onAddToNaiQueue?: () => void
}

export default function AssemblyPanel({ assembly, cart, onAddToNaiQueue }: AssemblyPanelProps) {
  const [showPreview, setShowPreview] = useState(false)

  // 组装棚tab激活时开始轮询，离开时停止
  useEffect(() => {
    assembly.startPolling()
    return () => assembly.stopPolling()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleImportFromCart = () => {
    const itemCount = Object.values(cart.blocks).reduce((sum, arr) => sum + arr.length, 0)
    if (itemCount === 0) return
    assembly.importFromCart(cart)
  }

  const handleClear = () => {
    if (confirm('清空组装棚所有区块？')) {
      assembly.clearAll()
    }
  }

  const cartItemCount = Object.values(cart.blocks).reduce((sum, arr) => sum + arr.length, 0)
  const filledBlocks = BLOCK_ORDER.filter(b => assembly.blocks[b]?.text.trim())

  return (
    <div className="assembly-panel">
      {/* 顶栏 */}
      <div className="assembly-toolbar">
        <div className="assembly-toolbar-left">
          <h3 className="assembly-title">组装棚</h3>
          <span className="assembly-stats">
            {filledBlocks.length}/{BLOCK_ORDER.length} 区块
          </span>
        </div>
        <div className="assembly-toolbar-right">
          <button
            className="btn btn-secondary btn-small"
            onClick={handleImportFromCart}
            disabled={cartItemCount === 0}
            title={`从「${cart.name}」导入 (${cartItemCount})`}
          >
            从Cart导入 ({cartItemCount})
          </button>
          <button
            className="btn btn-secondary btn-small"
            onClick={handleClear}
            disabled={filledBlocks.length === 0}
          >
            清空
          </button>
          <SyncIndicator status={assembly.syncStatus} />
        </div>
      </div>

      {/* 区块编辑区 */}
      <div className="assembly-blocks">
        {BLOCK_ORDER.map(block => (
          <AssemblyBlockRow
            key={block}
            block={block}
            data={assembly.blocks[block]}
            onTextChange={(text) => assembly.updateBlock(block, text)}
            onTogglePrivacy={() => assembly.togglePrivacy(block)}
          />
        ))}
      </div>

      {/* 底部：预览+复制 */}
      <div className="assembly-footer">
        <div className="assembly-footer-actions">
          <button
            className={`btn btn-secondary btn-small ${showPreview ? 'active' : ''}`}
            onClick={() => setShowPreview(!showPreview)}
          >
            {showPreview ? '收起预览' : '展开预览'}
          </button>
          <CopyButton text={assembly.exportFullText()} label="复制全部" />
          {onAddToNaiQueue && (
            <button
              className="btn btn-primary btn-small"
              onClick={onAddToNaiQueue}
              disabled={filledBlocks.length === 0}
              title="把当前组装内容快照加入 NAI 批量队列"
            >
              ▶ 加入NAI队列
            </button>
          )}
        </div>
        {showPreview && (
          <pre className="assembly-preview">{assembly.exportFullText() || '（空）'}</pre>
        )}
      </div>
    </div>
  )
}

// === 子组件 ===

function AssemblyBlockRow({
  block,
  data,
  onTextChange,
  onTogglePrivacy,
}: {
  block: PromptBlock
  data: { text: string; isPrivate: boolean } | undefined
  onTextChange: (text: string) => void
  onTogglePrivacy: () => void
}) {
  const text = data?.text ?? ''
  const isPrivate = data?.isPrivate ?? false
  const label = BLOCK_LABELS[block] || block

  return (
    <div className={`assembly-block ${isPrivate ? 'private' : ''}`}>
      <div className="assembly-block-header">
        <span className="assembly-block-label">{label}</span>
        <button
          className={`assembly-privacy-toggle ${isPrivate ? 'locked' : ''}`}
          onClick={onTogglePrivacy}
          title={isPrivate ? '隐私（CC不可见）— 点击切换为公开' : '公开（CC可见）— 点击切换为隐私'}
        >
          {isPrivate ? '隐私' : '公开'}
        </button>
      </div>
      <textarea
        className="assembly-block-textarea"
        value={text}
        onChange={e => onTextChange(e.target.value)}
        rows={2}
        placeholder={`${label}的prompt...`}
      />
    </div>
  )
}

function SyncIndicator({ status }: { status: 'idle' | 'syncing' | 'cc-edited' }) {
  return (
    <span className={`assembly-sync assembly-sync-${status}`}>
      {status === 'idle' && '已同步'}
      {status === 'syncing' && '同步中...'}
      {status === 'cc-edited' && 'CC已编辑'}
    </span>
  )
}
