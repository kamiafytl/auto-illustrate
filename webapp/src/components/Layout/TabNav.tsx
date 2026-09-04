import type { TabId } from '../../types'

const TABS: { id: TabId; label: string }[] = [
  { id: 'recipes', label: '配方库' },
  { id: 'tags', label: 'Tag词典' },
  { id: 'inspirations', label: '灵感库' },
]

interface TabNavProps {
  activeTab: TabId
  onTabChange: (tab: TabId) => void
}

export default function TabNav({ activeTab, onTabChange }: TabNavProps) {
  return (
    <nav className="tab-nav">
      {TABS.map(tab => (
        <button
          key={tab.id}
          className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
          onClick={() => onTabChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  )
}
