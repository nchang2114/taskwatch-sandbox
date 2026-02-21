import { ensureSingleUserSession, supabase } from './supabaseClient'
import { QUICK_LIST_CONTAINER_ID, writeQuickListToCache, type TaskRecord, type SubtaskRecord } from './idbGoals'
import { getCurrentUserId } from './namespaceManager'
import type { QuickListEntry } from './quickList'
import { QUICK_LIST_UPDATE_EVENT } from './quickList'

/** @deprecated Kept for backwards-compatible filtering of legacy Quick List goals during migration. */
export const QUICK_LIST_GOAL_NAME = 'Quick List (Hidden)'

export const generateUuid = (): string => {
  const cryptoRef = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
    try {
      return cryptoRef.randomUUID()
    } catch {
      // ignore runtime crypto failures and fall back to manual UUID generation
    }
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const r = (Math.random() * 16) | 0
    const v = char === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

const normalizeDifficulty = (
  difficulty: unknown,
): 'none' | 'green' | 'yellow' | 'red' => {
  if (difficulty === 'green' || difficulty === 'yellow' || difficulty === 'red') {
    return difficulty
  }
  return 'none'
}

export async function fetchQuickListRemoteItems(): Promise<{
  tasks: TaskRecord[]
  subtasks: SubtaskRecord[]
} | null> {
  if (!supabase) return null
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    return null
  }
  const userId = getCurrentUserId()
  try {
    const { data: taskRows, error: taskError } = await supabase
      .from('tasks')
      .select('id, text, completed, difficulty, priority, sort_index, notes, updated_at')
      .eq('container_id', QUICK_LIST_CONTAINER_ID)
      .eq('user_id', session.user.id)
      .order('completed', { ascending: true })
      .order('priority', { ascending: false })
      .order('sort_index', { ascending: true })
    if (taskError) {
      return null
    }
    const rows = Array.isArray(taskRows) ? taskRows : []
    const taskIds = rows.map((task) => task.id)

    let subtaskRows: any[] = []
    if (taskIds.length) {
      const { data } = await supabase
        .from('task_subtasks')
        .select('id, task_id, text, completed, sort_index, updated_at')
        .in('task_id', taskIds)
        .order('sort_index', { ascending: true })
      if (Array.isArray(data)) {
        subtaskRows = data
      }
    }

    const tasks: TaskRecord[] = rows.map((task, index) => ({
      id: task.id,
      userId,
      containerId: QUICK_LIST_CONTAINER_ID,
      text: typeof task.text === 'string' ? task.text : '',
      completed: Boolean(task.completed),
      difficulty: normalizeDifficulty(task.difficulty),
      priority: Boolean(task.priority),
      notes: typeof task.notes === 'string' ? task.notes : '',
      sortIndex: index,
      updatedAt: typeof task.updated_at === 'string' ? task.updated_at : undefined,
    }))

    const subtasks: SubtaskRecord[] = subtaskRows.map((sub) => ({
      id: sub.id,
      userId,
      taskId: sub.task_id,
      text: typeof sub.text === 'string' ? sub.text : '',
      completed: Boolean(sub.completed),
      sortIndex: typeof sub.sort_index === 'number' ? sub.sort_index : 0,
      updatedAt: typeof sub.updated_at === 'string' ? sub.updated_at : undefined,
    }))

    return { tasks, subtasks }
  } catch {
    return null
  }
}

/**
 * Syncs quick list from Supabase to IDB cache.
 * Called during bootstrap to populate the user's quick list after sign-in.
 */
export async function syncQuickListFromSupabase(): Promise<QuickListEntry[] | null> {
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    return null
  }

  const remote = await fetchQuickListRemoteItems()
  if (!remote?.tasks) {
    return null
  }

  const userId = getCurrentUserId()
  writeQuickListToCache(userId, remote.tasks, remote.subtasks)

  // Bundle for event dispatch
  const subtasksByTask = new Map<string, SubtaskRecord[]>()
  for (const s of remote.subtasks) {
    const list = subtasksByTask.get(s.taskId) ?? []
    list.push(s)
    subtasksByTask.set(s.taskId, list)
  }
  const entries: QuickListEntry[] = remote.tasks.map((task) => ({
    ...task,
    subtasks: (subtasksByTask.get(task.id) ?? []).slice().sort((a, b) => a.sortIndex - b.sortIndex),
  }))

  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent(QUICK_LIST_UPDATE_EVENT, { detail: entries }))
    } catch {}
  }

  console.log('[quickListRemote] Synced', entries.length, 'quick list items from Supabase')
  return entries
}
