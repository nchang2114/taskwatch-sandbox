/**
 * Centralized localStorage namespace layer.
 *
 * Every key the app persists is declared here. Other modules import accessors
 * from this file instead of calling localStorage directly, so:
 *  1. There's one source of truth for all stored keys & shapes.
 *  2. Swapping the backend later (e.g. IndexedDB) only requires changes here.
 *  3. JSON parse/stringify + error handling is done once.
 *
 * Cross-tab `storage` event listeners still need the raw key strings — use
 * the exported STORAGE_KEYS constant for that.
 */

// ── Imports for stored types ────────────────────────────────────────────────
// Types are imported purely for generic annotations. The accessor factories
// themselves are type-agnostic.
import type { GoalSnapshot } from './goalsSync'
import type { HistoryRecord } from './sessionHistory'
import type { QuickItem } from './quickList'
import type { LifeRoutineConfig } from './lifeRoutines'
import type { RepeatingSessionRule } from './repeatingSessions'
import type { RepeatingException } from './repeatingExceptions'
import type { TaskDetailSnapshot } from './taskDetailsSnapshot'
import type { MigrationLock } from './authStorage'

// ── Key constants ───────────────────────────────────────────────────────────
// Every localStorage key used by the app. Grouped by namespace.

const KEYS = {
  // preferences
  theme: 'nc-taskwatch-theme',
  timezone: 'taskwatch_app_timezone',
  quickListExpanded: 'nc-taskwatch-quick-list-expanded-v1',
  flags: 'nc-taskwatch-flags',
  reflectionUnlocked: 'taskwatch-reflection-unlocked',
  debugStopwatch: 'nc-debug-stopwatch',

  // auth
  authSession: 'nc-taskwatch-supabase-session-v1',
  authProfile: 'nc-taskwatch-auth-profile',
  lastAuthUserId: 'nc-taskwatch-last-auth-user-id',

  // domain (user-scoped keys use ::userId suffix)
  goalsSnapshot: 'nc-taskwatch-goals-snapshot',
  sessionHistory: 'nc-taskwatch-session-history',
  quickList: 'nc-taskwatch-quicklist',
  lifeRoutines: 'nc-taskwatch-life-routines',
  repeatingRules: 'nc-taskwatch-repeating-rules',
  repeatingExceptions: 'nc-taskwatch-repeating-exceptions',
  repeatingActivationMap: 'nc-taskwatch-repeating-activation-map',
  repeatingEndMap: 'nc-taskwatch-repeating-end-map',
  milestones: 'nc-taskwatch-milestones-state-v1',
  taskDetails: 'nc-taskwatch-task-details-v1',

  // focus
  currentTask: 'nc-taskwatch-current-task',
  currentTaskSource: 'nc-taskwatch-current-task-source',
  currentSession: 'nc-taskwatch-current-session',
  stopwatch: 'nc-taskwatch-stopwatch-v1',
  notebook: 'nc-taskwatch-notebook',
  snapbackCustomTriggers: 'nc-taskwatch-snapback-custom-triggers',
  overviewTriggers: 'nc-taskwatch-overview-triggers',

  // guest
  localSnapbackTriggers: 'nc-taskwatch-local-snapback-triggers',
  localSnapPlans: 'nc-taskwatch-local-snap-plans',
  localSnapAliases: 'nc-taskwatch-local-snap-aliases',

  // locks / cross-tab coordination
  alignLock: 'nc-taskwatch-align-lock',
  alignComplete: 'nc-taskwatch-align-complete',
  bootstrapLock: 'nc-taskwatch-bootstrap-lock',
  lifeRoutinesSyncLock: 'nc-taskwatch-life-routines:sync-lock',
  migrationLock: 'nc-taskwatch-migration-lock',
  lastFullSync: 'nc-taskwatch-last-full-sync',
  snapbackSyncSignal: 'nc-taskwatch-snapback-sync-signal',

  // bootstrap snapshots (transient)
  snapshotGoals: 'nc-taskwatch-bootstrap-snapshot::goals',
  snapshotHistory: 'nc-taskwatch-bootstrap-snapshot::history',
  snapshotLifeRoutines: 'nc-taskwatch-bootstrap-snapshot::life-routines',
  snapshotQuickList: 'nc-taskwatch-bootstrap-snapshot::quick-list',
  snapshotRepeating: 'nc-taskwatch-bootstrap-snapshot::repeating',

  // ownership tracking (to be removed in IndexedDB phase)
  goalsUser: 'nc-taskwatch-goals-user',
  historyUser: 'nc-taskwatch-session-history-user',
  quickListUser: 'nc-taskwatch-quicklist-user',
  lifeRoutinesUser: 'nc-taskwatch-life-routines-user',
  repeatingUser: 'nc-taskwatch-repeating-user',
} as const

