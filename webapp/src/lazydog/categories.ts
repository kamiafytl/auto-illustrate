// 散图库杂项常量。大类→中类树已改为后端数据(data/lazydog/categories.json),经 /api/rating/categories 读写,不再写死在此。

/** 待部署区的稳定 key(category 为空 / 指向已删大类时归此) */
export const STAGING = '__staging__'

/** 建议标签(快捷按钮;编辑面板仍可输任意新标签) */
export const SUGGESTED_TAGS = ['神级构图', '特殊效果']

/** 大类配色(按顺序循环,用于区分大类与大类) */
export const PALETTE = ['#5b8cff', '#e07b3a', '#36b37e', '#a06bff', '#e35d8a', '#2bb6c4', '#d9a527', '#e0594f']

/** 生成稳定 id(新建大类/中类用;改名不动 id) */
export const newId = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return 'c_' + (c?.randomUUID ? c.randomUUID().slice(0, 8) : Math.floor(performance.now() * 1000).toString(36))
}
