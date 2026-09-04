import { useState } from 'react'
import { copyText } from '../../utils/clipboard'

interface CopyButtonProps {
  text: string
  label?: string
  title?: string
}

export default function CopyButton({ text, label = '复制', title }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const isEmpty = !text || !text.trim()

  // 走统一入口 copyText：http://<WSL-IP> 这类非安全上下文下 navigator.clipboard 不存在，
  // 自动退回 execCommand；真失败时给红字反馈，不再"点了没反应"。
  const handleCopy = async () => {
    if (isEmpty) return
    const ok = await copyText(text)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } else {
      setFailed(true)
      setTimeout(() => setFailed(false), 2000)
    }
  }

  return (
    <button
      className={`copy-btn ${copied ? 'copied' : ''}`}
      onClick={handleCopy}
      disabled={isEmpty}
      title={failed ? '复制失败，请手动选中文本复制' : title}
    >
      {failed ? '复制失败' : copied ? '已复制' : label}
    </button>
  )
}
