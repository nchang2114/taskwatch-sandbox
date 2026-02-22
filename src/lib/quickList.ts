/**
 * Quick List — unified with IDB tasks store.
 *
 * Quick list items are regular TaskRecords with containerId === '__quicklist__'.
 * Subtasks are regular SubtaskRecords. No separate storage path.
 *
 * For component convenience, readStoredQuickList() returns QuickListEntry[]
 * (TaskRecord with subtasks bundled). The persistence layer splits them.
 */

import {
  QUICK_LIST_CONTAINER_ID,
  readQuickListTasks,
  readQuickListSubtasks,
  writeQuickListToCache,
  type TaskRecord,
  type SubtaskRecord,
} from './idbGoals'
import { getCurrentUserId, GUEST_USER_ID, onUserChange } from './namespaceManager'

// ── Re-exports for transition ────────────────────────────────────────────────

/** @deprecated Use TaskRecord from idbGoals instead */
export type QuickItem = TaskRecord & { subtasks: SubtaskRecord[] }
/** @deprecated Use SubtaskRecord from idbGoals instead */
export type QuickSubtask = SubtaskRecord

/** Bundled type: a TaskRecord with its subtasks attached for convenience. */
export type QuickListEntry = TaskRecord & { subtasks: SubtaskRecord[] }

// ── Events ───────────────────────────────────────────────────────────────────

export const QUICK_LIST_UPDATE_EVENT = 'nc-quick-list:updated'
/** @deprecated Use GUEST_USER_ID from namespaceManager instead */
export const QUICK_LIST_GUEST_USER_ID = GUEST_USER_ID
export const QUICK_LIST_USER_EVENT = 'nc-quick-list:user-updated'

// ── Default quick list items ─────────────────────────────────────────────────

const QUICK_LIST_DEFAULT_ITEMS: Array<{
  id: string
  text: string
  completed: boolean
  notes: string
  difficulty: 'none' | 'green' | 'yellow' | 'red'
  priority: boolean
  subtasks?: Array<{ id: string; text: string; completed: boolean }>
}> = [
  {
    id: 'quick-groceries',
    text: 'Groceries \u2013 restock basics',
    completed: false,
    notes: 'Think breakfast, greens, grab-and-go snacks.',
    difficulty: 'green',
    priority: true,
    subtasks: [
      { id: 'quick-groceries-1', text: 'Fruit + greens', completed: false },
      { id: 'quick-groceries-2', text: 'Breakfast staples', completed: false },
      { id: 'quick-groceries-3', text: 'Snacks / treats', completed: false },
    ],
  },
  {
    id: 'quick-laundry',
    text: 'Laundry + fold',
    completed: false,
    notes: 'Start a load before work, fold during a show.',
    difficulty: 'green',
    priority: false,
  },
  {
    id: 'quick-clean',
    text: '10-min reset: tidy desk & surfaces',
    completed: false,
    notes: 'Clear cups, wipe surfaces, light candle or diffuser.',
    difficulty: 'yellow',
    priority: false,
  },
  {
    id: 'quick-bills',
    text: 'Pay bills & snapshot budget',
    completed: false,
    notes: 'Autopay check + log any big expenses.',
    difficulty: 'yellow',
    priority: false,
  },
  {
    id: 'quick-social',
    text: 'Send a check-in text',
    completed: false,
    notes: "Ping a friend/family member you\u2019ve been thinking about.",
    difficulty: 'green',
    priority: false,
  },
]

// ── Conversion helpers ───────────────────────────────────────────────────────

/** Convert legacy QuickItem[] (from localStorage) to TaskRecord[] + SubtaskRecord[]. */
export function convertQuickItemsToRecords(
  userId: string,
  items: unknown[],
): { tasks: TaskRecord[]; subtasks: SubtaskRecord[] } {
  const tasks: TaskRecord[] = []
  const subtasks: SubtaskRecord[] = []
  const sanitized = sanitizeLegacyItems(items)
  sanitized.forEach((item, idx) => {
    tasks.push({
      id: item.id,
      userId,
      containerId: QUICK_LIST_CONTAINER_ID,
      text: item.text,
      completed: item.completed,
      difficulty: item.difficulty ?? 'none',
      priority: item.priority ?? false,
      notes: item.notes,
      sortIndex: idx,
      updatedAt: item.updatedAt,
    })
    const subs = Array.isArray(item.subtasks) ? item.subtasks : []
    subs.forEach((sub: any, subIdx: number) => {
      if (!sub || typeof sub !== 'object') return
      const subId = typeof sub.id === 'string' && sub.id.trim() ? sub.id : `${item.id}-sub-${subIdx}`
      subtasks.push({
        id: subId,
        userId,
        taskId: item.id,
        text: typeof sub.text === 'string' ? sub.text : '',
        completed: Boolean(sub.completed),
        sortIndex: subIdx,
        updatedAt: typeof sub.updatedAt === 'string' ? sub.updatedAt : undefined,
      })
    })
  })
  return { tasks, subtasks }
}

