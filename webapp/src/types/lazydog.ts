// 懒狗出图系统 — 单图骨架库类型
// 设计本质见 internal-docs / 存储手册 internal-docs。
// 一句话:四槽(画师/角色/衣服/场景)可换,单图身份=固定骨架(动作/机位/概念/表情)。
// 入库=被验证可换槽的骨架 + 自出预览图。分类=七面标签(facets.json,可扩展)。
// ⚠ 改本文件/facets.json/shots.json/rating 端点前必读 internal-docs「懒狗出图系统」节。

/** 一个面的取值(扁平或分组) */
export interface FacetValue { v: string; zh: string }
export interface FacetGroup { name?: string; gate?: string[]; values: FacetValue[] }
export interface FacetDef {
  key: string            // 面的稳定 key(facets 映射键)
  label: string          // A-G
  name: string           // 中文面名
  multi: boolean         // 是否多选
  auto: boolean          // 是否可由 tag 自动预填(CC录入)、人工复核
  bifurcateBy?: string   // 该面按另一面的值切换值组(act 按 rating 分叉)
  note?: string
  values?: FacetValue[]  // 扁平取值
  groups?: FacetGroup[]  // 分组取值(与 values 二选一)
}
export interface FacetVocab { version: number; note?: string; facets: FacetDef[] }

/** 单图打标值:面 key → 选中的取值数组(单选面也用数组,长度≤1) */
export type ShotFacets = Record<string, string[]>

/** 散图库 大类→中类→小类 三层树(data/lazydog/categories.json;id 稳定,name 可改) */
export interface CatSubSub { id: string; name: string }
export interface CatSub { id: string; name: string; subs?: CatSubSub[] }
export interface CatGroup { id: string; name: string; subs: CatSub[] }
export interface CatTree { version: number; note?: string; groups: CatGroup[] }

/** 套图库 套图级元数据(data/lazydog/sets_meta.json;键=setId=source.folder)。
 *  套图帧本体在 sets.json(LazyShot[]);此处只存套图级的人工调整(套序/帧序/封面/改名/软删),
 *  与洗 shots.json 的流程零冲突(sets.json 仅"导入新套"时追加)。 */
export interface LazySetMeta {
  title?: string                       // 套图显示名(不填用 source.work 兜底)
  cover?: string                       // 封面=某帧 id(不填用排序后首帧)
  order?: number                       // 套图在画廊里的手拖排序(升序)
  tags?: string[]                      // 套图级标签
  // 套图分类(大中小三层;与单图同架构、独立树 set_categories.json;内容由用户自建)。空=待部署区
  category?: string
  subcategory?: string
  subsubcategory?: string
  frameOrder?: Record<string, number>  // 帧 id → 顺序权重(覆盖默认 page 序)
  frameMeta?: Record<string, { tags?: string[]; note?: string }>  // 帧级 tags/note(只存这里,不回写 sets.json)
  extraFrames?: LazyShot[]             // 显式成员:粘进本套的副本帧(独立 id,共享原预览)
  removed?: string[]                   // 被剪出本套的自然帧 id(读侧隐藏)
  trashed?: boolean                    // 软删除(套图视图隐藏,可还原)
  trashedAt?: string
}

/** 单图骨架库条目 */
/** 分段视图的一段：槽标签 + 原文片段(含尾部分隔符)。见 LazyShot.seg。 */
export interface FrameSeg {
  cat: string            // 'artist'|'character'|'clothing'|'scene'|'props'|'skeleton'|'quality'|'unknown'|'syntax'
  note?: string          // skeleton 属哪块：动作/表情/机位/效果/男角
  text: string           // 原文片段，逐字保留
}

