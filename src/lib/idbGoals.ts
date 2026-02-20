/**
 * Goals IDB layer — normalized flat tables with in-memory cache.
 *
 * 4 IDB object stores (goals, buckets, tasks, subtasks), each with
 * individual records keyed by UUID. Records include a `userId` field
 * for per-user scoping via IDB indexes.
 *
 * In-memory cache provides sync reads. Writes go to cache immediately
 * and are flushed to IDB asynchronously (write-behind).
 *
 * The rest of the app still works with nested GoalSnapshot[] — the
 * flatten/assemble helpers handle the conversion at the boundary.
 */

import { openDB, STORE } from './idbStore'
import { storage } from './storage'
import type { GoalSnapshot, GoalBucketSnapshot, GoalTaskSnapshot, GoalTaskSubtaskSnapshot } from './goalsSync'
import { DEFAULT_SURFACE_STYLE, ensureSurfaceStyle, type SurfaceStyle } from './surfaceStyles'

// ── Record types (include userId for IDB indexing) ──────────────────────────

export type GoalRecord = {
  id: string
  userId: string
  name: string
  starred: boolean
  archived: boolean
  sortIndex: number
  goalColour?: string
  milestonesShown?: boolean
  createdAt?: string
  updatedAt?: string
}

export type BucketRecord = {
  id: string
  userId: string
  goalId: string
  name: string
  favorite: boolean
  archived: boolean
  sortIndex: number
  surfaceStyle?: SurfaceStyle
  createdAt?: string
  updatedAt?: string
}

export type TaskRecord = {
  id: string
  userId: string
  containerId: string
  text: string
  completed: boolean
  difficulty: 'none' | 'green' | 'yellow' | 'red'
  priority: boolean
  notes?: string
  sortIndex: number
  createdAt?: string
  updatedAt?: string
}

export type SubtaskRecord = {
  id: string
  userId: string
  taskId: string
  text: string
  completed: boolean
  sortIndex: number
  createdAt?: string
  updatedAt?: string
}

// ── In-memory cache ─────────────────────────────────────────────────────────

const cache = {
  goals: new Map<string, GoalRecord[]>(),
  buckets: new Map<string, BucketRecord[]>(),
  tasks: new Map<string, TaskRecord[]>(),
  subtasks: new Map<string, SubtaskRecord[]>(),
}

// Track which users have been hydrated
const hydratedUsers = new Set<string>()

// ── IDB helpers ─────────────────────────────────────────────────────────────

/** Read all records from an IDB store where userId index matches. */
async function queryByUserId<T>(storeName: string, userId: string): Promise<T[]> {
  const db = await openDB()
  return new Promise<T[]>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const store = tx.objectStore(storeName)
    const index = store.index('userId')
    const request = index.getAll(userId)
    request.onsuccess = () => resolve(request.result as T[])
    request.onerror = () => reject(request.error)
  })
}