/** Generate default quick list records for a user. */
export function getDefaultQuickListRecords(userId: string): { tasks: TaskRecord[]; subtasks: SubtaskRecord[] } {
  const tasks: TaskRecord[] = []
  const subtasks: SubtaskRecord[] = []
  QUICK_LIST_DEFAULT_ITEMS.forEach((item, idx) => {
    tasks.push({
      id: item.id,
      userId,
      containerId: QUICK_LIST_CONTAINER_ID,
      text: item.text,
      completed: item.completed,
      difficulty: item.difficulty,
      priority: item.priority,
      notes: item.notes,
      sortIndex: idx,
    })
    ;(item.subtasks ?? []).forEach((sub, subIdx) => {
      subtasks.push({
        id: sub.id,
        userId,
        taskId: item.id,
        text: sub.text,
        completed: sub.completed,
        sortIndex: subIdx,
      })
    })
  })
  return { tasks, subtasks }
}

// ── Sanitize legacy items (for migration) ────────────────────────────────────

function sanitizeLegacyItems(value: unknown): any[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: any[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const v = item as any
    const id = typeof v.id === 'string' && v.id.trim() ? v.id : null
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(v)
  }
  return out
    .sort((a: any, b: any) => (Number(a.sortIndex) || 0) - (Number(b.sortIndex) || 0))
    .map((it: any, i: number) => ({ ...it, sortIndex: i }))
}

// ── Public API ───────────────────────────────────────────────────────────────

export const readQuickListOwnerId = (): string => getCurrentUserId()

/** Read quick list items with subtasks bundled (sync from cache). */
export const readStoredQuickList = (): QuickListEntry[] => {
  if (typeof window === 'undefined') return []
  const userId = getCurrentUserId()
  const tasks = readQuickListTasks(userId)
  return bundleFromCache(userId, tasks)
}

/** Write quick list items (splits tasks + subtasks, writes to IDB cache). */
export const writeStoredQuickList = (items: QuickListEntry[]): QuickListEntry[] => {
  const userId = getCurrentUserId()
  const tasks: TaskRecord[] = []
  const subtasks: SubtaskRecord[] = []

  items.forEach((entry, idx) => {
    const { subtasks: entrySubs, ...task } = entry
    tasks.push({ ...task, sortIndex: idx, userId, containerId: QUICK_LIST_CONTAINER_ID })
    ;(entrySubs ?? []).forEach((sub, subIdx) => {
      subtasks.push({ ...sub, sortIndex: subIdx, userId, taskId: task.id })
    })
  })

  writeQuickListToCache(userId, tasks, subtasks)

  const result = bundleFromCache(userId, tasks)
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent(QUICK_LIST_UPDATE_EVENT, { detail: result }))
    } catch {}
  }
  return result
}

/** Subscribe to quick list updates. */
export const subscribeQuickList = (cb: (items: QuickListEntry[]) => void): (() => void) => {
  if (typeof window === 'undefined') return () => {}
  const handler = (ev: Event) => {
    const ce = ev as CustomEvent<QuickListEntry[]>
    if (Array.isArray(ce.detail)) cb(ce.detail)
    else cb(readStoredQuickList())
  }
  window.addEventListener(QUICK_LIST_UPDATE_EVENT, handler as EventListener)
  return () => window.removeEventListener(QUICK_LIST_UPDATE_EVENT, handler as EventListener)
}

/** @deprecated Keep for bootstrap migration compatibility. */
export const sanitizeQuickList = sanitizeLegacyItems

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Bundle tasks + subtasks from cache into QuickListEntry[]. */
function bundleFromCache(userId: string, tasks: TaskRecord[]): QuickListEntry[] {
  const allSubtasks = readQuickListSubtasks(userId)
  const subtasksByTask = new Map<string, SubtaskRecord[]>()
  for (const s of allSubtasks) {
    const list = subtasksByTask.get(s.taskId) ?? []
    list.push(s)
    subtasksByTask.set(s.taskId, list)
  }

  return tasks
    .slice()
    .sort((a, b) => a.sortIndex - b.sortIndex)
    .map((task) => ({
      ...task,
      subtasks: (subtasksByTask.get(task.id) ?? []).slice().sort((a, b) => a.sortIndex - b.sortIndex),
    }))
}

// ── Namespace change listener ────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  onUserChange((_previous, next) => {
    if (next === GUEST_USER_ID) {
      // Guest defaults are seeded centrally by guestInitialization.ts.
      const entries = bundleFromCache(next, readQuickListTasks(next))
      try {
        window.dispatchEvent(new CustomEvent(QUICK_LIST_UPDATE_EVENT, { detail: entries }))
      } catch {}
    } else {
      // Clear QL cache for new auth user (will be populated by sync)
      writeQuickListToCache(next, [], [])
    }
    try {
      window.dispatchEvent(new Event(QUICK_LIST_USER_EVENT))
    } catch {}
  })
}
