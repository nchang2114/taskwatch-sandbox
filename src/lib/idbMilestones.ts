/**
 * Milestones IDB layer — individual records with in-memory cache.
 *
 * Fixes the scoping bug: milestones were previously stored in a global
 * (non-user-scoped) localStorage key. Now each record has a userId field.
 *
 * Current localStorage shape: Record<goalId, Milestone[]> (one global blob)
 * New IDB shape: individual MilestoneRecord per milestone, indexed by userId + goalId
 */

import { openDB, STORE } from './idbStore'
import { storage, type Milestone } from './storage'

// ── Record type ─────────────────────────────────────────────────────────────

export type MilestoneRecord = {
  id: string
  userId: string
  goalId: string
  name: string
  targetDate: string
  completed: boolean
  role: 'start' | 'end' | 'normal'
  hidden?: boolean
}

// ── In-memory cache ─────────────────────────────────────────────────────────
// Keyed by `${userId}::${goalId}` for efficient per-goal lookups

const cache = new Map<string, MilestoneRecord[]>()
const hydratedUsers = new Set<string>()

const cacheKey = (userId: string, goalId: string) => `${userId}::${goalId}`

// ── IDB helpers ─────────────────────────────────────────────────────────────

async function queryByUserId(userId: string): Promise<MilestoneRecord[]> {
  const db = await openDB()
  return new Promise<MilestoneRecord[]>((resolve, reject) => {
    const tx = db.transaction(STORE.milestones, 'readonly')
    const index = tx.objectStore(STORE.milestones).index('userId')
    const request = index.getAll(userId)
    request.onsuccess = () => resolve(request.result as MilestoneRecord[])
    request.onerror = () => reject(request.error)
  })
}

async function deleteByUserId(userId: string): Promise<void> {
  const db = await openDB()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE.milestones, 'readwrite')
    const store = tx.objectStore(STORE.milestones)
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

async function replaceForGoal(userId: string, goalId: string, records: MilestoneRecord[]): Promise<void> {
  const db = await openDB()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE.milestones, 'readwrite')
    const store = tx.objectStore(STORE.milestones)
    // Delete existing milestones for this goal+user via goalId index + userId check
    const index = store.index('goalId')
    const cursorReq = index.openCursor(goalId)
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (cursor) {
        const rec = cursor.value as MilestoneRecord
        if (rec.userId === userId) {
          store.delete(cursor.primaryKey)
        }
        cursor.continue()
      } else {
        // All old records deleted — insert new ones
        records.forEach((r) => store.put(r))
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// ── Cache accessors ─────────────────────────────────────────────────────────

/** Read milestones for a specific goal (sync from cache). */
export function readMilestones(userId: string, goalId: string): Milestone[] {
  const key = cacheKey(userId, goalId)
  const records = cache.get(key)
  if (!records) return []
  return records.map(toMilestone)
}

/** Write milestones for a specific goal (sync to cache + async to IDB). */
export function writeMilestones(userId: string, goalId: string, milestones: Milestone[]): void {
  const records = milestones.map((m) => toRecord(userId, goalId, m))
  cache.set(cacheKey(userId, goalId), records)
  replaceForGoal(userId, goalId, records).catch(() => {})
}

/** Read all milestones for a user, grouped by goalId. */
export function readAllMilestones(userId: string): Record<string, Milestone[]> {
  const result: Record<string, Milestone[]> = {}
  const prefix = userId + '::'
  for (const [key, records] of cache.entries()) {
    if (key.startsWith(prefix)) {
      const goalId = key.slice(prefix.length)
      result[goalId] = records.map(toMilestone)
    }
  }
  return result
}

/** Clear all milestone data for a user. */
export function clearMilestonesCache(userId: string): void {
  // Remove all cache entries for this user
  for (const key of cache.keys()) {
    if (key.startsWith(userId + '::')) {
      cache.delete(key)
    }
  }
  deleteByUserId(userId).catch(() => {})
}

// ── Conversion helpers ──────────────────────────────────────────────────────

function toMilestone(r: MilestoneRecord): Milestone {
  const m: Milestone = {
    id: r.id,
    name: r.name,
    date: r.targetDate,
    completed: r.completed,
    role: r.role,
  }
  if (r.hidden !== undefined) m.hidden = r.hidden
  return m
}

function toRecord(userId: string, goalId: string, m: Milestone): MilestoneRecord {
  const r: MilestoneRecord = {
    id: m.id,
    userId,
    goalId,
    name: m.name,
    targetDate: m.date,
    completed: m.completed,
    role: m.role,
  }
  if (m.hidden !== undefined) r.hidden = m.hidden
  return r
}

// ── Hydrate ─────────────────────────────────────────────────────────────────

export async function hydrateMilestones(userId: string): Promise<void> {
  if (hydratedUsers.has(userId)) return

  try {
    // Try IDB first
    const idbRecords = await queryByUserId(userId)

    if (idbRecords.length > 0) {
      // Group by goalId and populate cache
      for (const rec of idbRecords) {
        const key = cacheKey(userId, rec.goalId)
        const list = cache.get(key) ?? []
        list.push(rec)
        cache.set(key, list)
      }
      hydratedUsers.add(userId)
      return
    }

    // IDB empty — try migrating from localStorage
    // Milestones were stored globally as Record<goalId, Milestone[]>
    const lsMap = storage.domain.milestones.get()
    if (lsMap && typeof lsMap === 'object') {
      const allRecords: MilestoneRecord[] = []
      for (const [goalId, milestones] of Object.entries(lsMap)) {
        if (!Array.isArray(milestones)) continue
        const records = milestones.map((m: Milestone) => toRecord(userId, goalId, m))
        cache.set(cacheKey(userId, goalId), records)
        allRecords.push(...records)
      }

      if (allRecords.length > 0) {
        // Persist to IDB
        const db = await openDB()
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE.milestones, 'readwrite')
          const store = tx.objectStore(STORE.milestones)
          allRecords.forEach((r) => store.put(r))
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        })
      }
    }

    hydratedUsers.add(userId)
  } catch {
    hydratedUsers.add(userId)
  }
}
