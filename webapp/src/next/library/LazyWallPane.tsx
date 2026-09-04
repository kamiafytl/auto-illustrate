// 懒狗库大类（E2 蓝图 §二）：主区形态=图墙（LazyBrowser 已验收交互语言：小图墙+悬浮跟随大图），
// 壳色跟配方库语言。中类=套图·复刻(sets.json)/套图·标准/套图·原创(compositions.json)/单图(shots.json)。
// E2 范围=可浏览+可选入编辑器（复制/选入）；增删拖拽等管理手势留旧「散图库」tab 到 E5。
import { useMemo, useState } from 'react'
import type { LazyShot, ResolvedComp } from '../../types/lazydog'
import type { LazyLibraryState } from './useLazyLibrary'
import { ZoomLayer, matchText, slugId } from './parts'
import { applyLazyShot, type DocMutator } from './selectToEditor'
import { copyText } from '../../utils/clipboard'

type Zoom = { src: string; x: number; y: number }

/** 帧/单图的「复制」文本：跑图忠实源 payload_src 优先，缺则拼可读原值 */
function shotCopyText(shot: LazyShot): string {
  if (shot.payload_src?.positive) return shot.payload_src.positive
  return [
    shot.slots?.artist,
    shot.slots?.character,
    shot.slots?.clothing,
    shot.blocks?.action,
    shot.blocks?.expression,
    shot.blocks?.camera,
    shot.blocks?.effect,
    shot.slots?.scene,
    shot.slots?.props,
  ]
    .filter(Boolean)
    .join(', ')
}

function shotTitle(shot: LazyShot): string {
  return shot.title || shot.source?.file || shot.id
}

