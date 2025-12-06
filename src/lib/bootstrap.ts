import { supabase, ensureSingleUserSession } from './supabaseClient'
import type { QuickItem } from './quickList'
import { ensureQuickListRemoteStructures, generateUuid } from './quickListRemote'
import {
  createTask,
  updateTaskNotes,
  setTaskDifficulty,
  setTaskPriorityAndResort,
  setTaskCompletedAndResort,
  upsertTaskSubtask,
} from './goalsApi'
import { pushLifeRoutinesToSupabase, type LifeRoutineConfig } from './lifeRoutines'
import { bulkInsertSnapbackTriggers, type SnapbackTriggerPayload } from './snapbackApi'

let bootstrapPromises = new Map<string, Promise<boolean>>()
const BOOTSTRAP_LOCK_TTL_MS = 2 * 60 * 1000
const makeBootstrapLockKey = (userId: string) => `nc-taskwatch-bootstrap-lock::${userId}`

const acquireBootstrapLock = (userId: string): boolean => {
  if (typeof window === 'undefined') {
    return true
  }
  try {
    const key = makeBootstrapLockKey(userId)
    const raw = window.localStorage.getItem(key)
    const now = Date.now()
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { expiresAt?: number }
        if (parsed?.expiresAt && parsed.expiresAt > now) {
          return false
        }
      } catch {}
    }
    const expiresAt = now + BOOTSTRAP_LOCK_TTL_MS
    window.localStorage.setItem(key, JSON.stringify({ expiresAt }))
    return true
  } catch {
    return true
  }
}

const releaseBootstrapLock = (userId: string): void => {
  if (typeof window === 'undefined') {
    return
  }
  try {
    window.localStorage.removeItem(makeBootstrapLockKey(userId))
  } catch {}
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const isUuid = (value: string | undefined | null): value is string => !!value && UUID_REGEX.test(value)
const ensureUuid = (value: string | undefined): string => (isUuid(value) ? value! : generateUuid())

const sortByIndex = (a: { sortIndex?: number }, b: { sortIndex?: number }) => {
  const left = typeof a.sortIndex === 'number' ? a.sortIndex : 0
  const right = typeof b.sortIndex === 'number' ? b.sortIndex : 0
  return left - right
}

const uploadQuickListItems = async (items: QuickItem[]): Promise<void> => {
  if (!supabase || items.length === 0) {
    return
  }
  const remote = await ensureQuickListRemoteStructures()
  if (!remote) {
    throw new Error('Quick List remote structures unavailable')
  }
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    throw new Error('Missing Supabase session for Quick List migration')
  }
  const { bucketId } = remote
  // Start from a clean slate so we don't duplicate default content
  const { error: deleteError } = await supabase
    .from('tasks')
    .delete()
    .eq('bucket_id', bucketId)
    .eq('user_id', session.user.id)
  if (deleteError) {
    throw deleteError
  }

  const ordered = [
    ...items.filter((item) => !item.completed).sort(sortByIndex),
    ...items.filter((item) => item.completed).sort(sortByIndex),
  ]
  for (const item of ordered) {
    try {
      const baseText = item.text?.trim().length ? item.text.trim() : 'Quick task'
      const created = await createTask(bucketId, baseText)
      const taskId = created?.id
      if (!taskId) {
        throw new Error('Failed to create Quick List task during migration')
      }
      const subtasks = Array.isArray(item.subtasks) ? [...item.subtasks].sort(sortByIndex) : []
      for (let idx = 0; idx < subtasks.length; idx += 1) {
        const sub = subtasks[idx]
        const sortIndex = typeof sub.sortIndex === 'number' ? sub.sortIndex : idx
        await upsertTaskSubtask(taskId, {
          id: ensureUuid(sub.id),
          text: sub.text,
          completed: Boolean(sub.completed),
          sort_index: sortIndex,
          updated_at: sub.updatedAt,
        })
      }
      if (item.notes && item.notes.trim().length > 0) {
        await updateTaskNotes(taskId, item.notes)
      }
      if (item.difficulty && item.difficulty !== 'none') {
        await setTaskDifficulty(taskId, item.difficulty)
      }
      if (item.priority) {
        await setTaskPriorityAndResort(taskId, bucketId, false, true)
      }
      if (item.completed) {
        await setTaskCompletedAndResort(taskId, bucketId, true)
        if (item.priority) {
          await setTaskPriorityAndResort(taskId, bucketId, true, true)
        }
      }
    } catch (err) {
      throw err instanceof Error ? err : new Error('Failed to migrate Quick List task')
    }
  }
}

