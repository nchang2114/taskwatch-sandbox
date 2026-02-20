import { ensureSingleUserSession, supabase } from './supabaseClient'
import { ensureServerBucketStyle, DEFAULT_SURFACE_STYLE } from './surfaceStyles'
import { QUICK_LIST_CONTAINER_ID, writeQuickListToCache, type TaskRecord, type SubtaskRecord } from './idbGoals'
import { getCurrentUserId } from './namespaceManager'
import type { QuickListEntry } from './quickList'
import { QUICK_LIST_UPDATE_EVENT } from './quickList'

export const QUICK_LIST_GOAL_NAME = 'Quick List (Hidden)'
const QUICK_LIST_BUCKET_NAME = 'Quick List'
const QUICK_LIST_GOAL_COLOUR = 'linear-gradient(135deg, #38bdf8 0%, #6366f1 100%)'

let ensurePromise: Promise<{ goalId: string; bucketId: string } | null> | null = null

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

const normalizeQuickListGoalColour = (value: string | null | undefined): string => {
  if (typeof value !== 'string') {
    return QUICK_LIST_GOAL_COLOUR
  }
  const trimmed = value.trim()
  if (trimmed.toLowerCase().startsWith('linear-gradient(')) {
    return trimmed
  }
  return QUICK_LIST_GOAL_COLOUR
}

export async function ensureQuickListRemoteStructures(): Promise<{ goalId: string; bucketId: string } | null> {
  if (!supabase) return null
  if (ensurePromise) {
    return ensurePromise
  }
  ensurePromise = (async () => {
    const session = await ensureSingleUserSession()
    if (!session?.user?.id) {
      return null
    }
    const userId = session.user.id
    try {
      const { data: existingGoal, error: goalLookupError } = await supabase
        .from('goals')
        .select('id, goal_colour')
        .eq('user_id', userId)
        .eq('name', QUICK_LIST_GOAL_NAME)
        .limit(1)
        .maybeSingle()
      if (goalLookupError) {
        return null
      }
      const goalId =
        typeof existingGoal?.id === 'string' && existingGoal.id.trim().length > 0
          ? existingGoal.id
          : generateUuid()
      if (!existingGoal?.id) {
        const goal_colour = normalizeQuickListGoalColour((existingGoal as any)?.goal_colour)
        const goalPayload = {
          id: goalId,
          user_id: userId,
          name: QUICK_LIST_GOAL_NAME,
          goal_colour,
          sort_index: 10_000_000,
          starred: false,
          goal_archive: true,
          milestones_shown: false,
        }
        const { error: goalInsertError } = await supabase.from('goals').insert(goalPayload)
        if (goalInsertError) {
          return null
        }
      } else {
        const normalized = normalizeQuickListGoalColour((existingGoal as any)?.goal_colour)
        if (normalized !== (existingGoal as any)?.goal_colour) {
          await supabase.from('goals').update({ goal_colour: normalized }).eq('id', goalId).eq('user_id', userId)
        }
      }
      const { data: existingBucket, error: bucketLookupError } = await supabase
        .from('buckets')
        .select('id')
        .eq('user_id', userId)
        .eq('goal_id', goalId)
        .eq('name', QUICK_LIST_BUCKET_NAME)
        .limit(1)
        .maybeSingle()
      if (bucketLookupError) {
        return null
      }
      const bucketId =
        typeof existingBucket?.id === 'string' && existingBucket.id.trim().length > 0
          ? existingBucket.id
          : generateUuid()
      if (!existingBucket?.id) {
        const surface = ensureServerBucketStyle(DEFAULT_SURFACE_STYLE)
        const bucketPayload = {
          id: bucketId,
          user_id: userId,
          goal_id: goalId,
          name: QUICK_LIST_BUCKET_NAME,
          favorite: false,
          sort_index: 10_000_000,
          bucket_archive: true,
          buckets_card_style: surface,
        }
        const { error: bucketInsertError } = await supabase.from('buckets').insert(bucketPayload)
        if (bucketInsertError) {
          const code = String((bucketInsertError as any)?.code || '')
          if (code === '23514') {
            const { error: retryError } = await supabase
              .from('buckets')
              .insert({ ...bucketPayload, buckets_card_style: null })
            if (retryError) {
              return null
            }
          } else {
            return null
          }
        }
      }
      return { goalId, bucketId }
    } catch {
      return null
    }
  })()
  ensurePromise
    ?.catch(() => {
      // errors are handled inside the async function; this prevents unhandled rejection noise
    })
    .finally(() => {
      ensurePromise = null
    })
  return ensurePromise
}

export async function fetchQuickListRemoteItems(): Promise<{
  goalId: string
  bucketId: string
  tasks: TaskRecord[]
  subtasks: SubtaskRecord[]
} | null> {
  if (!supabase) return null
  const ids = (await ensureQuickListRemoteStructures()) ?? null
  if (!ids) {
    return null
  }
  const { bucketId, goalId } = ids
  const userId = getCurrentUserId()
  try {
    const { data: taskRows, error: taskError } = await supabase
      .from('tasks')
      .select('id, text, completed, difficulty, priority, sort_index, notes, updated_at')
      .eq('bucket_id', bucketId)
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

    return { goalId, bucketId, tasks, subtasks }
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
