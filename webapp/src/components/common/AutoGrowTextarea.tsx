import { useRef, useEffect, useCallback } from 'react'

/**
 * 自动伸高的文本框：内容超出就长高、变少就缩短，无内部滚动条。
 * 与 NAI 出图面板、角色管理器共用，保证全站编辑框手感一致。
 */
export default function AutoGrowTextarea({
  value, onChange, disabled, placeholder, className, minRows = 2,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  placeholder?: string
  className?: string
  minRows?: number
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const resize = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [])
  // 内容变化（含外部赋值）时重算高度
  useEffect(() => { resize() }, [value, resize])
  return (
    <textarea
      ref={ref}
      className={className}
      value={value}
      onChange={e => onChange(e.target.value)}
      onInput={resize}
      disabled={disabled}
      rows={minRows}
      placeholder={placeholder}
    />
  )
}
