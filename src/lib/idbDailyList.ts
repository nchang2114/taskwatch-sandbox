/**
 * Daily List IDB layer — reference entries pointing to existing tasks.
 *
 * Each entry is a lightweight reference (taskId) to a TaskRecord that lives
 * in its original goal/bucket. Completion is handled globally on the
 * TaskRecord itself, not on the daily list entry.
 */

import { openDB, STORE } from './idbStore'

// ── Constants ───────────────────────────────────────────────────────────────

export const DAILY_LIST_ID = '__daily__'

// ── Record type ─────────────────────────────────────────────────────────────

export type DailyListEntryRecord = {
  id: string
  userId: string
  dailyListId: string
  taskId: string
  sortIndex: number
  addedAt: string
}

// ── In-memory cache ─────────────────────────────────────────────────────────

const cache = new Map<string, DailyListEntryRecord[]>()
const hydratedUsers = new Set<string>()

// ── IDB helpers ─────────────────────────────────────────────────────────────

async function queryByUserId(userId: string): Promise<DailyListEntryRecord[]> {
  const db = await openDB()
  return new Promise<DailyListEntryRecord[]>((resolve, reject) => {
    const tx = db.transaction(STORE.dailyListEntries, 'readonly')
    const index = tx.objectStore(STORE.dailyListEntries).index('userId')
    const request = index.getAll(userId)
    request.onsuccess = () => resolve(request.result as DailyListEntryRecord[])
    request.onerror = () => reject(request.error)
  })
}

async function deleteByUserId(userId: string): Promise<void> {
  const db = await openDB()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE.dailyListEntries, 'readwrite')
    const store = tx.objectStore(STORE.dailyListEntries)
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

async function replaceUserRecords(userId: string, records: DailyListEntryRecord[]): Promise<void> {
  const db = await openDB()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE.dailyListEntries, 'readwrite')
    const store = tx.objectStore(STORE.dailyListEntries)
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

/** Read daily list entries for a user (sync from cache). */
export function readDailyListEntries(userId: string): DailyListEntryRecord[] {
  return (cache.get(userId) ?? []).slice().sort((a, b) => a.sortIndex - b.sortIndex)
}

/** Write daily list entries for a user (sync to cache + async to IDB). */
export function writeDailyListEntries(userId: string, entries: DailyListEntryRecord[]): void {
  cache.set(userId, entries)
  replaceUserRecords(userId, entries).catch(() => {})
}

/** Clear all daily list data for a user. */
export function clearDailyListEntries(userId: string): void {
  cache.delete(userId)
  deleteByUserId(userId).catch(() => {})
}

/** Check if a task is already in the daily list. */
export function isDailyListTask(userId: string, taskId: string): boolean {
  const entries = cache.get(userId)
  if (!entries) return false
  return entries.some((e) => e.taskId === taskId)
}

// ── Hydrate ─────────────────────────────────────────────────────────────────

export async function hydrateDailyList(userId: string): Promise<void> {
  if (hydratedUsers.has(userId)) return

  try {
    const idbRecords = await queryByUserId(userId)
    cache.set(userId, idbRecords)
    hydratedUsers.add(userId)
  } catch {
    cache.set(userId, [])
    hydratedUsers.add(userId)
  }
}
