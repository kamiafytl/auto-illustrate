// 复制到剪贴板的唯一入口（2026-08-29 修：网页端复制按钮绝大部分失效）。
// 根因：Owner 用 http://<WSL-IP>:3001 打开 webapp，非 localhost 的 http 页面 = 非安全上下文，
// 浏览器直接不给 navigator.clipboard（undefined）→ 各处 `navigator.clipboard?.writeText()`
// 被可选链静默吞掉、`await navigator.clipboard.writeText()` 抛错，点了没反应。
// 对策：能用 async API 就用，用不了就退回 textarea + execCommand('copy')（老接口，http 下照样能用）。
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* 落到下面的兜底 */ }
  return legacyCopy(text)
}

function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    // 不滚动、不闪烁：定位在视口内但不可见（display:none / visibility:hidden 会让 select() 失效）
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '0'
    ta.style.left = '0'
    ta.style.width = '1px'
    ta.style.height = '1px'
    ta.style.padding = '0'
    ta.style.border = 'none'
    ta.style.outline = 'none'
    ta.style.boxShadow = 'none'
    ta.style.background = 'transparent'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    const active = document.activeElement as HTMLElement | null
    ta.select()
    ta.setSelectionRange(0, ta.value.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    active?.focus?.()
    return ok
  } catch {
    return false
  }
}
