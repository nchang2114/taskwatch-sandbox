/**
 * Life Routines IDB layer — individual records with in-memory cache.
 *
 * Migrates from localStorage scoped accessor (LifeRoutineConfig[] per userId)
 * to individual IDB records with userId index.
 */

import { openDB, STORE } from './idbStore'
import { storage } from './storage'
import type { LifeRoutineConfig } from './lifeRoutines'
import type { SurfaceStyle } from './surfaceStyles'

// ── Record type ─────────────────────────────────────────────────────────────

export type LifeRoutineRecord = {
  id: string
  userId: string
  bucketId: string
  title: string
  blurb: string
  surfaceStyle: SurfaceStyle
  surfaceColor?: string | null
  sortIndex: number
  createdAt?: string
  updatedAt?: string
}

// ── In-memory cache ─────────────────────────────────────────────────────────

const cache = new Map<string, LifeRoutineRecord[]>()
const hydratedUsers = new Set<string>()

// ── IDB helpers ─────────────────────────────────────────────────────────────

async function queryByUserId(userId: string): Promise<LifeRoutineRecord[]> {
  const db = await openDB()
  return new Promise<LifeRoutineRecord[]>((resolve, reject) => {
    const tx = db.transaction(STORE.lifeRoutines, 'readonly')
    const index = tx.objectStore(STORE.lifeRoutines).index('userId')
    const request = index.getAll(userId)
    request.onsuccess = () => resolve(request.result as LifeRoutineRecord[])
    request.onerror = () => reject(request.error)
  })
}

async function deleteByUserId(userId: string): Promise<void> {
  const db = await openDB()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE.lifeRoutines, 'readwrite')
    const store = tx.objectStore(STORE.lifeRoutines)
    const index = store.index('userId')
    const request = index.openKeyCursor(userId)
    request.onsuccess = () => {
      const cursor = request.result
      if (cursor) {
        store.delete(cursor.primaryKey)
        cursor.continue()
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function replaceUserRecords(userId: string, records: LifeRoutineRecord[]): Promise<void> {
  const db = await openDB()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE.lifeRoutines, 'readwrite')
    const store = tx.objectStore(STORE.lifeRoutines)
    const index = store.index('userId')
    const cursorReq = index.openKeyCursor(userId)
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (cursor) {
        store.delete(cursor.primaryKey)
        cursor.continue()
      } else {
        records.forEach((r) => store.put(r))
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// ── Cache accessors ─────────────────────────────────────────────────────────

/** Read life routines for a user (sync from cache). */
export function readLifeRoutinesFromCache(userId: string): LifeRoutineConfig[] {
  const records = cache.get(userId)
  if (!records) return []
  return records
    .slice()
    .sort((a, b) => a.sortIndex - b.sortIndex)
    .map(toConfig)
}

/** Write life routines for a user (sync to cache + async to IDB). */
export function writeLifeRoutinesToCache(userId: string, routines: LifeRoutineConfig[]): void {
  const records = routines.map((r) => toRecord(userId, r))
  cache.set(userId, records)
  replaceUserRecords(userId, records).catch(() => {})
}

/** Clear all life routine data for a user. */
export function clearLifeRoutinesCache(userId: string): void {
  cache.delete(userId)
  deleteByUserId(userId).catch(() => {})
}

// ── Conversion helpers ──────────────────────────────────────────────────────

function toConfig(r: LifeRoutineRecord): LifeRoutineConfig {
  return {
    id: r.id,
    bucketId: r.bucketId,
    title: r.title,
    blurb: r.blurb,
    surfaceStyle: r.surfaceStyle,
    surfaceColor: r.surfaceColor,
    sortIndex: r.sortIndex,
  }
}

function toRecord(userId: string, c: LifeRoutineConfig): LifeRoutineRecord {
  return {
    id: c.id,
    userId,
    bucketId: c.bucketId,
    title: c.title,
    blurb: c.blurb,
    surfaceStyle: c.surfaceStyle,
    surfaceColor: c.surfaceColor,
    sortIndex: c.sortIndex,
  }
}

// ── Hydrate ─────────────────────────────────────────────────────────────────

export async function hydrateLifeRoutines(userId: string): Promise<void> {
  if (hydratedUsers.has(userId)) return

  try {
    const idbRecords = await queryByUserId(userId)

    if (idbRecords.length > 0) {
      cache.set(userId, idbRecords)
      hydratedUsers.add(userId)
      return
    }

    // IDB empty — try migrating from localStorage
    const lsData = storage.domain.lifeRoutines.get(userId)
    if (Array.isArray(lsData) && lsData.length > 0) {
      const records = lsData.map((c: LifeRoutineConfig) => toRecord(userId, c))
      cache.set(userId, records)

      // Persist to IDB
      const db = await openDB()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE.lifeRoutines, 'readwrite')
        const store = tx.objectStore(STORE.lifeRoutines)
        records.forEach((r) => store.put(r))
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })

      hydratedUsers.add(userId)
      return
    }

    // No data — empty cache
    cache.set(userId, [])
    hydratedUsers.add(userId)
  } catch {
    hydratedUsers.add(userId)
  }
}
