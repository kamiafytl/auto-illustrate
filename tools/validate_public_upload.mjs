#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const errors = []
const warnings = []

function relPath(...parts) {
  return path.join(ROOT, ...parts)
}

function readJson(rel) {
  try {
    return JSON.parse(fs.readFileSync(relPath(rel), 'utf8'))
  } catch (err) {
    errors.push(`JSON parse failed: ${rel}: ${err.message}`)
    return null
  }
}

function uniqueIds(items, label) {
  const seen = new Set()
  for (const item of items || []) {
    if (!item?.id) {
      errors.push(`${label}: item without id`)
      continue
    }
    if (seen.has(item.id)) errors.push(`${label}: duplicate id ${item.id}`)
    seen.add(item.id)
  }
  return seen
}

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT })
  return new Set(out.toString('utf8').split('\0').filter(Boolean))
}

const tracked = trackedFiles()
for (const rel of [
  'data/nai_config.json',
  'data/nai_augment_private.json',
  'data/private_blocks.json',
  '.env',
]) {
  if (tracked.has(rel)) errors.push(`private file is tracked: ${rel}`)
}

const facetsDb = readJson('data/lazydog/facets.json')
const shots = readJson('data/lazydog/shots.json') || []
const sets = readJson('data/lazydog/sets.json') || []
const setsMeta = readJson('data/lazydog/sets_meta.json') || { sets: {} }
const comps = readJson('data/lazydog/compositions.json') || { items: [] }
readJson('data/lazydog/categories.json')
readJson('data/lazydog/set_categories.json')

const shotIds = uniqueIds(shots, 'shots.json')
const frameIds = uniqueIds(sets, 'sets.json')
const compIds = uniqueIds(comps.items || [], 'compositions.json')

const facetValues = new Map()
for (const facet of facetsDb?.facets || []) {
  const values = new Set()
  for (const item of facet.values || []) values.add(item.v)
  for (const group of facet.groups || []) {
    for (const item of group.values || []) values.add(item.v)
  }
  facetValues.set(facet.key, values)
}

function validateFacets(item, label) {
  for (const [key, values] of Object.entries(item.facets || {})) {
    if (!facetValues.has(key)) {
      errors.push(`${label} ${item.id}: unknown facet key ${key}`)
      continue
    }
    const allowed = facetValues.get(key)
    for (const value of values || []) {
      if (allowed.size && !allowed.has(value)) {
        errors.push(`${label} ${item.id}: unknown facet value ${key}=${value}`)
      }
    }
  }
}

function validateThumb(item, label) {
  if (!item.thumb) {
    warnings.push(`${label} ${item.id}: missing thumb`)
    return
  }
  const thumbPath = relPath('webapp/public', item.thumb)
  if (!fs.existsSync(thumbPath)) {
    errors.push(`${label} ${item.id}: thumb file missing: ${item.thumb}`)
  }
  const thumbGitPath = `webapp/public/${item.thumb}`.replaceAll('\\', '/')
  if (!tracked.has(thumbGitPath)) {
    errors.push(`${label} ${item.id}: thumb file is not tracked: ${thumbGitPath}`)
  }
}

for (const item of shots) {
  validateFacets(item, 'shot')
  validateThumb(item, 'shot')
}
for (const item of sets) {
  validateFacets(item, 'frame')
  validateThumb(item, 'frame')
}

for (const [setId, meta] of Object.entries(setsMeta.sets || {})) {
  const extraIds = new Set((meta.extraFrames || []).map((f) => f.id).filter(Boolean))
  for (const frameId of Object.keys(meta.frameOrder || {})) {
    if (!frameIds.has(frameId) && !extraIds.has(frameId)) {
      errors.push(`sets_meta ${setId}: frameOrder references missing frame ${frameId}`)
    }
  }
  for (const extra of meta.extraFrames || []) {
    validateThumb(extra, `sets_meta extraFrame ${setId}`)
  }
}

for (const comp of comps.items || []) {
  const seqs = new Set()
  for (const member of comp.members || []) {
    if (seqs.has(member.seq)) errors.push(`composition ${comp.id}: duplicate seq ${member.seq}`)
    seqs.add(member.seq)

    if (member.kind === 'shot' && !shotIds.has(member.ref)) {
      errors.push(`composition ${comp.id}: missing shot ref ${member.ref}`)
    } else if (member.kind === 'frame' && !frameIds.has(member.ref)) {
      errors.push(`composition ${comp.id}: missing frame ref ${member.ref}`)
    } else if (member.kind === 'standard' && !compIds.has(member.ref)) {
      errors.push(`composition ${comp.id}: missing standard ref ${member.ref}`)
    } else if (!['shot', 'frame', 'standard'].includes(member.kind)) {
      errors.push(`composition ${comp.id}: unknown member kind ${member.kind}`)
    }
  }
}

for (const rel of tracked) {
  if (rel.startsWith('webapp/public/images/lazydog/')) {
    errors.push(`large LazyDog preview image is tracked: ${rel}`)
  }
}

console.log('LazyDog shots:', shots.length)
console.log('LazyDog frames:', sets.length)
console.log('Compositions:', comps.items?.length || 0)
console.log('Tracked thumb files:', [...tracked].filter((p) => p.startsWith('webapp/public/lazydog-thumbs/')).length)

if (warnings.length) {
  console.log('\nWarnings:')
  for (const warning of warnings) console.log(`  - ${warning}`)
}

if (errors.length) {
  console.error('\nErrors:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log('\nPublic upload validation passed.')
