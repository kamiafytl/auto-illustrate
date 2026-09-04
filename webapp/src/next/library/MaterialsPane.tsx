// 原料大类（E2 蓝图 §二）：画师串 / 质量词 / 衣服 / 场景 / 特殊效果 / tag词典 六中类 + legacy 存档折叠。
// 视觉=整页照抄旧配方库：浅蓝中类横幅 + 三列卡片；数据源现文件原地读，零合并零搬家。
import type { CSSProperties } from 'react'
import type { CharacterEntry, PublicNaiConfig, RecipeEntry, TagEntry } from '../editor/lib/dataClient'
import { CopyBtn, PickBtn, RecipeCard, matchText, slugId } from './parts'
import { applyNaiDefault, applyOutfit, applyRecipe, applyTag, type DocMutator } from './selectToEditor'
import { TagDictSection } from './TagDictSection'
import { copyText } from '../../utils/clipboard'

export type MaterialsData = {
  recipes: RecipeEntry[]
  tags: TagEntry[]
  characters: CharacterEntry[]
  naiConfig: PublicNaiConfig
}

export type NaiDefaultEntry = { name: string; text: string; role: 'quality' | 'artist' }

/** nai_config 默认串（权威源）里值得在库页展示的两条：画风质量 + 默认画师串 */
export function extractNaiDefaults(config: PublicNaiConfig): NaiDefaultEntry[] {
  if (!Array.isArray(config.default_base_blocks)) return []
  const wanted: Record<string, 'quality' | 'artist'> = { 画风质量: 'quality', 画师串: 'artist' }
  const result: NaiDefaultEntry[] = []
  for (const entry of config.default_base_blocks) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name : ''
    const text = typeof record.text === 'string' ? record.text.trim() : ''
    if (name in wanted && text) result.push({ name, text, role: wanted[name] })
  }
  return result
}

function groupBy<T>(list: T[], keyOf: (item: T) => string): { key: string; items: T[] }[] {
  const order: string[] = []
  const map = new Map<string, T[]>()
  for (const item of list) {
    const key = keyOf(item) || '未分组'
    if (!map.has(key)) {
      map.set(key, [])
      order.push(key)
    }
    map.get(key)!.push(item)
  }
  return order.map((key) => ({ key, items: map.get(key)! }))
}

// 画师串大类的稳定置顶顺序（备注：主力整合串永远第一，别再随 style.json 数组顺序变动而乱跳）。
// 已知类按此固定序；未知类按名稳定排在最后（localeCompare→确定性，不依赖数组顺序）。
const ARTIST_CATEGORY_ORDER = ['主力整合串', 'NAI决胜画师串', 'NAI复刻源串', 'NAI系']
function stableGroups<T>(groups: { key: string; items: T[] }[], priority: string[]): { key: string; items: T[] }[] {
  const rank = (k: string) => { const i = priority.indexOf(k); return i < 0 ? priority.length : i }
  return [...groups].sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key, 'zh'))
}
// 分组自动配色（无需手设·自然区分）：按稳定序取精选色相
const LIB_HUES = [265, 205, 330, 28, 150, 48, 300, 178, 95, 240]
const libHue = (i: number) => LIB_HUES[i % LIB_HUES.length]

