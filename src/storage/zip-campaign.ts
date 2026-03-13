import { zipSync, unzipSync, strFromU8, strToU8 } from 'fflate'

import type { GameState, GameMap, Faction, Unit } from '@/types'
import { getSaveDirectory, readJSONFile, writeJSONFile, initializeSaveDirectory, generateSaveId } from './opfs'
import type { SaveManifest } from './game-storage'

const MAX_ZIP_ENTRIES = 200
const MAX_TOTAL_UNCOMPRESSED_BYTES = 20 * 1024 * 1024
const MAX_SINGLE_FILE_BYTES = 2 * 1024 * 1024

const CAMPAIGN_REQUIRED_FILES = [
  'campaign/manifest.json',
  'campaign/map.json',
  'campaign/factions.json',
  'campaign/units.json',
  'campaign/commanders.json',
  'campaign/rules.json',
  'campaign/victory.json',
] as const

interface CampaignManifestSchema {
  id: string
  name: string
  version: string
  schemaVersion: number
}

export interface CampaignPayload {
  manifest: CampaignManifestSchema
  map: GameMap
  factions: Faction[]
  units: Unit[]
}

export interface ImportCampaignResult {
  saveId: string
  manifest: CampaignManifestSchema
}

export interface ImportSaveResult {
  saveId: string
  manifest: SaveManifest
}

export async function exportSaveAsZip(saveId: string): Promise<Uint8Array> {
  const saveDir = await getSaveDirectory(saveId)
  if (!saveDir) {
    throw new Error(`存档不存在: ${saveId}`)
  }

  const worldDir = await saveDir.getDirectoryHandle('world', { create: false })
  const manifest = await readJSONFile<SaveManifest>(saveDir, 'manifest.json')
  const worldState = await readJSONFile<GameState>(worldDir, 'world-state.json')

  if (!manifest || !worldState) {
    throw new Error('导出失败：存档数据不完整')
  }

  const files = {
    'campaign/manifest.json': strToU8(JSON.stringify({
      id: manifest.saveId,
      name: manifest.name,
      version: manifest.version,
      schemaVersion: 1,
    })),
    'campaign/map.json': strToU8(JSON.stringify(worldState.worldState.map)),
    'campaign/factions.json': strToU8(JSON.stringify(worldState.worldState.factions)),
    'campaign/units.json': strToU8(JSON.stringify(worldState.worldState.units)),
    'campaign/commanders.json': strToU8(JSON.stringify([])),
    'campaign/rules.json': strToU8(JSON.stringify({ version: 1 })),
    'campaign/victory.json': strToU8(JSON.stringify({ objective: 'sandbox' })),
    'save/world-state.json': strToU8(JSON.stringify(worldState)),
    'save/save-manifest.json': strToU8(JSON.stringify(manifest)),
  }

  return zipSync(files, { level: 6 })
}

export async function importCampaignZip(saveId: string, zipData: Uint8Array): Promise<ImportCampaignResult> {
  const entries = unzipSync(zipData)
  validateZipEntries(entries)

  for (const required of CAMPAIGN_REQUIRED_FILES) {
    if (!entries[required]) {
      throw new Error(`战役包缺少必要文件: ${required}`)
    }
  }

  const manifest = parseCampaignManifest(entries['campaign/manifest.json'])

  const map = parseGameMap(entries['campaign/map.json'])
  const factions = parseFactions(entries['campaign/factions.json'])
  const units = parseUnits(entries['campaign/units.json'])

  const saveDir = await getSaveDirectory(saveId)
  if (!saveDir) {
    throw new Error(`存档不存在: ${saveId}`)
  }

  const worldDir = await saveDir.getDirectoryHandle('world', { create: false })
  const current = await readJSONFile<GameState>(worldDir, 'world-state.json')
  if (!current) {
    throw new Error('导入失败：缺少当前 world-state.json')
  }

  const nextState: GameState = {
    ...current,
    worldState: {
      ...current.worldState,
      map,
      factions,
      units,
    },
    updatedAt: new Date().toISOString(),
  }

  await writeJSONFile(worldDir, 'world-state.json', nextState)

  return {
    saveId,
    manifest,
  }
}

export function buildCampaignZip(payload: CampaignPayload): Uint8Array {
  const files = {
    'campaign/manifest.json': strToU8(JSON.stringify(payload.manifest)),
    'campaign/map.json': strToU8(JSON.stringify(payload.map)),
    'campaign/factions.json': strToU8(JSON.stringify(payload.factions)),
    'campaign/units.json': strToU8(JSON.stringify(payload.units)),
    'campaign/commanders.json': strToU8(JSON.stringify([])),
    'campaign/rules.json': strToU8(JSON.stringify({ version: 1 })),
    'campaign/victory.json': strToU8(JSON.stringify({ objective: 'sandbox' })),
  }

  return zipSync(files, { level: 6 })
}

export function loadCampaignZip(zipData: Uint8Array): CampaignPayload {
  const entries = unzipSync(zipData)
  validateZipEntries(entries)

  for (const required of CAMPAIGN_REQUIRED_FILES) {
    if (!entries[required]) {
      throw new Error(`战役包缺少必要文件: ${required}`)
    }
  }

  return {
    manifest: parseCampaignManifest(entries['campaign/manifest.json']),
    map: parseGameMap(entries['campaign/map.json']),
    factions: parseFactions(entries['campaign/factions.json']),
    units: parseUnits(entries['campaign/units.json']),
  }
}

