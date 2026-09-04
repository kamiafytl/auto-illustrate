/// <reference types="node" />
import assert from 'node:assert/strict'
import { toNaiPayload } from '../toNaiPayload'
import type { PromptAtom, PromptDoc } from '../types/prompt'

function atom(id: string, text: string, patch: Partial<PromptAtom> = {}): PromptAtom {
  return {
    id,
    kind: 'raw',
    text,
    enabled: true,
    private: false,
    source: { type: 'manual' },
    editable: true,
    ...patch,
  }
}

const doc: PromptDoc = {
  id: 'doc_check',
  version: 1,
  target: 'nai',
  title: 'E1 check',
  baseSections: [
    {
      id: 'quality',
      role: 'quality',
      block: 'style',
      enabled: true,
      private: false,
      atoms: [
        atom('q1', 'masterpiece'),
        atom('q2', 'best quality', { weight: { mode: 'nai_colon', value: 1.1 } }),
        atom('q3', 'disabled base', { enabled: false }),
      ],
    },
    {
      id: 'artist',
      role: 'artist',
      block: 'style',
      enabled: true,
      private: true,
      atoms: [atom('a1', '__PRIVATE_artist__', { private: true })],
    },
    {
      id: 'camera',
      role: 'camera',
      block: 'camera',
      enabled: false,
      private: false,
      atoms: [atom('cam1', 'from above')],
    },
  ],
  characterSections: [
    {
      id: 'c1',
      name: '女主',
      enabled: true,
      view: { perspective: 'front', composition: 'upper', linkedToCamera: false, manuallyOverridden: true },
      position: { x: 0.3, y: 0.7 },
      atoms: [
        atom('c1t', 'blue eyes', { kind: 'character_trait' }),
        atom('c1o', 'white dress', { kind: 'outfit', weight: { mode: 'nai_colon', value: 1.25 } }),
        atom('c1off', 'disabled char', { enabled: false }),
      ],
      negativeAtoms: [atom('c1n', 'bad hands'), atom('c1n2', 'lowres', { enabled: false })],
      relationAtoms: [
        atom('r1', 'hug', {
          kind: 'relation',
          relation: { verb: 'hug', sourceIndex: 1, targetIndex: 2, sourceSectionId: 'c1', targetSectionId: 'c2' },
        }),
        atom('r2', 'french kiss', {
          kind: 'relation',
          category: 'mutual',
          relation: { verb: 'french kiss', sourceIndex: 1, targetIndex: 2, sourceSectionId: 'c1', targetSectionId: 'c2' },
        }),
      ],
    },
    {
      id: 'c2',
      name: '配角',
      enabled: true,
      view: { perspective: 'back', composition: 'full', linkedToCamera: false, manuallyOverridden: true },
      position: { x: 0.8, y: 0.4 },
      atoms: [atom('c2t', 'short hair')],
      negativeAtoms: [atom('c2n', 'extra fingers')],
      relationAtoms: [
        atom('r1copy', 'hug', {
          kind: 'relation',
          relation: { verb: 'hug', sourceIndex: 1, targetIndex: 2, sourceSectionId: 'c1', targetSectionId: 'c2' },
        }),
      ],
    },
    {
      id: 'c3',
      name: '禁用角色',
      enabled: false,
      view: { perspective: 'front', composition: 'full', linkedToCamera: true, manuallyOverridden: false },
      atoms: [atom('c3t', 'should skip')],
    },
  ],
  meta: { createdAt: '2026-07-08T00:00:00.000Z', updatedAt: '2026-07-08T00:00:00.000Z' },
}

const actual = toNaiPayload(doc)

assert.deepEqual(actual, {
  baseBlocks: [
    {
      id: 'next_quality',
      name: '画风质量',
      text: 'masterpiece, (best quality:1.1)',
      enabled: true,
      isPrivate: false,
    },
    {
      id: 'next_artist',
      name: '画师串',
      text: '__PRIVATE_artist__',
      enabled: true,
      isPrivate: true,
    },
  ],
  characters: [
    {
      id: 'next_c1',
      name: '女主',
      text: 'blue eyes, (white dress:1.2), source#hug, mutual#french kiss',
      enabled: true,
      position: { x: 0.3, y: 0.7 },
      negative_text: 'bad hands',
      view: 'front_upper',
    },
    {
      id: 'next_c2',
      name: '配角',
      text: 'short hair, target#hug, mutual#french kiss',
      enabled: true,
      position: { x: 0.8, y: 0.4 },
      negative_text: 'extra fingers',
      view: 'back_full',
    },
  ],
})

console.log('toNaiPayload.check ok: baseBlocks=2 characters=2 relation/weight/private/view/position/negative matched')
