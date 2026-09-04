import { useEffect, useState } from 'react'
import { dataClient, type CharacterEntry, type InspirationEntry, type PublicNaiConfig, type RecipeEntry, type TagEntry, type TagThumbIndex } from './dataClient'

export type StudioDataState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready'
      tags: TagEntry[]
      recipes: RecipeEntry[]
      characters: CharacterEntry[]
      inspirations: InspirationEntry[]
      naiConfig: PublicNaiConfig
      imagePaths: string[]
      tagThumbs: TagThumbIndex
    }

export function useStudioData(): StudioDataState {
  const [state, setState] = useState<StudioDataState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false

    Promise.all([
      dataClient.getTags(),
      dataClient.getRecipes(),
      dataClient.getCharacters(),
      dataClient.fetchInspirations(),
      dataClient.getNaiConfig(),
      dataClient.getImages(),
      dataClient.fetchTagThumbs(),
    ])
      .then(([tags, recipes, characters, inspirations, naiConfig, imagePaths, tagThumbs]) => {
        if (!cancelled) {
          setState({ status: 'ready', tags, recipes, characters, inspirations, naiConfig, imagePaths, tagThumbs })
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : '加载失败'
          setState({ status: 'error', message })
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  return state
}
