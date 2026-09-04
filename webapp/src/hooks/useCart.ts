import { useState, useCallback, useRef } from 'react'
import type { Cart, CartItem, BlockRelation } from '../types'
import { BLOCK_ORDER } from '../types'

const CARTS_KEY = 'owner-carts'
const ACTIVE_KEY = 'owner-cart-active'

function genId() { return 'cart-' + Date.now().toString(36) }

function createEmpty(): Cart {
  return { id: genId(), name: '新小车', blocks: {}, blockRelations: {}, created: new Date().toISOString().slice(0, 10) }
}

interface CartState {
  carts: Cart[]
  activeId: string
}

function loadState(): CartState {
  let carts: Cart[] = []
  let activeId = ''
  try {
    const s = localStorage.getItem(CARTS_KEY)
    if (s) carts = JSON.parse(s)
  } catch { /* */ }
  if (!Array.isArray(carts) || carts.length === 0) carts = [createEmpty()]
  // 兼容旧数据：补充缺失的blockRelations
  for (const c of carts) { if (!c.blockRelations) c.blockRelations = {} }
  try { activeId = localStorage.getItem(ACTIVE_KEY) || '' } catch { /* */ }
  if (!carts.find(c => c.id === activeId)) activeId = carts[0].id
  return { carts, activeId }
}

function persist(carts: Cart[], activeId: string) {
  try {
    localStorage.setItem(CARTS_KEY, JSON.stringify(carts))
    localStorage.setItem(ACTIVE_KEY, activeId)
  } catch { /* */ }
}

