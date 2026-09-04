import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchManifest, fetchTable } from './api'
import type { DataRecord, TableKey, TableManifest, ToastState } from './types'
import { fallbackLabels, tableOrder } from './types'
import CharactersView from './views/CharactersView'
import TableView from './views/TableView'

export default function App() {
  const [manifest, setManifest] = useState<TableManifest[]>([])
  const [activeKey, setActiveKey] = useState<TableKey>('recipes')
  const [records, setRecords] = useState<DataRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [error, setError] = useState('')

  const activeManifest = useMemo(
    () => manifest.find((item) => item.key === activeKey) ?? manifest[0],
    [activeKey, manifest],
  )

  const showToast = useCallback((nextToast: ToastState) => {
    setToast(nextToast)
    window.setTimeout(() => setToast(null), 2600)
  }, [])

  const loadTable = useCallback(async (tableKey: TableKey) => {
    setLoading(true)
    setError('')
    try {
      const nextRecords = await fetchTable(tableKey)
      setRecords(nextRecords)
    } catch (caught) {
      setRecords([])
      setError(caught instanceof Error ? caught.message : '加载表数据失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let alive = true
    async function loadManifest() {
      setLoading(true)
      try {
        const items = await fetchManifest()
        if (!alive) return
        const sorted = [...items].sort((a, b) => tableOrder.indexOf(a.key) - tableOrder.indexOf(b.key))
        setManifest(sorted)
        const firstKey = sorted[0]?.key ?? 'recipes'
        setActiveKey(firstKey)
        await loadTable(firstKey)
      } catch (caught) {
        if (!alive) return
        setError(caught instanceof Error ? caught.message : '加载表清单失败')
        setLoading(false)
      }
    }
    void loadManifest()
    return () => {
      alive = false
    }
  }, [loadTable])

  const switchTable = (tableKey: TableKey) => {
    setActiveKey(tableKey)
    void loadTable(tableKey)
  }

  const reloadActive = useCallback(async () => {
    await loadTable(activeKey)
  }, [activeKey, loadTable])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>data-studio</h1>
          <p>数据库浏览 / 编辑</p>
        </div>
        <nav className="tabs" aria-label="数据表">
          {manifest.length
            ? manifest.map((item) => (
                <button
                  className={item.key === activeKey ? 'tab active' : 'tab'}
                  key={item.key}
                  type="button"
                  onClick={() => switchTable(item.key)}
                >
                  {item.label}
                </button>
              ))
            : tableOrder.map((key) => (
                <button className={key === activeKey ? 'tab active' : 'tab'} key={key} type="button" disabled>
                  {fallbackLabels[key]}
                </button>
              ))}
        </nav>
      </header>

      {error ? <div className="page-error">{error}</div> : null}

      {activeManifest ? (
        activeManifest.key === 'characters' ? (
          <CharactersView
            manifest={activeManifest}
            records={records}
            loading={loading}
            onReload={reloadActive}
            onToast={showToast}
          />
        ) : (
          <TableView
            manifest={activeManifest}
            records={records}
            loading={loading}
            onReload={reloadActive}
            onToast={showToast}
          />
        )
      ) : null}

      {toast ? <div className={`toast ${toast.tone}`}>{toast.message}</div> : null}
    </div>
  )
}