export function LazyWallPane({ lazy, search, onApply }: { lazy: LazyLibraryState; search: string; onApply: (mutator: DocMutator) => void }) {
  const [zoom, setZoom] = useState<Zoom | null>(null)
  const [openSet, setOpenSet] = useState<string | null>(null)
  const [openComp, setOpenComp] = useState<string | null>(null)

  const sets = useMemo(
    () => lazy.sets.filter((set) => !set.trashed && matchText(search, set.title, set.work, ...(set.tags ?? []))),
    [lazy.sets, search],
  )
  const stdComps = useMemo(
    () => lazy.comps.filter((comp) => comp.type === 'standard' && !comp.trashed && matchText(search, comp.title)),
    [lazy.comps, search],
  )
  const origComps = useMemo(
    () => lazy.comps.filter((comp) => comp.type === 'original' && !comp.trashed && matchText(search, comp.title)),
    [lazy.comps, search],
  )
  const singles = useMemo(
    () =>
      lazy.shots.filter(
        (shot) => !shot.trashed && !shot.clip && matchText(search, shot.title, shot.source?.file, shot.source?.work, ...(shot.tags ?? [])),
      ),
    [lazy.shots, search],
  )

  // 组合成员 ref → 帧本体（选入编辑器需要 blocks/slots）
  const shotIndex = useMemo(() => {
    const map = new Map<string, LazyShot>()
    for (const shot of lazy.shots) map.set(shot.id, shot)
    for (const set of lazy.sets) for (const frame of set.frames ?? []) map.set(frame.id, frame)
    return map
  }, [lazy.shots, lazy.sets])

  const zoomProps = (src?: string) =>
    src
      ? {
          onMouseEnter: (event: React.MouseEvent) => setZoom({ src, x: event.clientX, y: event.clientY }),
          onMouseMove: (event: React.MouseEvent) => setZoom({ src, x: event.clientX, y: event.clientY }),
          onMouseLeave: () => setZoom(null),
        }
      : {}

  const img = (path?: string, alt = '') =>
    path ? <img className="lib-wall-img" src={`/${path}`} alt={alt} loading="lazy" {...zoomProps(path)} /> : <div className="lib-wall-noimg">无图</div>

  const frameCard = (frame: LazyShot, badge?: string) => (
    <div key={frame.id} className="lib-wall-card">
      {img(frame.thumb || frame.preview, shotTitle(frame))}
      {badge && <span className="lib-wall-badge">{badge}</span>}
      <div className="lib-wall-title" title={shotTitle(frame)}>{shotTitle(frame)}</div>
      <div className="lib-wall-btns">
        <button className="lib-wall-copy" type="button" onClick={() => void copyText(shotCopyText(frame))}>复制</button>
        <button className="lib-wall-pick" type="button" onClick={() => onApply(applyLazyShot(frame, shotTitle(frame)))}>选入编辑器</button>
      </div>
    </div>
  )

  const compSection = (title: string, midId: string, comps: ResolvedComp[], open: string | null, setOpen: (id: string | null) => void) => (
    <section className="lib-mid-section" id={slugId('lazydog', midId)}>
      <div className="lib-group-header">{title} <span className="lib-header-count">({comps.length})</span></div>
      <div className="lib-wall">
        {comps.map((comp) => (
          <div key={comp.id} style={{ display: 'contents' }}>
            <button className={`lib-wall-card ${open === comp.id ? 'sel' : ''}`} type="button" onClick={() => setOpen(open === comp.id ? null : comp.id)}>
              {img(comp.coverPreview, comp.title ?? comp.id)}
              <span className="lib-wall-badge">{comp.count}</span>
              <div className="lib-wall-title" title={comp.title ?? comp.id}>{comp.title ?? comp.id}</div>
              <div className="lib-wall-sub">{comp.missingCount > 0 ? `${comp.missingCount} 个失效引用` : '成员引用型组合'}</div>
            </button>
            {open === comp.id && (
              <div className="lib-frames">
                <div className="lib-frames-head">{comp.title ?? comp.id} · {comp.count} 成员（引用型，成员本体在单图/复刻套图）</div>
                <div className="lib-wall">
                  {comp.members.map((member, index) => {
                    if (member.missing) return null
                    const shot = shotIndex.get(member.ref)
                    if (shot) return frameCard(shot, String(index + 1))
                    return (
                      <div key={`${member.ref}:${member.seq}`} className="lib-wall-card">
                        {img(member.preview, member.mtitle ?? member.ref)}
                        <span className="lib-wall-badge">{index + 1}</span>
                        <div className="lib-wall-title">{member.mtitle ?? member.ref}</div>
                        <div className="lib-wall-sub">{member.kind === 'standard' ? '标准套图引用' : member.ref}</div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      {comps.length === 0 && <p className="lib-empty-hint">没有匹配的{title}</p>}
    </section>
  )

  if (lazy.loading) return <p className="lib-empty-hint">懒狗库加载中…</p>
  if (lazy.error) return <p className="lib-empty-hint">懒狗库加载失败：{lazy.error}（旧「懒狗库」tab 不受影响）</p>

  return (
    <div>
      <div className="lib-section-header">懒狗库 —— 验证过的成品骨架：套图 / 单图 / 组合（图墙 · 管理手势在旧「懒狗库」tab）</div>

      <section className="lib-mid-section" id={slugId('lazydog', 'sets')}>
        <div className="lib-group-header">套图·复刻 <span className="lib-header-count">({sets.length})</span></div>
        <div className="lib-wall">
          {sets.map((set) => (
            <div key={set.id} style={{ display: 'contents' }}>
              <button className={`lib-wall-card ${openSet === set.id ? 'sel' : ''}`} type="button" onClick={() => setOpenSet(openSet === set.id ? null : set.id)}>
                {img(set.cover, set.title)}
                <span className="lib-wall-badge">{set.count}</span>
                <div className="lib-wall-title" title={set.title}>{set.title}</div>
                {set.work && set.work !== set.title && <div className="lib-wall-sub">{set.work}</div>}
              </button>
              {openSet === set.id && (
                <div className="lib-frames">
                  <div className="lib-frames-head">{set.title} · {set.frames.length} 帧</div>
                  <div className="lib-wall">
                    {set.frames.map((frame) => frameCard(frame, frame.source?.page != null ? `p${String(frame.source.page).padStart(2, '0')}` : undefined))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
        {sets.length === 0 && <p className="lib-empty-hint">没有匹配的复刻套图</p>}
      </section>

      {compSection('套图·标准', 'std', stdComps, openComp, setOpenComp)}
      {compSection('套图·原创', 'orig', origComps, openComp, setOpenComp)}

      <section className="lib-mid-section" id={slugId('lazydog', 'shots')}>
        <div className="lib-group-header">单图（精品散图） <span className="lib-header-count">({singles.length})</span></div>
        <div className="lib-wall">{singles.map((shot) => frameCard(shot))}</div>
        {singles.length === 0 && <p className="lib-empty-hint">没有匹配的单图</p>}
      </section>

      {zoom && <ZoomLayer src={zoom.src} x={zoom.x} y={zoom.y} />}
    </div>
  )
}