export interface LazyShot {
  id: string                 // 稳定 id = source.folder + '/' + source.file(评分系统天然唯一)
  facets: ShotFacets         // 七面打标(Owner 在评分面板录入)
  /** 固定骨架 tag 原文(挖槽后归此;CC 读图 meta 自动录入) */
  blocks: {
    action?: string
    expression?: string
    camera?: string
    effect?: string
  }
  /** 六桶可换槽的【原值】(挖槽时识别归位、全部存进库,一个不丢)。2026-06-21 四桶→六桶。
   *  想换槽=替换对应槽;不换=直接用原值(任一槽都可能"不变")。除 NOISE/质量(默认串管)外不丢弃。
   *  ⚠ 跑图忠实源是 payload_src(多角色保真),slots 是【可读/换槽规划层】。挖槽守则=character_swap_guide.md。 */
  slots?: {
    artist?: string      // ①画师串原值
    character?: string   // ②角色特征原值(名/发/瞳/固有标记/体型)
    clothing?: string    // ③衣服槽原值(主装)
    scene?: string       // ④场景槽原值(纯空间地点)
    props?: string       // ⑤道具·特殊play原值(口罩/项圈/绳/性玩具/cosplay兽配件;换衣换角都保留)
    view?: string        // 该帧视角元数据(front_full/back_cowboy…),换衣按它选正/背×构图变体(非prompt)
    male?: string        // 多角色帧的男角 caption(' || '分隔;slots单女拍扁装不下,跑图忠实源在 payload_src)
    cast?: string[]      // 该帧出场女角编号(['f1']/['f1','f2']/['f2']/[]=无女)。入库人工标·跑图禁runtime推断(同view规格)。
                         // 加装层按它门控 role persona(main无条件/f1·f2 cast含才装)紧凑落槽。无cast=旧默认路径(数括号+persona落char1+orange)。
                         // 详见 internal-docs + character_swap_guide §5.1
  }
  /** 跑图忠实源(原图作者 build_payload 形态:base/女角原identity/男角/centers/params/seed)。
   *  run_db_draw 读它走 RS.transform_built(换AW/换衣/半脱/道具/view)→ 保证【入库后跑图==复刻】、多角色不崩。
   *  与 payload(成品 json 路径)区分:payload_src=原图源(供再变换),payload=成品路径。2026-06-21。 */
  payload_src?: {
    positive: string; negative?: string
    characters: Array<{ text: string; x?: number; y?: number; negative?: string }>
    seed?: number; params?: Record<string, unknown>
  }
  preview: string            // 自出预览图相对 webapp/public(如 images/lazydog/xxx.png);gitignore,可丢失
  thumb?: string             // 缩略图(~320px JPEG,进 git;相对 webapp/public 如 lazydog-thumbs/xxx.jpg)。卡片显示用;大图 hover 用 preview
  nl_frame?: boolean         // NL散文帧: 身份/衣物嵌长句,tag级换槽可能剥不净
  /** 分段视图(2026-08-27·「直接编辑到槽」)：把 payload_src 各区域文本切成【带槽标签的片段】，一段一框改。
   *  纯编辑视图，跑图不读——执行源永远是 payload_src。铁律：各区域 segs.map(s=>s.text).join('') === 该区域原文
   *  (逐字节；端点侧强校验，不等即 400)。cat/note 语义同 promptTokens.Classified。生成=前端 autoSegs 或手改。 */
  seg?: {
    positive?: FrameSeg[]
    negative?: FrameSeg[]
    chars?: FrameSeg[][]      // 按 payload_src.characters 索引对齐
    charNegs?: FrameSeg[][]
  }
  source: {                  // 溯源(来自评分系统)
    work?: string            // 原作品/套图名
    folder: string           // 评分文件夹(相对 RATING_BASE)
    file: string             // 出图文件名
    page?: number            // _pNN
    seed?: number
    request_type?: 'img2img' | 'inpaint'
  }
  payload?: string           // 可一键重跑的 payload.json 路径(submit_nai.py --json-stdin),见 drawing_workflow §十一
  /** 四槽换槽测试结论(测通才算可换;复刻/切槽审核结果) */
  swapTested: { artist?: boolean; character?: boolean; clothing?: boolean; scene?: boolean }
  status: 'draft' | 'confirmed'  // draft=Owner 入库(facets已录)、blocks待CC补;confirmed=CC录入+复核完
  title?: string             // 人类可读名(懒狗浏览器可编辑;不填则用 source.file 兜底显示)
  note?: string
  // —— 散图库(精品库)字段。与七面 facets 共存、互不干扰;散图库 UI 用这几个,facets 留作将来拼剧本 ——
  category?: string          // 大类 id(空=待部署区)。值集=data/lazydog/categories.json,可增删改名/排序
  subcategory?: string       // 中类 id(空=只挂在大类下,不进任何中类)
  subsubcategory?: string    // 小类 id(空=只挂在中类下,不进任何小类)
  tags?: string[]            // 散图库自由标签(神级构图/特殊效果…),可筛选,与 facets/blocks 无关
  order?: number             // 同(大类,中类)内手动拖拽排序权重(升序);未排序兜底用 created
  trashed?: boolean          // 软删除:在垃圾桶里(全库视图隐藏);彻底删/清空才真删条目+预览
  trashedAt?: string         // 进垃圾桶时间(供定期清理参考)
  clip?: boolean             // 复制区:此条目是独立副本,挂在复制区(不进分类视图);拖出到分类则清此标记
  copyOf?: string            // 副本溯源:复制自哪个 id(副本共享原预览文件)
  created: string            // ISO
  updated?: string
}

/** 三类套图·引用型组合(标准套图/原创套图;data/lazydog/compositions.json)。详见 internal-docs §4.8。
 *  复刻套图/精品单图=具体帧(有预览),走 shots.json/sets.json;标准/原创=纯引用,不存帧本体、只存有序引用 id。 */
export interface CompMember {
  kind: 'shot' | 'frame' | 'standard'  // 显式判别(禁靠 id 字符串猜:setId 是 frameid 前缀)。shot=精品单图、frame=复刻套图某帧(均查 shots/sets),standard=标准套图(comp id)
  ref: string                          // 被引 id:shot/frame=LazyShot.id(folder/file);standard=Composition.id(comp_xxx)
  seq: number                          // 组合内播放序(升序)。禁回写 LazyShot.order(那是散图库浏览序,重名易混)
  stage?: string                       // G段階占位(前戏/本番/高潮/事后),下期拼剧本用
}
export interface Composition {
  id: string                           // comp_xxx(与 folder / copy_ 三 id 空间不撞)
  type: 'standard' | 'original'        // 标准套图(只引 shot+frame,叶子) / 原创套图(可引 standard+shot+frame)
  title?: string
  cover?: CompMember                   // 手动封面=某成员;不填用首个有效成员
  members: CompMember[]
  tags?: string[]
  // 套图分类(与复刻套图共用同一棵 set_categories.json;标准/原创套图也能挂大中小类)。空=待部署区
  category?: string
  subcategory?: string
  subsubcategory?: string
  trashed?: boolean
  trashedAt?: string
  created: string                      // ISO
  updated?: string
}
export interface CompTree { version: number; note?: string; items: Composition[] }

/** 后端组装好的组合对象(成员已回填预览/标题,孤儿已过滤)——GET /api/rating/compositions 返回形态 */
export interface ResolvedMember extends CompMember { preview?: string; mtitle?: string; missing?: boolean }
export interface ResolvedComp extends Omit<Composition, 'members'> {
  members: ResolvedMember[]
  cover?: CompMember
  coverPreview?: string                // 解析后的封面预览(回退首个有效成员)
  count: number                        // 有效(非孤儿)成员数
  missingCount: number                 // 失效引用数
}
