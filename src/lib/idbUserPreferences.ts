/**
 * User Preferences IDB layer — one record per user.
 *
 * Consolidates scattered localStorage preference keys into a single
 * IDB record. Also persists 5 settings that previously reset on reload
 * (use24HourTime, weekStartDay, defaultCalendarView, snapToInterval, showMilliseconds).
 *
 * Dev/internal keys (flags, reflectionUnlocked, debugStopwatch) stay in localStorage.
 */

import { openDB, STORE } from './idbStore'
import { storage } from './storage'

// ── Record type ─────────────────────────────────────────────────────────────

export type UserPreferencesRecord = {
  userId: string                                         // keyPath
  theme: 'light' | 'dark'
  timezone: string | null                                // IANA timezone or null (system default)
  use24HourTime: boolean
  weekStartDay: 0 | 1                                   // 0 = Sunday, 1 = Monday
  defaultCalendarView: 2 | 3 | 4 | 5 | 6 | 'week'
  snapToInterval: 0 | 5 | 10 | 15
  showMilliseconds: boolean
}

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_PREFERENCES: Omit<UserPreferencesRecord, 'userId'> = {
  theme: 'dark',
  timezone: null,
  use24HourTime: false,
  weekStartDay: 0,
  defaultCalendarView: 6,
  snapToInterval: 0,
  showMilliseconds: true,
}

// ── In-memory cache ─────────────────────────────────────────────────────────

const cache = new Map<string, UserPreferencesRecord>()
const hydratedUsers = new Set<string>()

// ── Cache accessors ─────────────────────────────────────────────────────────

/** Read preferences for a user (sync from cache). Returns defaults if not hydrated. */
export function readPreferences(userId: string): UserPreferencesRecord {
  return cache.get(userId) ?? { userId, ...DEFAULT_PREFERENCES }
}

/** Write full preferences record (sync to cache + async to IDB). */
export function writePreferences(userId: string, prefs: UserPreferencesRecord): void {
  cache.set(userId, prefs)
  persistToIdb(prefs).catch(() => {})
}

/** Update a single preference field. */
export function updatePreference<K extends keyof Omit<UserPreferencesRecord, 'userId'>>(
  userId: string,
  key: K,
  value: UserPreferencesRecord[K],
): UserPreferencesRecord {
  const current = readPreferences(userId)
  const updated = { ...current, [key]: value }
  writePreferences(userId, updated)
  return updated
}

/** Clear preferences for a user. */
export function clearPreferencesCache(userId: string): void {
  cache.delete(userId)
  deleteFromIdb(userId).catch(() => {})
}

// ── IDB helpers ─────────────────────────────────────────────────────────────

async function persistToIdb(prefs: UserPreferencesRecord): Promise<void> {
  const db = await openDB()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE.userPreferences, 'readwrite')
    tx.objectStore(STORE.userPreferences).put(prefs)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function deleteFromIdb(userId: string): Promise<void> {
  const db = await openDB()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE.userPreferences, 'readwrite')
    tx.objectStore(STORE.userPreferences).delete(userId)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// ── Hydrate ─────────────────────────────────────────────────────────────────

export async function hydrateUserPreferences(userId: string): Promise<void> {
  if (hydratedUsers.has(userId)) return

  try {
    // Try IDB first
    const db = await openDB()
    const idbRecord = await new Promise<UserPreferencesRecord | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE.userPreferences, 'readonly')
      const request = tx.objectStore(STORE.userPreferences).get(userId)
      request.onsuccess = () => resolve(request.result as UserPreferencesRecord | undefined)
      request.onerror = () => reject(request.error)
    })

    if (idbRecord) {
      cache.set(userId, idbRecord)
      hydratedUsers.add(userId)
      return
    }

    // IDB empty — migrate from localStorage
    const theme = storage.preferences.theme.get()
    const timezone = storage.preferences.timezone.get()

    const prefs: UserPreferencesRecord = {
      userId,
      theme: theme === 'light' ? 'light' : 'dark',
      timezone: timezone ?? null,
      use24HourTime: DEFAULT_PREFERENCES.use24HourTime,
      weekStartDay: DEFAULT_PREFERENCES.weekStartDay,
      defaultCalendarView: DEFAULT_PREFERENCES.defaultCalendarView,
      snapToInterval: DEFAULT_PREFERENCES.snapToInterval,
      showMilliseconds: DEFAULT_PREFERENCES.showMilliseconds,
    }

    cache.set(userId, prefs)
    await persistToIdb(prefs)
    hydratedUsers.add(userId)
  } catch {
    hydratedUsers.add(userId)
  }
}