/** Delete all records from an IDB store where userId index matches. */
async function deleteByUserId(storeName: string, userId: string): Promise<void> {
  const db = await openDB()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const store = tx.objectStore(storeName)
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

/** Replace all records for a user in a single store (delete old + insert new). */
async function replaceUserRecords<T>(storeName: string, userId: string, records: T[]): Promise<void> {
  const db = await openDB()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const store = tx.objectStore(storeName)
    // Delete existing records for this user
    const index = store.index('userId')
    const cursorReq = index.openKeyCursor(userId)
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (cursor) {
        store.delete(cursor.primaryKey)
        cursor.continue()
      } else {
        // All old records deleted — insert new ones
        records.forEach((record) => store.put(record))
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// ── Cache accessors (sync read, async write-behind) ─────────────────────────

export const goalsCache = {
  get(userId: string): GoalRecord[] {
    return cache.goals.get(userId) ?? []
  },
  set(userId: string, value: GoalRecord[]): void {
    cache.goals.set(userId, value)
    replaceUserRecords(STORE.goals, userId, value).catch(() => {})
  },
  remove(userId: string): void {
    cache.goals.delete(userId)
    deleteByUserId(STORE.goals, userId).catch(() => {})
  },
}

export const bucketsCache = {
  get(userId: string): BucketRecord[] {
    return cache.buckets.get(userId) ?? []
  },
  set(userId: string, value: BucketRecord[]): void {
    cache.buckets.set(userId, value)
    replaceUserRecords(STORE.buckets, userId, value).catch(() => {})
  },
  remove(userId: string): void {
    cache.buckets.delete(userId)
    deleteByUserId(STORE.buckets, userId).catch(() => {})
  },
}

export const tasksCache = {
  get(userId: string): TaskRecord[] {
    return cache.tasks.get(userId) ?? []
  },
  set(userId: string, value: TaskRecord[]): void {
    cache.tasks.set(userId, value)
    replaceUserRecords(STORE.tasks, userId, value).catch(() => {})
  },
  remove(userId: string): void {
    cache.tasks.delete(userId)
    deleteByUserId(STORE.tasks, userId).catch(() => {})
  },
}

export const subtasksCache = {
  get(userId: string): SubtaskRecord[] {
    return cache.subtasks.get(userId) ?? []
  },
  set(userId: string, value: SubtaskRecord[]): void {
    cache.subtasks.set(userId, value)
    replaceUserRecords(STORE.subtasks, userId, value).catch(() => {})
  },
  remove(userId: string): void {
    cache.subtasks.delete(userId)
    deleteByUserId(STORE.subtasks, userId).catch(() => {})
  },
}

// ── Flatten: GoalSnapshot[] → 4 flat record arrays ─────────────────────────

export function flattenSnapshot(userId: string, snapshot: GoalSnapshot[]): {
  goals: GoalRecord[]
  buckets: BucketRecord[]
  tasks: TaskRecord[]
  subtasks: SubtaskRecord[]
} {
  const goals: GoalRecord[] = []
  const buckets: BucketRecord[] = []
  const tasks: TaskRecord[] = []
  const subtasks: SubtaskRecord[] = []

  snapshot.forEach((goal, goalIdx) => {
    goals.push({
      id: goal.id,
      userId,
      name: goal.name,
      starred: goal.starred,
      archived: goal.archived,
      sortIndex: goalIdx,
      goalColour: goal.goalColour,
      milestonesShown: goal.milestonesShown,
    })

    goal.buckets.forEach((bucket, bucketIdx) => {
      buckets.push({
        id: bucket.id,
        userId,
        goalId: goal.id,
        name: bucket.name,
        favorite: bucket.favorite,
        archived: bucket.archived,
        sortIndex: bucketIdx,
        surfaceStyle: ensureSurfaceStyle(bucket.surfaceStyle, DEFAULT_SURFACE_STYLE),
      })

      bucket.tasks.forEach((task, taskIdx) => {
        tasks.push({
          id: task.id,
          userId,
          containerId: bucket.id,
          text: task.text,
          completed: task.completed,
          difficulty: task.difficulty,
          priority: task.priority,
          notes: task.notes,
          sortIndex: taskIdx,
          createdAt: task.createdAt,
        })

        task.subtasks.forEach((subtask, subtaskIdx) => {
          subtasks.push({
            id: subtask.id,
            userId,
            taskId: task.id,
            text: subtask.text,
            completed: subtask.completed,
            sortIndex: subtaskIdx,
          })
        })
      })
    })
  })

  return { goals, buckets, tasks, subtasks }
}

// ── Assemble: 4 flat caches → GoalSnapshot[] ───────────────────────────────

export function assembleSnapshot(userId: string): GoalSnapshot[] {
  const goalRecords = goalsCache.get(userId)
  const bucketRecords = bucketsCache.get(userId)
  const taskRecords = tasksCache.get(userId)
  const subtaskRecords = subtasksCache.get(userId)

  // Index subtasks by taskId
  const subtasksByTask = new Map<string, GoalTaskSubtaskSnapshot[]>()
  subtaskRecords
    .slice()
    .sort((a, b) => a.sortIndex - b.sortIndex)
    .forEach((s) => {
      const list = subtasksByTask.get(s.taskId) ?? []
      list.push({
        id: s.id,
        text: s.text,
        completed: s.completed,
        sortIndex: s.sortIndex,
      })
      subtasksByTask.set(s.taskId, list)
    })

  // Index tasks by containerId (bucket)
  const tasksByBucket = new Map<string, GoalTaskSnapshot[]>()
  taskRecords
    .slice()
    .sort((a, b) => a.sortIndex - b.sortIndex)
    .forEach((t) => {
      const list = tasksByBucket.get(t.containerId) ?? []
      const task: GoalTaskSnapshot = {
        id: t.id,
        text: t.text,
        completed: t.completed,
        priority: t.priority,
        difficulty: t.difficulty,
        subtasks: subtasksByTask.get(t.id) ?? [],
      }
      if (t.notes !== undefined) task.notes = t.notes
      if (t.createdAt !== undefined) task.createdAt = t.createdAt
      list.push(task)
      tasksByBucket.set(t.containerId, list)
    })

  // Index buckets by goalId
  const bucketsByGoal = new Map<string, GoalBucketSnapshot[]>()
  bucketRecords
    .slice()
    .sort((a, b) => a.sortIndex - b.sortIndex)
    .forEach((b) => {
      const list = bucketsByGoal.get(b.goalId) ?? []
      list.push({
        id: b.id,
        name: b.name,
        favorite: b.favorite,
        archived: b.archived,
        surfaceStyle: ensureSurfaceStyle(b.surfaceStyle, DEFAULT_SURFACE_STYLE),
        tasks: tasksByBucket.get(b.id) ?? [],
      })
      bucketsByGoal.set(b.goalId, list)
    })

  // Assemble goals
  return goalRecords
    .slice()
    .sort((a, b) => a.sortIndex - b.sortIndex)
    .map((g): GoalSnapshot => ({
      id: g.id,
      name: g.name,
      goalColour: g.goalColour,
      surfaceStyle: DEFAULT_SURFACE_STYLE,
      starred: g.starred,
      archived: g.archived,
      milestonesShown: g.milestonesShown,
      buckets: bucketsByGoal.get(g.id) ?? [],
    }))
}

// ── Write snapshot to IDB cache (flatten + write all 4 caches) ──────────────

export function writeGoalsToCache(userId: string, snapshot: GoalSnapshot[]): void {
  const { goals, buckets, tasks, subtasks } = flattenSnapshot(userId, snapshot)
  goalsCache.set(userId, goals)
  bucketsCache.set(userId, buckets)
  tasksCache.set(userId, tasks)
  subtasksCache.set(userId, subtasks)
}

// ── Clear all goals data for a user ─────────────────────────────────────────

export function clearGoalsCache(userId: string): void {
  goalsCache.remove(userId)
  bucketsCache.remove(userId)
  tasksCache.remove(userId)
  subtasksCache.remove(userId)
}

// ── Hydrate: load from IDB (with localStorage migration) ────────────────────

export async function hydrateGoalsData(userId: string): Promise<void> {
  if (hydratedUsers.has(userId)) return

  try {
    // Try IDB first — query each store by userId index
    const [idbGoals, idbBuckets, idbTasks, idbSubtasks] = await Promise.all([
      queryByUserId<GoalRecord>(STORE.goals, userId),
      queryByUserId<BucketRecord>(STORE.buckets, userId),
      queryByUserId<TaskRecord>(STORE.tasks, userId),
      queryByUserId<SubtaskRecord>(STORE.subtasks, userId),
    ])

    if (idbGoals.length > 0) {
      // IDB has data — use it
      cache.goals.set(userId, idbGoals)
      cache.buckets.set(userId, idbBuckets)
      cache.tasks.set(userId, idbTasks)
      cache.subtasks.set(userId, idbSubtasks)
      hydratedUsers.add(userId)
      return
    }

    // IDB empty — try migrating from localStorage
    const lsData = storage.domain.goals.get(userId)
    if (Array.isArray(lsData) && lsData.length > 0) {
      // Dynamic import to break circular dependency (goalsSync → idbGoals)
      const { createGoalsSnapshot } = await import('./goalsSync')
      const validated = createGoalsSnapshot(lsData)
      if (validated.length > 0) {
        const flat = flattenSnapshot(userId, validated)
        // Write to cache
        cache.goals.set(userId, flat.goals)
        cache.buckets.set(userId, flat.buckets)
        cache.tasks.set(userId, flat.tasks)
        cache.subtasks.set(userId, flat.subtasks)
        // Persist individual records to IDB
        const db = await openDB()
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(
            [STORE.goals, STORE.buckets, STORE.tasks, STORE.subtasks],
            'readwrite',
          )
          flat.goals.forEach((r) => tx.objectStore(STORE.goals).put(r))
          flat.buckets.forEach((r) => tx.objectStore(STORE.buckets).put(r))
          flat.tasks.forEach((r) => tx.objectStore(STORE.tasks).put(r))
          flat.subtasks.forEach((r) => tx.objectStore(STORE.subtasks).put(r))
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        })
        hydratedUsers.add(userId)
        return
      }
    }

    // No data anywhere — empty caches (guest defaults handled by goalsSync.ts)
    cache.goals.set(userId, [])
    cache.buckets.set(userId, [])
    cache.tasks.set(userId, [])
    cache.subtasks.set(userId, [])
    hydratedUsers.add(userId)
  } catch {
    // IDB unavailable — caches stay empty, goalsSync will fall back
    hydratedUsers.add(userId)
  }
}