export async function importSaveZip(zipData: Uint8Array): Promise<ImportSaveResult> {
  const entries = unzipSync(zipData)
  validateZipEntries(entries)

  const worldPayload = entries['save/world-state.json']
  const manifestPayload = entries['save/save-manifest.json']

  if (!worldPayload || !manifestPayload) {
    throw new Error('存档包缺少 save/world-state.json 或 save/save-manifest.json')
  }

  const parsedWorld = parseJson(worldPayload)
  if (!parsedWorld || typeof parsedWorld !== 'object') {
    throw new Error('world-state.json 格式非法')
  }

  const parsedManifest = parseJson(manifestPayload)
  if (!parsedManifest || typeof parsedManifest !== 'object') {
    throw new Error('save-manifest.json 格式非法')
  }

  const now = new Date().toISOString()
  const newSaveId = generateSaveId()
  const nextState: GameState = {
    ...(parsedWorld as GameState),
    saveId: newSaveId,
    updatedAt: now,
  }

  const nextManifest: SaveManifest = {
    ...(parsedManifest as SaveManifest),
    saveId: newSaveId,
    updatedAt: now,
    createdAt: now,
  }

  const saveDir = await initializeSaveDirectory(newSaveId)
  const worldDir = await saveDir.getDirectoryHandle('world', { create: false })
  await writeJSONFile(worldDir, 'world-state.json', nextState)
  await writeJSONFile(saveDir, 'manifest.json', nextManifest)

  return {
    saveId: newSaveId,
    manifest: nextManifest,
  }
}

function parseJson(payload: Uint8Array): unknown {
  return JSON.parse(strFromU8(payload))
}

function parseGameMap(payload: Uint8Array): GameMap {
  const parsed = parseJson(payload)
  if (!isGameMap(parsed)) {
    throw new Error('map.json 格式非法')
  }
  return parsed
}

function parseFactions(payload: Uint8Array): Faction[] {
  const parsed = parseJson(payload)
  if (!Array.isArray(parsed) || !parsed.every(isFaction)) {
    throw new Error('factions.json 格式非法')
  }
  return parsed
}

function parseUnits(payload: Uint8Array): Unit[] {
  const parsed = parseJson(payload)
  if (!Array.isArray(parsed) || !parsed.every(isUnit)) {
    throw new Error('units.json 格式非法')
  }
  return parsed
}

function parseCampaignManifest(payload: Uint8Array): CampaignManifestSchema {
  const parsed = parseJson(payload)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('manifest.json 非法')
  }

  const candidate = parsed as Record<string, unknown>
  const manifest: CampaignManifestSchema = {
    id: typeof candidate.id === 'string' ? candidate.id : '',
    name: typeof candidate.name === 'string' ? candidate.name : '',
    version: typeof candidate.version === 'string' ? candidate.version : '',
    schemaVersion: typeof candidate.schemaVersion === 'number' ? candidate.schemaVersion : 0,
  }

  if (!manifest.id || !manifest.name || !manifest.version || manifest.schemaVersion <= 0) {
    throw new Error('manifest.json 缺少必要字段')
  }

  return manifest
}

function validateZipEntries(entries: Record<string, Uint8Array>): void {
  const names = Object.keys(entries)
  if (names.length > MAX_ZIP_ENTRIES) {
    throw new Error(`ZIP 条目数超限: ${names.length}`)
  }

  let total = 0
  for (const name of names) {
    const safe = normalizeZipPath(name)
    if (!safe.startsWith('campaign/') && !safe.startsWith('save/')) {
      throw new Error(`非法 ZIP 路径: ${name}`)
    }

    const content = entries[name]
    if (!content) {
      continue
    }

    if (content.byteLength > MAX_SINGLE_FILE_BYTES) {
      throw new Error(`ZIP 单文件超限: ${name}`)
    }

    total += content.byteLength
    if (total > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error('ZIP 解包总大小超限')
    }
  }
}

function isGameMap(value: unknown): value is GameMap {
  if (!value || typeof value !== 'object') {
    return false
  }

  const map = value as Record<string, unknown>
  return (
    typeof map.width === 'number' &&
    typeof map.height === 'number' &&
    Array.isArray(map.cells)
  )
}

function isFaction(value: unknown): value is Faction {
  if (!value || typeof value !== 'object') {
    return false
  }

  const faction = value as Record<string, unknown>
  return (
    typeof faction.id === 'string' &&
    typeof faction.name === 'string' &&
    typeof faction.type === 'string' &&
    typeof faction.trust === 'number' &&
    typeof faction.color === 'string'
  )
}

function isUnit(value: unknown): value is Unit {
  if (!value || typeof value !== 'object') {
    return false
  }

  const unit = value as Record<string, unknown>
  return (
    typeof unit.id === 'string' &&
    typeof unit.name === 'string' &&
    typeof unit.factionId === 'string'
  )
}

function normalizeZipPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '')
  const segments = normalized
    .split('/')
    .filter(segment => segment.length > 0 && segment !== '.')

  if (segments.some(segment => segment === '..')) {
    throw new Error(`检测到路径穿越: ${path}`)
  }

  return segments.join('/')
}
