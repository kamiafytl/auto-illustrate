import { useState } from 'react'
import type { BlockRelationType, BlockRelation } from '../../types'
import { BLOCK_LABELS, type PromptBlock } from '../../types'

interface ConflictModalProps {
  block: string
  existingName: string   // 已在车里的配方名
  incomingName: string   // 要加入的配方名
  onReplace: () => void
  onAdd: (relation: BlockRelation) => void
  onCancel: () => void
}

type ModalStep = 'choose' | 'weight'

const RELATION_OPTIONS: { type: BlockRelationType; label: string; desc: string }[] = [
  { type: 'and', label: '合并', desc: '两个配方同时生效（逗号连接）' },
  { type: 'or', label: '随机', desc: '随机选择其中一个（{A|B}语法）' },
  { type: 'blend', label: '混合', desc: '按权重混合两个配方' },
  { type: 'schedule', label: '分阶段', desc: '前半步数用A，后半步数用B' },
]

export default function ConflictModal({
  block, existingName, incomingName,
  onReplace, onAdd, onCancel
}: ConflictModalProps) {
  const [step, setStep] = useState<ModalStep>('choose')
  const [selectedType, setSelectedType] = useState<BlockRelationType>('blend')
  const [weight, setWeight] = useState(0.5)

  const blockLabel = BLOCK_LABELS[block as PromptBlock] || block

  const handleChoose = (type: BlockRelationType) => {
    if (type === 'and' || type === 'or') {
      // AND和OR不需要权重设置，直接确认
      onAdd({ type, weights: [0.5, 0.5] })
    } else {
      // blend/schedule需要权重设置
      setSelectedType(type)
      setWeight(0.5)
      setStep('weight')
    }
  }

  const handleWeightConfirm = () => {
    const w1 = +(1 - weight).toFixed(2)
    const w2 = +weight.toFixed(2)
    onAdd({ type: selectedType, weights: [w1, w2] })
  }

  return (
    <>
      <div className="conflict-backdrop" onClick={onCancel} />
      <div className="conflict-modal">
        <div className="conflict-header">
          <span className="conflict-block-label">{blockLabel}</span>
          已有配方
        </div>

        <div className="conflict-context">
          <div className="conflict-existing">
            <span className="conflict-label">已有</span>
            <span className="conflict-name">{existingName}</span>
          </div>
          <div className="conflict-arrow">+</div>
          <div className="conflict-incoming">
            <span className="conflict-label">新增</span>
            <span className="conflict-name">{incomingName}</span>
          </div>
        </div>

        {step === 'choose' && (
          <>
            <button className="conflict-replace-btn" onClick={onReplace}>
              替换（移除旧配方）
            </button>
            <div className="conflict-divider">或保留两个配方：</div>
            <div className="conflict-options">
              {RELATION_OPTIONS.map(opt => (
                <button
                  key={opt.type}
                  className={`conflict-option conflict-option-${opt.type}`}
                  onClick={() => handleChoose(opt.type)}
                >
                  <span className="conflict-option-label">{opt.label}</span>
                  <span className="conflict-option-desc">{opt.desc}</span>
                </button>
              ))}
            </div>
            <button className="conflict-cancel" onClick={onCancel}>取消</button>
          </>
        )}

        {step === 'weight' && (
          <div className="conflict-weight-step">
            <div className="conflict-weight-title">
              {selectedType === 'blend' ? '混合权重' : '切换时机'}
            </div>
            <div className="conflict-weight-names">
              <span>{existingName}</span>
              <span>{incomingName}</span>
            </div>
            <input
              type="range"
              className="conflict-weight-slider"
              min={0}
              max={1}
              step={0.05}
              value={weight}
              onChange={e => setWeight(+e.target.value)}
            />
            <div className="conflict-weight-values">
              <span>{(1 - weight).toFixed(2)}</span>
              <span>{weight.toFixed(2)}</span>
            </div>
            {selectedType === 'schedule' && (
              <div className="conflict-weight-hint">
                前{((1 - weight) * 100).toFixed(0)}%步数用「{existingName}」，后{(weight * 100).toFixed(0)}%步数用「{incomingName}」
              </div>
            )}
            <div className="conflict-weight-actions">
              <button className="conflict-weight-back" onClick={() => setStep('choose')}>返回</button>
              <button className="conflict-weight-confirm" onClick={handleWeightConfirm}>确认</button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
