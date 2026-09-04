import { useCallback, useEffect, useRef, useState } from 'react'
import { dataClient, type CharacterEntry, type InspirationEntry, type PublicNaiConfig, type RecipeEntry, type TagEntry, type TagThumbIndex } from './dataClient'

export type StudioDataState =
  | { status: 'loading' }
  | {
      status: 'ready'
      tags: TagEntry[]
      recipes: RecipeEntry[]
      characters: CharacterEntry[]
      inspirations: InspirationEntry[]
      naiConfig: PublicNaiConfig
      imagePaths: string[]
      tagThumbs: TagThumbIndex
      warnings: string[]
    }

export type StudioDataHook = { state: StudioDataState; reload: () => Promise<void> }

export function useStudioData(): StudioDataHook {
  const [state, setState] = useState<StudioDataState>({ status: 'loading' })
  const aliveRef = useRef(true)

  const load = useCallback(async () => {
    const guard = async <T,>(label: string, fallback: T, loader: () => Promise<T>): Promise<[T, string | null]> => {
      try {
        return [await loader(), null]
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return [fallback, `${label}: ${message}`]
      }
    }

    try {
      const results = await Promise.all([
        guard('tags', [] as TagEntry[], dataClient.getTags),
        guard('recipes', [] as RecipeEntry[], dataClient.getRecipes),
        guard('characters', [] as CharacterEntry[], dataClient.getCharacters),
        guard('inspirations', [] as InspirationEntry[], dataClient.fetchInspirations),
        guard('naiConfig', {} as PublicNaiConfig, dataClient.getNaiConfig),
        guard('images', [] as string[], dataClient.getImages),
        guard('tagThumbs', {} as TagThumbIndex, dataClient.fetchTagThumbs),
      ])
      if (!aliveRef.current) return
      const [[tags], [recipes], [characters], [inspirations], [naiConfig], [imagePaths], [tagThumbs]] = results
      const warnings = results.map(([, warning]) => warning).filter((warning): warning is string => Boolean(warning))
      setState({ status: 'ready', tags, recipes, characters, inspirations, naiConfig, imagePaths, tagThumbs, warnings })
    } catch (error: unknown) {
      if (!aliveRef.current) return
      const message = error instanceof Error ? error.message : '加载失败'
      setState({
        status: 'ready',
        tags: [],
        recipes: [],
        characters: [],
        inspirations: [],
        naiConfig: {},
        imagePaths: [],
        tagThumbs: {},
        warnings: [`load: ${message}`],
      })
    }
  }, [])

  useEffect(() => {
    aliveRef.current = true
    load()
    return () => {
      aliveRef.current = false
    }
  }, [load])

  return { state, reload: load }
}