/**
 * Guest Data Lifecycle:
 * 
 * 1. GUEST MODE: User works locally, data saved to nc-taskwatch-*::__guest__ keys
 * 2. SIGN-UP: Guest data snapshotted to bootstrap-snapshot::* keys (in App.tsx)
 * 3. BOOTSTRAP: This function migrates snapshot → DB, then clears all guest data
 * 4. ACCOUNT: User works with DB-backed data
 * 5. SIGN-OUT: resetLocalStoresToGuest() clears guest keys → fresh defaults appear
 * 
 * Multi-tab: Only the tab doing sign-up bootstraps. Other tabs skip (bootstrap_completed=true)
 * 
 * NOTE: Goals bootstrap is disabled - new accounts start with empty goals.
 * Goals are cleared via ensureGoalsUser() when switching to authenticated user.
 */
const migrateGuestData = async (): Promise<void> => {
  // Clear goals snapshot to prevent stale demo IDs from being used
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem('nc-taskwatch-goals-snapshot')
      window.localStorage.removeItem('nc-taskwatch-goals-snapshot::__guest__')
      window.localStorage.removeItem('nc-taskwatch-bootstrap-snapshot::goals')
    } catch {}
  }

  // Read from snapshot first (created at sign-up), fall back to guest key
  const snapshotRoutinesRaw = typeof window !== 'undefined'
    ? window.localStorage.getItem('nc-taskwatch-bootstrap-snapshot::life-routines')
    : null
  const guestRoutinesRaw = !snapshotRoutinesRaw && typeof window !== 'undefined'
    ? window.localStorage.getItem('nc-taskwatch-life-routines::__guest__')
    : null
  const routinesRaw = snapshotRoutinesRaw || guestRoutinesRaw
  
  console.log('[bootstrap] Life routines migration:', {
    hasSnapshot: !!snapshotRoutinesRaw,
    hasGuestData: !!guestRoutinesRaw,
    usingSource: snapshotRoutinesRaw ? 'snapshot' : guestRoutinesRaw ? 'guest' : 'none',
  })
  
  // Parse and validate - ONLY use snapshot or guest data, never fallback to current user
  let routines: LifeRoutineConfig[] = []
  if (routinesRaw) {
    try {
      const parsed = JSON.parse(routinesRaw)
      if (Array.isArray(parsed) && parsed.length > 0) {
        routines = parsed
        console.log('[bootstrap] Migrating', routines.length, 'life routines')
      }
    } catch (e) {
      console.warn('[bootstrap] Could not parse life routines:', e)
    }
  }
  
  // Clear snapshots after reading
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem('nc-taskwatch-bootstrap-snapshot::life-routines')
      window.localStorage.removeItem('nc-taskwatch-bootstrap-snapshot::quick-list')
      window.localStorage.removeItem('nc-taskwatch-bootstrap-snapshot::goals')
      window.localStorage.removeItem('nc-taskwatch-bootstrap-snapshot::history')
      window.localStorage.removeItem('nc-taskwatch-bootstrap-snapshot::repeating')
    } catch {}
  }
  
  if (routines.length > 0) {
    await pushLifeRoutinesToSupabase(routines, { strict: true })
  }

  // Read quick list from snapshot first (created at sign-up), fall back to guest key
  const snapshotQuickListRaw = typeof window !== 'undefined'
    ? window.localStorage.getItem('nc-taskwatch-bootstrap-snapshot::quick-list')
    : null
  const guestQuickListRaw = !snapshotQuickListRaw && typeof window !== 'undefined'
    ? window.localStorage.getItem('nc-taskwatch-quicklist::__guest__')
    : null
  const quickListRaw = snapshotQuickListRaw || guestQuickListRaw
  
  console.log('[bootstrap] Quick list migration:', {
    hasSnapshot: !!snapshotQuickListRaw,
    hasGuestData: !!guestQuickListRaw,
    usingSource: snapshotQuickListRaw ? 'snapshot' : guestQuickListRaw ? 'guest' : 'none',
  })
  
  let quickItems: QuickItem[] = []
  if (quickListRaw) {
    try {
      const parsed = JSON.parse(quickListRaw)
      if (Array.isArray(parsed)) {
        quickItems = parsed
        console.log('[bootstrap] Migrating', quickItems.length, 'quick list items')
      }
    } catch (e) {
      console.warn('[bootstrap] Could not parse quick list:', e)
    }
  }
  
  if (quickItems.length > 0) {
    await uploadQuickListItems(quickItems)
  }
  
  // Migrate Snapback triggers and plans
  const LOCAL_TRIGGERS_KEY = 'nc-taskwatch-local-snapback-triggers'
  const LOCAL_PLANS_KEY = 'nc-taskwatch-local-snap-plans'
  
  type LocalTrigger = { id: string; label: string; cue: string; deconstruction: string; plan: string }
  type LocalPlan = { cue: string; deconstruction: string; plan: string }
  
  let localTriggers: LocalTrigger[] = []
  let localPlans: Record<string, LocalPlan> = {}
  
  // Read local triggers (custom triggers created by guest)
  const triggersRaw = typeof window !== 'undefined' ? window.localStorage.getItem(LOCAL_TRIGGERS_KEY) : null
  if (triggersRaw) {
    try {
      const parsed = JSON.parse(triggersRaw)
      if (Array.isArray(parsed)) {
        localTriggers = parsed
        console.log('[bootstrap] Found', localTriggers.length, 'local snapback triggers')
      }
    } catch (e) {
      console.warn('[bootstrap] Could not parse local snapback triggers:', e)
    }
  }
  
  // Read local plans (plans for history-derived triggers like Doomscrolling)
  const plansRaw = typeof window !== 'undefined' ? window.localStorage.getItem(LOCAL_PLANS_KEY) : null
  if (plansRaw) {
    try {
      const parsed = JSON.parse(plansRaw)
      if (parsed && typeof parsed === 'object') {
        localPlans = parsed
        console.log('[bootstrap] Found local snapback plans for', Object.keys(localPlans).length, 'triggers')
      }
    } catch (e) {
      console.warn('[bootstrap] Could not parse local snapback plans:', e)
    }
  }
  
  // Build list of triggers to migrate
  const triggersToMigrate: SnapbackTriggerPayload[] = []
  
  // Add custom triggers from localTriggers
  localTriggers.forEach((lt) => {
    const label = lt.label?.trim()
    if (label) {
      triggersToMigrate.push({
        trigger_name: label,
        cue_text: lt.cue ?? '',
        deconstruction_text: lt.deconstruction ?? '',
        plan_text: lt.plan ?? '',
      })
    }
  })
  
  // Add triggers from localPlans (these are history-derived triggers with edited plans)
  // The key format is "trigger-{triggerName}" or just the trigger name
  Object.entries(localPlans).forEach(([key, plan]) => {
    const triggerName = key.startsWith('trigger-') ? key.slice(8) : key
    if (triggerName && !triggersToMigrate.some((t) => t.trigger_name.toLowerCase() === triggerName.toLowerCase())) {
      triggersToMigrate.push({
        trigger_name: triggerName,
        cue_text: plan.cue ?? '',
        deconstruction_text: plan.deconstruction ?? '',
        plan_text: plan.plan ?? '',
      })
    }
  })
  
  // Also ensure "Doomscrolling" default trigger exists (from sample history)
  if (!triggersToMigrate.some((t) => t.trigger_name.toLowerCase() === 'doomscrolling')) {
    triggersToMigrate.push({
      trigger_name: 'Doomscrolling',
      cue_text: '',
      deconstruction_text: '',
      plan_text: '',
    })
  }
  
  if (triggersToMigrate.length > 0) {
    console.log('[bootstrap] Migrating', triggersToMigrate.length, 'snapback triggers to DB')
    await bulkInsertSnapbackTriggers(triggersToMigrate)
  }
  
  // Clear all guest data after successful migration
  // This ensures sign-out will show fresh defaults
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem('nc-taskwatch-life-routines::__guest__')
      window.localStorage.removeItem('nc-taskwatch-quicklist::__guest__')
      window.localStorage.removeItem('nc-taskwatch-session-history::__guest__')
      window.localStorage.removeItem('nc-taskwatch-repeating-rules::__guest__')
      window.localStorage.removeItem('nc-taskwatch-goals-snapshot::__guest__')
      // Clear snapback guest data
      window.localStorage.removeItem(LOCAL_TRIGGERS_KEY)
      window.localStorage.removeItem(LOCAL_PLANS_KEY)
    } catch {}
  }
}

export const bootstrapGuestDataIfNeeded = async (userId: string | null | undefined): Promise<boolean> => {
  if (!userId || !supabase) {
    return false
  }
  if (bootstrapPromises.has(userId)) {
    return bootstrapPromises.get(userId) ?? false
  }
  const task = (async () => {
    const { data, error } = await supabase
      .from('profiles')
      .select('bootstrap_completed')
      .eq('id', userId)
      .maybeSingle()
    if (error) {
      throw error
    }
    if (data?.bootstrap_completed) {
      return false
    }
    if (!acquireBootstrapLock(userId)) {
      return false
    }
    await migrateGuestData()
    const { error: updateError } = await supabase
      .from('profiles')
      .update({ bootstrap_completed: true })
      .eq('id', userId)
    if (updateError) {
      releaseBootstrapLock(userId)
      throw updateError
    }
    releaseBootstrapLock(userId)
    return true
  })()
  bootstrapPromises.set(userId, task)
  try {
    return await task
  } finally {
    bootstrapPromises.delete(userId)
    releaseBootstrapLock(userId)
  }
}