/**
 * All key strings, exported for cross-tab `storage` event matching.
 *
 * Usage:
 *   window.addEventListener('storage', (e) => {
 *     if (e.key?.startsWith(STORAGE_KEYS.goalsSnapshot + '::')) { ... }
 *   })
 */
export const STORAGE_KEYS = KEYS

// ── Helpers ─────────────────────────────────────────────────────────────────

const getLS = (): Storage | null => {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

// ── Accessor factories ──────────────────────────────────────────────────────

type Accessor<T> = {
  get: () => T | null
  set: (value: T) => void
  remove: () => void
  /** The raw localStorage key string */
  key: string
}

type ScopedAccessor<T> = {
  get: (userId: string) => T | null
  set: (userId: string, value: T) => void
  remove: (userId: string) => void
  /** The base key prefix (before ::userId) */
  key: string
}

/**
 * Create a typed accessor for a JSON-serialized value.
 */
function createAccessor<T>(key: string): Accessor<T> {
  return {
    key,
    get() {
      const ls = getLS()
      if (!ls) return null
      try {
        const raw = ls.getItem(key)
        if (raw === null) return null
        return JSON.parse(raw) as T
      } catch {
        return null
      }
    },
    set(value: T) {
      const ls = getLS()
      if (!ls) return
      try {
        ls.setItem(key, JSON.stringify(value))
      } catch {}
    },
    remove() {
      const ls = getLS()
      if (!ls) return
      try {
        ls.removeItem(key)
      } catch {}
    },
  }
}

/**
 * Create a typed accessor for a plain string value (no JSON wrapping).
 */
function createStringAccessor(key: string): Accessor<string> {
  return {
    key,
    get() {
      const ls = getLS()
      if (!ls) return null
      try {
        return ls.getItem(key)
      } catch {
        return null
      }
    },
    set(value: string) {
      const ls = getLS()
      if (!ls) return
      try {
        ls.setItem(key, value)
      } catch {}
    },
    remove() {
      const ls = getLS()
      if (!ls) return
      try {
        ls.removeItem(key)
      } catch {}
    },
  }
}

/**
 * Create a user-scoped accessor. The key pattern is `baseKey::userId`.
 * Values are JSON-serialized.
 */
function createScopedAccessor<T>(baseKey: string): ScopedAccessor<T> {
  return {
    key: baseKey,
    get(userId: string) {
      const ls = getLS()
      if (!ls) return null
      try {
        const raw = ls.getItem(`${baseKey}::${userId}`)
        if (raw === null) return null
        return JSON.parse(raw) as T
      } catch {
        return null
      }
    },
    set(userId: string, value: T) {
      const ls = getLS()
      if (!ls) return
      try {
        ls.setItem(`${baseKey}::${userId}`, JSON.stringify(value))
      } catch {}
    },
    remove(userId: string) {
      const ls = getLS()
      if (!ls) return
      try {
        ls.removeItem(`${baseKey}::${userId}`)
      } catch {}
    },
  }
}

// ── Feature flags type (co-located since it's only used for storage) ────────

export type FeatureFlags = {
  repeatOriginal?: boolean
  historyNotes?: boolean
  historySubtasks?: boolean
  historyFutureSession?: boolean
}

// ── Milestone type (not defined elsewhere) ──────────────────────────────────

export type Milestone = {
  id: string
  name: string
  date: string
  completed: boolean
  role: string
  hidden?: boolean
}

// ── UserProfile type (was inlined in App.tsx) ───────────────────────────────

export type UserProfile = {
  name: string
  email: string
  avatarUrl?: string
  appTimezone?: string | null
}

// ── Build the storage object ────────────────────────────────────────────────

export const storage = {
  preferences: {
    theme: createStringAccessor(KEYS.theme),
    timezone: createStringAccessor(KEYS.timezone),
    quickListExpanded: createStringAccessor(KEYS.quickListExpanded),
    flags: createAccessor<FeatureFlags>(KEYS.flags),
    reflectionUnlocked: createStringAccessor(KEYS.reflectionUnlocked),
    debugStopwatch: createStringAccessor(KEYS.debugStopwatch),
  },

  auth: {
    session: createStringAccessor(KEYS.authSession),
    profile: createAccessor<UserProfile>(KEYS.authProfile),
    lastUserId: createStringAccessor(KEYS.lastAuthUserId),
  },

  domain: {
    goals: createScopedAccessor<GoalSnapshot[]>(KEYS.goalsSnapshot),
    history: createScopedAccessor<HistoryRecord[]>(KEYS.sessionHistory),
    quickList: createScopedAccessor<QuickItem[]>(KEYS.quickList),
    lifeRoutines: createScopedAccessor<LifeRoutineConfig[]>(KEYS.lifeRoutines),
    repeatingRules: createScopedAccessor<RepeatingSessionRule[]>(KEYS.repeatingRules),
    repeatingExceptions: createAccessor<RepeatingException[]>(KEYS.repeatingExceptions),
    repeatingActivationMap: createAccessor<Record<string, number>>(KEYS.repeatingActivationMap),
    repeatingEndMap: createAccessor<Record<string, number>>(KEYS.repeatingEndMap),
    milestones: createAccessor<Record<string, Milestone[]>>(KEYS.milestones),
    taskDetails: createAccessor<Record<string, TaskDetailSnapshot>>(KEYS.taskDetails),
  },

  focus: {
    currentTask: createStringAccessor(KEYS.currentTask),
    currentTaskSource: createAccessor<{ goalId?: string; bucketId?: string; taskId?: string; source?: string }>(KEYS.currentTaskSource),
    currentSession: createAccessor<Record<string, unknown>>(KEYS.currentSession),
    stopwatch: createAccessor<Record<string, unknown>>(KEYS.stopwatch),
    notebook: createAccessor<Record<string, unknown>>(KEYS.notebook),
    snapbackCustomTriggers: createAccessor<Array<{ id: string; label: string }>>(KEYS.snapbackCustomTriggers),
    overviewTriggers: createAccessor<string[]>(KEYS.overviewTriggers),
  },

  guest: {
    snapbackTriggers: createAccessor<Array<{ id: string; label: string; cue: string; deconstruction: string; plan: string }>>(KEYS.localSnapbackTriggers),
    snapPlans: createAccessor<Record<string, { cue: string; deconstruction: string; plan: string }>>(KEYS.localSnapPlans),
    snapAliases: { key: KEYS.localSnapAliases, remove() { const ls = getLS(); if (ls) try { ls.removeItem(KEYS.localSnapAliases) } catch {} } },
  },

  locks: {
    alignLock: createAccessor<{ userId: string; expiresAt: number }>(KEYS.alignLock),
    alignComplete: createAccessor<{ userId: string; timestamp: number }>(KEYS.alignComplete),
    bootstrapLock: createScopedAccessor<{ expiresAt: number }>(KEYS.bootstrapLock),
    lifeRoutinesSyncLock: createScopedAccessor<{ expiresAt: number }>(KEYS.lifeRoutinesSyncLock),
    migrationLock: createAccessor<MigrationLock>(KEYS.migrationLock),
    lastFullSync: createStringAccessor(KEYS.lastFullSync),
    snapbackSyncSignal: createAccessor<{ type: string; timestamp: number }>(KEYS.snapbackSyncSignal),
  },

  bootstrap: {
    snapshotGoals: createAccessor<GoalSnapshot[]>(KEYS.snapshotGoals),
    snapshotHistory: createAccessor<HistoryRecord[]>(KEYS.snapshotHistory),
    snapshotLifeRoutines: createAccessor<LifeRoutineConfig[]>(KEYS.snapshotLifeRoutines),
    snapshotQuickList: createAccessor<QuickItem[]>(KEYS.snapshotQuickList),
    snapshotRepeating: createAccessor<RepeatingSessionRule[]>(KEYS.snapshotRepeating),
  },

  ownership: {
    goalsUser: createStringAccessor(KEYS.goalsUser),
    historyUser: createStringAccessor(KEYS.historyUser),
    quickListUser: createStringAccessor(KEYS.quickListUser),
    lifeRoutinesUser: createStringAccessor(KEYS.lifeRoutinesUser),
    repeatingUser: createStringAccessor(KEYS.repeatingUser),
  },

  // ── Utilities ───────────────────────────────────────────────────────────

  /**
   * Clear ALL localStorage (full wipe, e.g. on sign-out).
   */
  clearAll() {
    const ls = getLS()
    if (!ls) return
    try {
      ls.clear()
    } catch {}
  },

  /**
   * Clear app data from localStorage, preserving auth keys.
   * Used when switching users or resetting app state.
   */
  clearAppData() {
    const ls = getLS()
    if (!ls) return
    try {
      const keysToRemove: string[] = []
      for (let i = 0; i < ls.length; i++) {
        const key = ls.key(i)
        if (
          key &&
          key.startsWith('nc-taskwatch-') &&
          key !== KEYS.authSession &&
          key !== KEYS.lastAuthUserId
        ) {
          keysToRemove.push(key)
        }
      }
      keysToRemove.forEach((key) => ls.removeItem(key))
    } catch {}
  },
} as const
