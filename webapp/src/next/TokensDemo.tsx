import type { CSSProperties } from 'react'

const semanticTokens = [
  '--knx-bg',
  '--knx-surface',
  '--knx-surface-2',
  '--knx-surface-3',
  '--knx-text',
  '--knx-text-strong',
  '--knx-muted',
  '--knx-line',
  '--knx-line-strong',
  '--knx-accent',
  '--knx-accent-hover',
  '--knx-accent-soft',
  '--knx-accent-text',
  '--knx-nav',
  '--knx-nav-hover',
  '--knx-nav-dim',
  '--knx-nav-text',
  '--knx-info',
  '--knx-info-soft',
  '--knx-danger',
  '--knx-danger-soft',
  '--knx-danger-strong',
  '--knx-ok',
  '--knx-ok-soft',
  '--knx-ok-strong',
  '--knx-amber',
  '--knx-amber-soft',
]

const blockTokens = [
  ['style', '画风质量', '--knx-block-style'],
  ['sub_style', '次画风', '--knx-block-sub-style'],
  ['character', '角色特征', '--knx-block-character'],
  ['clothing', '衣服', '--knx-block-clothing'],
  ['action', '动作', '--knx-block-action'],
  ['expression', '表情', '--knx-block-expression'],
  ['scene', '场景', '--knx-block-scene'],
  ['camera', '镜头机位', '--knx-block-camera'],
  ['effect', '特殊效果', '--knx-block-effect'],
] as const

const tableRows = [
  ['masterpiece', '杰作'],
  ['best quality', '最高质量'],
  ['dynamic pose', '动态姿势'],
  ['soft lighting', '柔和光照'],
  ['close-up shot', '近景镜头'],
  ['wind-swept hair', '风吹发丝'],
  ['cinematic shadow', '电影感阴影'],
  ['glowing particles', '发光粒子'],
]

function TokenSwatch({ name }: { name: string }) {
  const style = {
    '--swatch': `var(${name})`,
  } as CSSProperties

  return (
    <div className="knx-card" style={{ width: 'auto' }}>
      <div className="knx-row">
        <span className="knx-dot" style={{ '--knx-group-color': 'var(--swatch)' } as CSSProperties} />
        <strong>{name}</strong>
      </div>
      <div style={{ ...style, height: 34, borderRadius: 'var(--knx-radius-6)', background: 'var(--swatch)', border: '1px solid var(--knx-line)' }} />
      <code className="knx-muted">var({name})</code>
    </div>
  )
}

function DemoChip({
  english,
  chinese,
  className = '',
  color = '--knx-block-action',
}: {
  english: string
  chinese: string
  className?: string
  color?: string
}) {
  return (
    <span className={`knx-chip ${className}`} style={{ '--knx-chip-color': `var(${color})` } as CSSProperties}>
      <span className="knx-chip-bar" />
      <span className="knx-chip-body">
        <span className="knx-chip-en">{english}</span>
        <span className="knx-chip-zh">{chinese}</span>
      </span>
    </span>
  )
}