export function MaterialsPane({ data, search, onApply }: { data: MaterialsData; search: string; onApply: (mutator: DocMutator) => void }) {
  const { recipes, tags, characters, naiConfig } = data
  const match = (recipe: RecipeEntry) => matchText(search, recipe.name, recipe.tags, recipe.note, recipe.category, recipe.group)

  const artists = recipes.filter((recipe) => recipe.block === 'style' && match(recipe))
  const clothing = recipes.filter((recipe) => recipe.block === 'clothing' && match(recipe))
  const scenes = recipes.filter((recipe) => recipe.block === 'scene' && match(recipe))
  const effects = recipes.filter((recipe) => recipe.block === 'effect' && match(recipe))
  const legacyArchive = recipes.filter((recipe) => (recipe.block === 'action' || recipe.block === 'expression') && match(recipe))
  const naiDefaults = extractNaiDefaults(naiConfig).filter((entry) => matchText(search, entry.name, entry.text))
  const boundWardrobes = characters
    .map((character) => ({
      character,
      outfits: character.outfits.filter((outfit) => matchText(search, outfit.name, outfit.tags.front_full, character.name)),
    }))
    .filter((entry) => entry.outfits.length > 0)
  const boundCount = boundWardrobes.reduce((sum, entry) => sum + entry.outfits.length, 0)

  return (
    <div>
      <div className="lib-section-header">原料 —— 可替换零件：画师串 / 质量词 / 衣服 / 场景 / 特殊效果 / tag词典</div>

      {/* 画师串（style.json；sub_style=隐私占位不在此展示） */}
      <section className="lib-mid-section" id={slugId('materials', 'artist')}>
        <div className="lib-group-header">
          画师串 <span className="lib-header-count">({artists.length})</span>
          <span className="lib-header-note">次画风（sub_style）为隐私占位，由 submit 脚本合并，库页不展示</span>
        </div>
        {stableGroups(groupBy(artists, (recipe) => recipe.category), ARTIST_CATEGORY_ORDER).map((group, gi) => (
          <div key={group.key} id={slugId('materials', 'artist', group.key)} className="lib-cat-group"
            style={{ ['--g-hue']: String(libHue(gi)) } as CSSProperties}>
            <div className="lib-subhead">
              {group.key === ARTIST_CATEGORY_ORDER[0] && <span className="lib-pin" title="已置顶（主力）">📌</span>}
              {group.key} <span className="lib-header-count">({group.items.length})</span>
            </div>
            <div className="lib-grid">
              {group.items.map((recipe) => (
                <RecipeCard key={recipe.id} recipe={recipe} onPick={() => onApply(applyRecipe(recipe))} />
              ))}
            </div>
          </div>
        ))}
        {artists.length === 0 && <p className="lib-empty-hint">没有匹配的画师串</p>}
      </section>

      {/* 质量词（权威源=data/nai_config.json：展示+入编辑器，不在库页改） */}
      <section className="lib-mid-section" id={slugId('materials', 'quality')}>
        <div className="lib-group-header">
          质量词 <span className="lib-header-count">({naiDefaults.length})</span>
          <span className="lib-header-note">权威源 = data/nai_config.json 默认串 · 只读展示，修改去 NAI 队列面板</span>
        </div>
        <div className="lib-grid">
          {naiDefaults.map((entry) => (
            <div key={entry.name} className="lib-card">
              <div className="lib-card-info">
                <h3 className="lib-card-name">默认{entry.name}</h3>
                <span className="lib-card-group-tag">nai_config 权威源</span>
                <div className="lib-btn-row">
                  <CopyBtn text={entry.text} />
                  <PickBtn onPick={() => onApply(applyNaiDefault(entry.text, `default_base_blocks.${entry.name}`, entry.role))} />
                </div>
                <pre className="lib-card-tags">{entry.text}</pre>
              </div>
            </div>
          ))}
          {naiDefaults.length === 0 && <p className="lib-empty-hint">nai_config 默认串为空或未匹配</p>}
        </div>
      </section>

      {/* 衣服（一份数据两个入口=原则⑦：clothing.json 通用 + 各角色绑定衣柜汇总视图） */}
      <section className="lib-mid-section" id={slugId('materials', 'clothing')}>
        <div className="lib-group-header">
          衣服 <span className="lib-header-count">({clothing.length} 通用 + {boundCount} 角色绑定)</span>
          <span className="lib-header-note">角色绑定衣柜存 characters.json，同一份数据也嵌在角色卡里</span>
        </div>
        {groupBy(clothing, (recipe) => recipe.group).map((group) => (
          <div key={group.key} id={slugId('materials', 'clothing', group.key)}>
            <div className="lib-subhead">通用 · {group.key} <span className="lib-header-count">({group.items.length})</span></div>
            <div className="lib-grid">
              {group.items.map((recipe) => (
                <RecipeCard key={recipe.id} recipe={recipe} onPick={() => onApply(applyRecipe(recipe))} />
              ))}
            </div>
          </div>
        ))}
        {boundWardrobes.map(({ character, outfits }) => (
          <div key={character.id} id={slugId('materials', 'clothing', `角色绑定·${character.name}`)}>
            <div className="lib-subhead">角色绑定 · {character.name} <span className="lib-header-count">({outfits.length})</span></div>
            <div className="lib-grid">
              {outfits.map((outfit) => (
                <div key={outfit.id} className="lib-card">
                  <div className="lib-card-image">
                    <img
                      src={`/data/images/outfit--${outfit.id}_full.webp`}
                      alt={outfit.name}
                      loading="lazy"
                      onError={(event) => {
                        (event.currentTarget.parentElement as HTMLElement).style.display = 'none'
                      }}
                    />
                  </div>
                  <div className="lib-card-info">
                    <h3 className="lib-card-name">{outfit.name}</h3>
                    <span className="lib-card-group-tag">角色绑定·{character.name}</span>
                    <div className="lib-btn-row">
                      <CopyBtn text={outfit.tags.front_full || ''} />
                      <PickBtn onPick={() => onApply(applyOutfit(character, outfit.id))} />
                    </div>
                    <pre className={`lib-card-tags ${!outfit.tags.front_full ? 'is-empty' : ''}`}>{outfit.tags.front_full || '（未填写）'}</pre>
                    {outfit.note && <p className="lib-card-note">{outfit.note}</p>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
        {clothing.length === 0 && boundCount === 0 && <p className="lib-empty-hint">没有匹配的衣服</p>}
      </section>

      {/* 场景（默认归入原料·待 Owner 确认，蓝图 §二） */}
      <section className="lib-mid-section" id={slugId('materials', 'scene')}>
        <div className="lib-group-header">场景 <span className="lib-header-count">({scenes.length})</span></div>
        <div className="lib-grid">
          {scenes.map((recipe) => (
            <RecipeCard key={recipe.id} recipe={recipe} onPick={() => onApply(applyRecipe(recipe))} />
          ))}
        </div>
        {scenes.length === 0 && <p className="lib-empty-hint">没有匹配的场景</p>}
      </section>

      {/* 特殊效果（可叠加效果层，与画风质量分离） */}
      <section className="lib-mid-section" id={slugId('materials', 'effect')}>
        <div className="lib-group-header">特殊效果 <span className="lib-header-count">({effects.length})</span></div>
        <div className="lib-grid">
          {effects.map((recipe) => (
            <RecipeCard key={recipe.id} recipe={recipe} onPick={() => onApply(applyRecipe(recipe))} />
          ))}
        </div>
        {effects.length === 0 && <p className="lib-empty-hint">没有匹配的特殊效果</p>}
      </section>

      {/* tag 词典（简单列表+搜索，查阅性质·禁重UI；danbooru 接网=差异点6） */}
      <section className="lib-mid-section" id={slugId('materials', 'tags')}>
        <TagDictSection tags={tags} search={search} onPick={(tag) => onApply(applyTag(tag))} />
      </section>

      {/* legacy 存档（ComfyUI 时代 action/expression 遗产：只读折叠，去留=C6 盘点） */}
      <section className="lib-mid-section" id={slugId('materials', 'legacy')}>
        <details className="lib-legacy">
          <summary>legacy 存档（旧 action/expression 配方 · 只读 · 去留待 C6 盘点）（{legacyArchive.length}）</summary>
          {legacyArchive.map((recipe) => (
            <div key={recipe.id} className="lib-legacy-row">
              <span className="lib-legacy-name">{recipe.name}</span>
              <span className="lib-legacy-tags" title={recipe.tags}>{recipe.tags}</span>
              <span className="ltg-btns">
                <button className="ltg-copy" type="button" onClick={() => void copyText(recipe.tags)}>复制</button>
                <button className="ltg-pick" type="button" onClick={() => onApply(applyRecipe(recipe))}>选入</button>
              </span>
            </div>
          ))}
          {legacyArchive.length === 0 && <p className="lib-empty-hint">无匹配条目</p>}
        </details>
      </section>
    </div>
  )
}
