/**
 * Low-level IndexedDB setup.
 *
 * DB name: "taskwatch"
 * Object stores: goals, buckets, tasks, subtasks, milestones,
 *                lifeRoutines, userPreferences
 *
 * Each store uses `id` (UUID) as keyPath with a `userId` index
 * for per-user scoping, plus FK indexes for parent lookups.
 * Exception: userPreferences uses `userId` as keyPath (one record per user).
 */

const DB_NAME = 'taskwatch'
const DB_VERSION = 2

export const STORE = {
  goals: 'goals',
  buckets: 'buckets',
  tasks: 'tasks',
  subtasks: 'subtasks',
  milestones: 'milestones',
  lifeRoutines: 'lifeRoutines',
  userPreferences: 'userPreferences',
} as const

export type StoreName = (typeof STORE)[keyof typeof STORE]

let dbPromise: Promise<IDBDatabase> | null = null

export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result

      // goals: id (keyPath), userId index
      if (!db.objectStoreNames.contains(STORE.goals)) {
        const store = db.createObjectStore(STORE.goals, { keyPath: 'id' })
        store.createIndex('userId', 'userId', { unique: false })
      }

      // buckets: id (keyPath), userId + goalId indexes
      if (!db.objectStoreNames.contains(STORE.buckets)) {
        const store = db.createObjectStore(STORE.buckets, { keyPath: 'id' })
        store.createIndex('userId', 'userId', { unique: false })
        store.createIndex('goalId', 'goalId', { unique: false })
      }

      // tasks: id (keyPath), userId + containerId indexes
      if (!db.objectStoreNames.contains(STORE.tasks)) {
        const store = db.createObjectStore(STORE.tasks, { keyPath: 'id' })
        store.createIndex('userId', 'userId', { unique: false })
        store.createIndex('containerId', 'containerId', { unique: false })
      }

      // subtasks: id (keyPath), userId + taskId indexes
      if (!db.objectStoreNames.contains(STORE.subtasks)) {
        const store = db.createObjectStore(STORE.subtasks, { keyPath: 'id' })
        store.createIndex('userId', 'userId', { unique: false })
        store.createIndex('taskId', 'taskId', { unique: false })
      }

      // milestones: id (keyPath), userId + goalId indexes
      if (!db.objectStoreNames.contains(STORE.milestones)) {
        const store = db.createObjectStore(STORE.milestones, { keyPath: 'id' })
        store.createIndex('userId', 'userId', { unique: false })
        store.createIndex('goalId', 'goalId', { unique: false })
      }

      // lifeRoutines: id (keyPath), userId index
      if (!db.objectStoreNames.contains(STORE.lifeRoutines)) {
        const store = db.createObjectStore(STORE.lifeRoutines, { keyPath: 'id' })
        store.createIndex('userId', 'userId', { unique: false })
      }

      // userPreferences: userId as keyPath (one record per user)
      if (!db.objectStoreNames.contains(STORE.userPreferences)) {
        db.createObjectStore(STORE.userPreferences, { keyPath: 'userId' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      dbPromise = null
      reject(request.error)
    }
  })
  return dbPromise
}
