import { useState, useCallback } from 'react'

const STORAGE_PREFIX = 'owner-img:'

/** 预览图显示偏好hook — localStorage持久化 */
export function useDisplayPrefs(tabId: string, defaultGlobal: boolean) {
  const globalKey = STORAGE_PREFIX + tabId + ':global'

  const [globalShow, setGlobalShow] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(globalKey)
      if (v !== null) return v === '1'
    } catch { /* ignore */ }
    return defaultGlobal
  })

  const toggleGlobal = useCallback(() => {
    setGlobalShow(prev => {
      const next = !prev
      try { localStorage.setItem(globalKey, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }, [globalKey])

  const getItemPref = useCallback((itemId: string): boolean | null => {
    try {
      const v = localStorage.getItem(STORAGE_PREFIX + tabId + ':' + itemId)
      if (v !== null) return v === '1'
    } catch { /* ignore */ }
    return null
  }, [tabId])

  const setItemPref = useCallback((itemId: string, show: boolean) => {
    try {
      localStorage.setItem(STORAGE_PREFIX + tabId + ':' + itemId, show ? '1' : '0')
    } catch { /* ignore */ }
  }, [tabId])

  const shouldShowImage = useCallback((itemId: string, hasImage: boolean): boolean => {
    if (!hasImage) return false
    const itemPref = getItemPref(itemId)
    if (itemPref !== null) return itemPref
    return globalShow
  }, [globalShow, getItemPref])

  return { globalShow, toggleGlobal, shouldShowImage, setItemPref }
}