export function useCart() {
  const initial = useRef(loadState()).current
  const [state, setState] = useState<CartState>(initial)

  const cart = state.carts.find(c => c.id === state.activeId) || state.carts[0]

  const update = useCallback((fn: (s: CartState) => CartState) => {
    setState(prev => {
      const next = fn(prev)
      persist(next.carts, next.activeId)
      return next
    })
  }, [])

  const getActive = (s: CartState) => s.carts.find(c => c.id === s.activeId) || s.carts[0]

  const updateActiveCart = useCallback((fn: (c: Cart) => Cart) => {
    update(s => {
      const active = getActive(s)
      return { ...s, carts: s.carts.map(c => c.id === active.id ? fn(c) : c) }
    })
  }, [update])

  const hasRecipeInBlock = useCallback((block: string): CartItem | null => {
    const items = cart?.blocks[block]
    if (!items) return null
    return items.find(i => i.type === 'recipe') || null
  }, [cart])

  const setBlockRelation = useCallback((block: string, relation: BlockRelation) => {
    updateActiveCart(c => ({
      ...c,
      blockRelations: { ...c.blockRelations, [block]: relation }
    }))
  }, [updateActiveCart])

  const addComponent = useCallback((block: string, item: CartItem) => {
    updateActiveCart(c => {
      const blockItems = c.blocks[block] || []
      if (blockItems.some(i => i.sourceId === item.sourceId)) return c
      return { ...c, blocks: { ...c.blocks, [block]: [...blockItems, item] } }
    })
  }, [updateActiveCart])

  const addItem = useCallback((block: string, item: CartItem) => {
    updateActiveCart(c => {
      const blockItems = c.blocks[block] || []
      if (blockItems.some(i => i.sourceId === item.sourceId)) return c
      return { ...c, blocks: { ...c.blocks, [block]: [...blockItems, item] } }
    })
  }, [updateActiveCart])

  const replaceRecipeInBlock = useCallback((block: string, item: CartItem) => {
    updateActiveCart(c => {
      const blockItems = (c.blocks[block] || []).filter(i => i.type !== 'recipe')
      return { ...c, blocks: { ...c.blocks, [block]: [item, ...blockItems] } }
    })
  }, [updateActiveCart])

  const removeItem = useCallback((block: string, sourceId: string) => {
    updateActiveCart(c => {
      const blockItems = (c.blocks[block] || []).filter(i => i.sourceId !== sourceId)
      const newBlocks = { ...c.blocks }
      const newRelations = { ...c.blockRelations }
      if (blockItems.length === 0) {
        delete newBlocks[block]
        delete newRelations[block]
      } else {
        newBlocks[block] = blockItems
        // 配方只剩1个或0个时，清除关系
        const recipeCount = blockItems.filter(i => i.type === 'recipe').length
        if (recipeCount <= 1) delete newRelations[block]
        // 权重数量对齐
        else if (newRelations[block]) {
          newRelations[block] = {
            ...newRelations[block],
            weights: Array.from({ length: recipeCount }, () => +(1 / recipeCount).toFixed(2))
          }
        }
      }
      return { ...c, blocks: newBlocks, blockRelations: newRelations }
    })
  }, [updateActiveCart])

  const clearCart = useCallback(() => {
    updateActiveCart(c => ({ ...c, blocks: {}, blockRelations: {} }))
  }, [updateActiveCart])

  const renameCart = useCallback((name: string) => {
    updateActiveCart(c => ({ ...c, name }))
  }, [updateActiveCart])

  const exportText = useCallback((): string => {
    if (!cart) return ''
    const lines: string[] = []
    const processed = new Set<string>()

    const formatBlock = (block: string, items: CartItem[]) => {
      const recipes = items.filter(i => i.type === 'recipe')
      const components = items.filter(i => i.type === 'component')
      const tags = items.filter(i => i.type === 'tag')
      const relation = cart.blockRelations[block]

      // 配方部分：按关系类型输出
      let recipePart = ''
      if (recipes.length > 0) {
        const clean = (i: CartItem) => i.tag.replace(/,\s*$/, '').trim()
        if (!relation || relation.type === 'and' || recipes.length === 1) {
          recipePart = recipes.map(i => clean(i)).join(', ')
        } else if (relation.type === 'or') {
          recipePart = '{' + recipes.map(i => clean(i)).join('|') + '}'
        } else if (relation.type === 'blend') {
          const weights = relation.weights.length === recipes.length
            ? relation.weights
            : recipes.map(() => +(1 / recipes.length).toFixed(2))
          recipePart = recipes.map((i, idx) => `(${clean(i)}:${weights[idx]})`).join(', ')
        } else if (relation.type === 'schedule') {
          if (recipes.length === 2) {
            const w = relation.weights[1] ?? 0.5
            recipePart = `[${clean(recipes[0])}:${clean(recipes[1])}:${w}]`
          } else {
            // 3+配方schedule退化为AND
            recipePart = recipes.map(i => clean(i)).join(', ')
          }
        }
      }

      // 部件和tag始终AND输出
      const extras = [...components, ...tags].map(i => i.tag.replace(/,\s*$/, '').trim())
      const allParts = [recipePart, ...extras].filter(Boolean)
      if (allParts.length > 0) lines.push(allParts.join(', ') + ',')
    }

    for (const block of BLOCK_ORDER) {
      const items = cart.blocks[block as string]
      if (!items || items.length === 0) continue
      processed.add(block as string)
      formatBlock(block as string, items)
    }
    for (const [block, items] of Object.entries(cart.blocks)) {
      if (processed.has(block) || items.length === 0) continue
      formatBlock(block, items)
    }
    return lines.join('\n\nBREAK\n\n')
  }, [cart])

  const createNewCart = useCallback(() => {
    const newCart = createEmpty()
    update(s => ({ carts: [...s.carts, newCart], activeId: newCart.id }))
  }, [update])

  const switchCart = useCallback((id: string) => {
    update(s => ({ ...s, activeId: id }))
  }, [update])

  const deleteCart = useCallback((id: string) => {
    update(s => {
      let next = s.carts.filter(c => c.id !== id)
      if (next.length === 0) next = [createEmpty()]
      return { carts: next, activeId: id === s.activeId ? next[0].id : s.activeId }
    })
  }, [update])

  const itemCount = cart ? Object.values(cart.blocks).reduce((sum, arr) => sum + arr.length, 0) : 0

  return {
    cart, carts: state.carts,
    addItem, addComponent, replaceRecipeInBlock, removeItem,
    clearCart, renameCart, exportText,
    hasRecipeInBlock, setBlockRelation,
    createNewCart, switchCart, deleteCart,
    itemCount,
  }
}
