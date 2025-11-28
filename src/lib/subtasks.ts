import { supabase, ensureSingleUserSession } from './supabaseClient'
import type { HistoryEntry, HistorySubtask } from './sessionHistory'

const isUuid = (value: string | null | undefined): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

const mapRowToSubtask = (row: any): HistorySubtask | null => {
  if (!row) return null
  const id = typeof row.id === 'string' ? row.id : null
  const text = typeof row.text === 'string' ? row.text : ''
  const completed = Boolean((row as any)?.completed)
  const sortIndexRaw = Number((row as any)?.sort_index)
  const sortIndex = Number.isFinite(sortIndexRaw) ? sortIndexRaw : 0
  if (!id) return null
  return { id, text, completed, sortIndex }
}

export const fetchSubtasksForEntry = async (entry: HistoryEntry): Promise<HistorySubtask[]> => {
  if (!entry) return []
  // Guest/local fallback: pull from goals snapshot for task-linked entries, else from stored history blob
  if (!supabase) {
    if (entry.taskId) {
      const goals = readStoredGoalsSnapshot()
      for (const goal of goals) {
        for (const bucket of goal.buckets) {
          const task = bucket.tasks.find((t) => t.id === entry.taskId)
          if (task && Array.isArray(task.subtasks)) {
            return task.subtasks.map((s) => ({
              id: s.id,
              text: s.text,
              completed: Boolean(s.completed),
              sortIndex: Number.isFinite(s.sortIndex) ? s.sortIndex : 0,
            }))
          }
        }
      }
    }
    // Session-scoped fallback: use stored history entry
    const stored = readStoredHistory().find((h) => h.id === entry.id)
    if (stored?.subtasks) return stored.subtasks.map((s) => ({ ...s }))
    return (entry.subtasks ?? []).map((s) => ({ ...s }))
  }
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return (entry.subtasks ?? []).map((s) => ({ ...s }))
  const userId = session.user.id
  const parentTaskId = isUuid(entry.taskId) ? entry.taskId : null
  const parentSessionId = isUuid(entry.id) ? entry.id : null
  const parentColumn = parentTaskId ? 'task_id' : 'session_id'
  const parentValue = parentTaskId ?? parentSessionId
  if (!parentValue) return []
  const { data, error } = await supabase
    .from('task_subtasks')
    .select('id, text, completed, sort_index')
    .eq('user_id', userId)
    .eq(parentColumn, parentValue)
    .order('sort_index', { ascending: true })
  if (error) return []
  return (data ?? []).map(mapRowToSubtask).filter(Boolean) as HistorySubtask[]
}

type ParentSelector = { taskId?: string | null; sessionId?: string | null }

export const upsertSubtaskForParent = async (
  parent: ParentSelector,
  subtask: HistorySubtask,
): Promise<void> => {
  // Guest/local path
  if (!supabase) {
    if (parent.taskId) {
      const goals = readStoredGoalsSnapshot()
      let changed = false
      goals.forEach((goal) => {
        goal.buckets.forEach((bucket) => {
          bucket.tasks.forEach((task) => {
            if (task.id === parent.taskId) {
              const subs = Array.isArray(task.subtasks) ? [...task.subtasks] : []
              const idx = subs.findIndex((s) => s.id === subtask.id)
              const next = {
                id: subtask.id,
                text: subtask.text,
                completed: subtask.completed,
                sortIndex: subtask.sortIndex,
              }
              if (idx >= 0) subs[idx] = next
              else subs.push(next)
              subs.sort((a, b) => a.sortIndex - b.sortIndex)
              task.subtasks = subs
              changed = true
            }
          })
        })
      })
      if (changed) publishGoalsSnapshot(goals)
    } else if (parent.sessionId) {
      const history = readStoredHistory()
      const nextHistory = history.map((h) => {
        if (h.id !== parent.sessionId) return h
        const subs = Array.isArray(h.subtasks) ? [...h.subtasks] : []
        const idx = subs.findIndex((s) => s.id === subtask.id)
        const next = { ...subtask }
        if (idx >= 0) subs[idx] = next
        else subs.push(next)
        subs.sort((a, b) => a.sortIndex - b.sortIndex)
        return { ...h, subtasks: subs }
      })
      persistHistorySnapshot(nextHistory)
    }
    return
  }
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return
  const taskId = isUuid(parent.taskId ?? null) ? parent.taskId : null
  const sessionId = isUuid(parent.sessionId ?? null) ? parent.sessionId : null
  const parentColumn = taskId ? 'task_id' : sessionId ? 'session_id' : null
  const parentValue = taskId ?? sessionId
  if (!parentColumn || !parentValue) return
  const payload: Record<string, any> = {
    id: subtask.id,
    user_id: session.user.id,
    text: subtask.text,
    completed: Boolean(subtask.completed),
    sort_index: Number.isFinite(subtask.sortIndex) ? subtask.sortIndex : 0,
  }
  payload[parentColumn] = parentValue
  await supabase.from('task_subtasks').upsert(payload, { onConflict: 'id' })
}