export default function TokensDemo() {
  return (
    <section className="knx-page">
      <div>
        <h2>设计规范</h2>
        <p>tokens 示例页。审美基线=旧版 webapp（全部色值/圆角/阴影/过渡从 legacy.css 原值提取，2026-07-08 拍板）；紫=品牌/编辑 accent，蓝=导航 nav，明色单主题。9 区块分类色沿用 studio-next blockColors。</p>
      </div>

      <section className="knx-section">
        <h3 className="knx-section-title">语义色板</h3>
        <div className="knx-grid">
          {semanticTokens.map(name => (
            <TokenSwatch key={name} name={name} />
          ))}
        </div>
      </section>

      <section className="knx-section">
        <h3 className="knx-section-title">9 区块分类色</h3>
        <div className="knx-row">
          {blockTokens.map(([id, label, token]) => (
            <span key={id} className="knx-row">
              <span className="knx-dot" style={{ '--knx-group-color': `var(${token})` } as CSSProperties} />
              <span>{id}</span>
              <span className="knx-muted">{label}</span>
            </span>
          ))}
        </div>
      </section>

      <section className="knx-section">
        <h3 className="knx-section-title">字级 / 间距 / 圆角</h3>
        <div className="knx-grid">
          <div className="knx-card" style={{ width: 'auto' }}>
            <p style={{ fontSize: 'var(--knx-font-12)' }}>12.5px 辅助信息</p>
            <p style={{ fontSize: 'var(--knx-font-13)' }}>13px 中文说明</p>
            <p style={{ fontSize: 'var(--knx-font-14)' }}>14px 胶囊英文</p>
            <p style={{ fontSize: 'var(--knx-font-16)' }}>16px 分组头</p>
            <p style={{ fontSize: 'var(--knx-font-17)' }}>17px 品牌标题</p>
          </div>
          <div className="knx-card" style={{ width: 'auto' }}>
            {[4, 6, 8, 10, 12, 16, 24].map(size => (
              <div key={size} className="knx-row">
                <span className="knx-muted">--knx-space-{size}</span>
                <span style={{ width: `var(--knx-space-${size})`, height: 10, background: 'var(--knx-accent)' }} />
              </div>
            ))}
          </div>
          <div className="knx-card" style={{ width: 'auto' }}>
            {['6', '8', '12', 'pill'].map(radius => (
              <div key={radius} className="knx-row">
                <span className="knx-muted">--knx-radius-{radius}</span>
                <span style={{ width: 46, height: 24, borderRadius: `var(--knx-radius-${radius})`, background: 'var(--knx-surface-3)', border: '1px solid var(--knx-line-strong)' }} />
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="knx-section">
        <h3 className="knx-section-title">按钮全家福</h3>
        <div className="knx-row">
          <button className="knx-btn knx-btn-primary" type="button" title="主操作使用 accent">
            primary
          </button>
          <button className="knx-btn knx-btn-ok" type="button" title="添加/确认使用绿色">
            ok
          </button>
          <button className="knx-btn knx-btn-danger" type="button" title="删除/危险操作使用红色">
            danger
          </button>
          <button className="knx-btn knx-btn-ghost" type="button" title="低优先级操作">
            ghost
          </button>
          <button className="knx-btn" type="button" disabled title="禁用态">
            disabled
          </button>
        </div>
      </section>

      <section className="knx-section">
        <h3 className="knx-section-title">胶囊全状态</h3>
        <div className="knx-row">
          <DemoChip english="masterpiece" chinese="杰作" color="--knx-block-style" />
          <DemoChip english="(best quality:1.1)" chinese="权重加强" className="is-strong" color="--knx-amber" />
          <DemoChip english="(wide shot:0.9)" chinese="权重削弱" className="is-weak" color="--knx-accent" />
          <DemoChip english="bad anatomy" chinese="禁用项" className="is-disabled" color="--knx-block-effect" />
          <DemoChip english="the girl turns toward the light" chinese="自然语言片段" className="is-natural" color="--knx-block-scene" />
          <DemoChip english="flowing dress" chinese="带分类色条" color="--knx-block-clothing" />
        </div>
      </section>

      <section className="knx-section">
        <h3 className="knx-section-title">分组头示范</h3>
        <div className="knx-group" style={{ '--knx-group-color': 'var(--knx-block-character)' } as CSSProperties}>
          <div className="knx-group-head">
            <span className="knx-dot" />
            <span className="knx-group-name">角色特征</span>
          </div>
          <div className="knx-group-body knx-cw-sm">
            <div className="knx-card">占位卡片 A</div>
            <div className="knx-card">占位卡片 B</div>
            <div className="knx-card">占位卡片 C</div>
          </div>
        </div>
        <div className="knx-group" style={{ '--knx-group-color': 'var(--knx-block-scene)' } as CSSProperties}>
          <div className="knx-group-head">
            <span className="knx-dot" />
            <span className="knx-group-name">场景</span>
          </div>
          <div className="knx-group-body knx-cw-md">
            <div className="knx-card">占位卡片 D</div>
            <div className="knx-card">占位卡片 E</div>
          </div>
        </div>
      </section>

      <section className="knx-section">
        <h3 className="knx-section-title">Excel 式双列表格</h3>
        <div className="knx-table">
          <div className="knx-table-row knx-table-head">
            <div className="knx-table-cell">英文列</div>
            <div className="knx-table-cell">中文列</div>
            <div className="knx-table-cell">操作</div>
          </div>
          {tableRows.map(([english, chinese]) => (
            <div className="knx-table-row" key={english}>
              <div className="knx-table-cell">{english}</div>
              <div className="knx-table-cell">{chinese}</div>
              <div className="knx-table-cell">
                <button className="knx-btn knx-btn-ghost" type="button">
                  编辑
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="knx-section">
        <h3 className="knx-section-title">输入控件</h3>
        <div className="knx-grid">
          <div className="knx-field">
            <label htmlFor="knx-demo-input">输入框</label>
            <input id="knx-demo-input" className="knx-input" defaultValue="best quality" />
          </div>
          <div className="knx-field">
            <label htmlFor="knx-demo-select">选择框</label>
            <select id="knx-demo-select" className="knx-select" defaultValue="scene">
              <option value="style">画风质量</option>
              <option value="scene">场景</option>
              <option value="effect">特殊效果</option>
            </select>
          </div>
          <div className="knx-field">
            <label htmlFor="knx-demo-textarea">Textarea</label>
            <textarea id="knx-demo-textarea" className="knx-textarea" defaultValue="soft lighting, cinematic shadow" />
          </div>
        </div>
      </section>
    </section>
  )
}