export const deleteSubtaskForParent = async (
  parent: ParentSelector,
  subtaskId: string,
): Promise<void> => {
  if (!supabase) {
    if (parent.taskId) {
      const goals = readStoredGoalsSnapshot()
      let changed = false
      goals.forEach((goal) => {
        goal.buckets.forEach((bucket) => {
          bucket.tasks.forEach((task) => {
            if (task.id === parent.taskId && Array.isArray(task.subtasks)) {
              const before = task.subtasks.length
              task.subtasks = task.subtasks.filter((s) => s.id !== subtaskId)
              if (task.subtasks.length !== before) changed = true
            }
          })
        })
      })
      if (changed) publishGoalsSnapshot(goals)
    } else if (parent.sessionId) {
      const history = readStoredHistory()
      const nextHistory = history.map((h) =>
        h.id === parent.sessionId
          ? { ...h, subtasks: Array.isArray(h.subtasks) ? h.subtasks.filter((s) => s.id !== subtaskId) : [] }
          : h,
      )
      persistHistorySnapshot(nextHistory)
    }
    return
  }
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return
  const taskId = isUuid(parent.taskId ?? null) ? parent.taskId : null
  const sessionId = isUuid(parent.sessionId ?? null) ? parent.sessionId : null
  const parentColumn = taskId ? 'task_id' : sessionId ? 'session_id' : null
  const parentValue = taskId ?? sessionId
  if (!parentColumn || !parentValue || !subtaskId) return
  await supabase
    .from('task_subtasks')
    .delete()
    .eq('id', subtaskId)
    .eq(parentColumn, parentValue)
    .eq('user_id', session.user.id)
}

export const migrateSessionSubtasksToTask = async (
  sessionId: string,
  taskId: string,
): Promise<void> => {
  if (!supabase || !isUuid(sessionId) || !isUuid(taskId)) return
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return
  const userId = session.user.id
  const { data: existingRows, error: fetchErr } = await supabase
    .from('task_subtasks')
    .select('id, text, completed, sort_index')
    .eq('user_id', userId)
    .eq('session_id', sessionId)
    .order('sort_index', { ascending: true })
  if (fetchErr || !Array.isArray(existingRows) || existingRows.length === 0) return
  const { data: maxRows } = await supabase
    .from('task_subtasks')
    .select('sort_index')
    .eq('user_id', userId)
    .eq('task_id', taskId)
    .order('sort_index', { ascending: false })
    .limit(1)
  const maxSort = Array.isArray(maxRows) && maxRows.length > 0 ? Number((maxRows[0] as any)?.sort_index ?? 0) : 0
  let nextSort = Number.isFinite(maxSort) ? maxSort + 1024 : 1024
  const updates = existingRows.map((row: any, index: number) => ({
    id: row.id,
    user_id: userId,
    task_id: taskId,
    session_id: null,
    text: typeof row.text === 'string' ? row.text : '',
    completed: Boolean(row.completed),
    sort_index: nextSort + index * 1024,
  }))
  await supabase.from('task_subtasks').upsert(updates, { onConflict: 'id' })
}
import { readStoredGoalsSnapshot, publishGoalsSnapshot } from './goalsSync'
import { readStoredHistory, persistHistorySnapshot } from './sessionHistory'
