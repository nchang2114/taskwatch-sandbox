import { supabase, ensureSingleUserSession } from './supabaseClient'
import { generateUuid, syncQuickListFromSupabase } from './quickListRemote'
import {
  createTask,
  updateTaskNotes,
  setTaskDifficulty,
  setTaskPriorityAndResort,
  setTaskCompletedAndResort,
  upsertTaskSubtask,
  normalizeGoalColour,
  FALLBACK_GOAL_COLOR,
  upsertGoalMilestone,
} from './goalsApi'
import {
  getDefaultLifeRoutines,
  pushLifeRoutinesToSupabase,
  syncLifeRoutinesWithSupabase,
  type LifeRoutineConfig,
} from './lifeRoutines'
import { GUEST_USER_ID } from './namespaceManager'
import { createGoalsSnapshot, syncGoalsSnapshotFromSupabase } from './goalsSync'
import { assembleSnapshot as assembleGoalsFromCache, clearGoalsCache, readQuickListTasks, readQuickListSubtasks, clearQuickListCache, QUICK_LIST_CONTAINER_ID, type TaskRecord, type SubtaskRecord } from './idbGoals'
import { readAllMilestones, clearMilestonesCache } from './idbMilestones'
import { readLifeRoutinesFromCache, clearLifeRoutinesCache } from './idbLifeRoutines'
import { QUICK_LIST_GOAL_NAME } from './quickListRemote'
import { DEFAULT_SURFACE_STYLE, ensureServerBucketStyle } from './surfaceStyles'
import { pushSnapbackTriggersToSupabase, syncSnapbackTriggersFromSupabase, type SnapbackTriggerPayload } from './snapbackApi'
import { pushRepeatingRulesToSupabase, syncRepeatingRulesFromSupabase } from './repeatingSessions'
import { pushAllHistoryToSupabase, syncHistoryWithSupabase, sanitizeHistoryRecords } from './sessionHistory'
import { pushDailyListToSupabase, syncDailyListFromSupabase } from './dailyListRemote'
import { readDailyListEntries, clearDailyListEntries } from './idbDailyList'
import { storage } from './storage'

// Type for ID mappings returned from migrations
export type IdMaps = {
  goalIdMap: Map<string, string>
  bucketIdMap: Map<string, string>
  taskIdMap: Map<string, string>
}

// Freshness check: skip redundant fetches immediately after a full sync
const FRESHNESS_WINDOW_MS = 5000 // 5 seconds

export const setLastFullSyncTimestamp = (): void => {
  storage.locks.lastFullSync.set(String(Date.now()))
}

export const clearLastFullSyncTimestamp = (): void => {
  storage.locks.lastFullSync.remove()
}

export const isRecentlyFullSynced = (): boolean => {
  const raw = storage.locks.lastFullSync.get()
  if (!raw) return false
  const timestamp = Number(raw)
  if (!Number.isFinite(timestamp)) return false
  return Date.now() - timestamp < FRESHNESS_WINDOW_MS
}

/**
 * Runs all 5 sync functions in parallel to pull user data from Supabase into localStorage.
 * Called after localStorage.clear() during bootstrap to populate the app with user data.
 */
export const runAllSyncs = async (): Promise<void> => {
  console.log('[bootstrap] Running all syncs...')
  await Promise.all([
    syncGoalsSnapshotFromSupabase(),
    syncHistoryWithSupabase(),
    syncLifeRoutinesWithSupabase(),
    syncRepeatingRulesFromSupabase(),
    syncSnapbackTriggersFromSupabase(),
    syncQuickListFromSupabase(),
    syncDailyListFromSupabase(),
  ])
  setLastFullSyncTimestamp()
  console.log('[bootstrap] All syncs complete')
}

/**
 * Clears only app data from localStorage, preserving auth tokens.
 * All app keys start with 'nc-taskwatch-' prefix, but we exclude auth keys.
 * Called during new user bootstrap to wipe guest/demo data before syncing.
 */
export const clearAppDataFromLocalStorage = (): void => {
  console.log('[bootstrap] Clearing app data from localStorage (preserving auth)')
  storage.clearAppData()
}

/**
 * Clears ALL localStorage data including auth tokens.
 * Use this ONLY for sign-out (when you want to fully clear everything).
 * For bootstrap/sync operations, use clearAppDataFromLocalStorage() instead.
 */
export const clearAllLocalStorage = (): void => {
  console.log('[bootstrap] Clearing all localStorage')
  storage.clearAll()
}

let bootstrapPromises = new Map<string, Promise<boolean>>()
const BOOTSTRAP_LOCK_TTL_MS = 2 * 60 * 1000

const acquireBootstrapLock = (userId: string): boolean => {
  const parsed = storage.locks.bootstrapLock.get(userId)
  const now = Date.now()
  if (parsed?.expiresAt && parsed.expiresAt > now) {
    return false
  }
  const expiresAt = now + BOOTSTRAP_LOCK_TTL_MS
  storage.locks.bootstrapLock.set(userId, { expiresAt })
  return true
}

const releaseBootstrapLock = (userId: string): void => {
  storage.locks.bootstrapLock.remove(userId)
}
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const isUuid = (value: string | undefined | null): value is string => !!value && UUID_REGEX.test(value)
const ensureUuid = (value: string | undefined): string => (isUuid(value) ? value! : generateUuid())
const GOAL_SORT_STEP = 1024
const SUBTASK_SORT_STEP = 1024

const sanitizeGoalName = (value: string | undefined): string =>
  value && value.trim().length > 0 ? value.trim() : 'Personal Goal'

const sanitizeBucketName = (value: string | undefined): string =>
  value && value.trim().length > 0 ? value.trim() : 'Task List'

const sanitizeTaskText = (value: string | undefined): string | null => {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const normalizeGradient = (value: string | undefined | null): string =>
  normalizeGoalColour(value, FALLBACK_GOAL_COLOR)

const sanitizeDifficulty = (value: string | undefined): 'none' | 'green' | 'yellow' | 'red' => {
  if (value === 'green' || value === 'yellow' || value === 'red') {
    return value
  }
  return 'none'
}

const sortByIndex = (a: { sortIndex?: number }, b: { sortIndex?: number }) => {
  const left = typeof a.sortIndex === 'number' ? a.sortIndex : 0
  const right = typeof b.sortIndex === 'number' ? b.sortIndex : 0
  return left - right
}

const pushQuickListToSupabase = async (tasks: TaskRecord[], subtaskRecords: SubtaskRecord[]): Promise<void> => {
  if (!supabase || tasks.length === 0) {
    return
  }
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    throw new Error('Missing Supabase session for Quick List migration')
  }

  // Group subtasks by taskId
  const subtasksByTask = new Map<string, SubtaskRecord[]>()
  subtaskRecords.forEach((s) => {
    const list = subtasksByTask.get(s.taskId) ?? []
    list.push(s)
    subtasksByTask.set(s.taskId, list)
  })

  const ordered = [
    ...tasks.filter((t) => !t.completed).sort(sortByIndex),
    ...tasks.filter((t) => t.completed).sort(sortByIndex),
  ]
  for (const item of ordered) {
    try {
      const baseText = item.text?.trim().length ? item.text.trim() : 'Quick task'
      const created = await createTask(QUICK_LIST_CONTAINER_ID, baseText)
      const taskId = created?.id
      if (!taskId) {
        throw new Error('Failed to create Quick List task during migration')
      }
      const subs = (subtasksByTask.get(item.id) ?? []).slice().sort(sortByIndex)
      for (let idx = 0; idx < subs.length; idx += 1) {
        const sub = subs[idx]
        await upsertTaskSubtask(taskId, {
          id: ensureUuid(sub.id),
          text: sub.text,
          completed: Boolean(sub.completed),
          sort_index: typeof sub.sortIndex === 'number' ? sub.sortIndex : idx,
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
        await setTaskPriorityAndResort(taskId, QUICK_LIST_CONTAINER_ID, false, true)
      }
      if (item.completed) {
        await setTaskCompletedAndResort(taskId, QUICK_LIST_CONTAINER_ID, true)
        if (item.priority) {
          await setTaskPriorityAndResort(taskId, QUICK_LIST_CONTAINER_ID, true, true)
        }
      }
    } catch (err) {
      throw err instanceof Error ? err : new Error('Failed to migrate Quick List task')
    }
  }
}

const pushGoalsToSupabase = async (): Promise<IdMaps> => {
  const emptyMaps: IdMaps = {
    goalIdMap: new Map<string, string>(),
    bucketIdMap: new Map<string, string>(),
    taskIdMap: new Map<string, string>(),
  }
  
  // Read guest goals from IDB cache (already hydrated at boot)
  let snapshot: ReturnType<typeof createGoalsSnapshot> = []
  try {
    snapshot = assembleGoalsFromCache(GUEST_USER_ID).filter(
      (goal) => goal.name?.trim() !== QUICK_LIST_GOAL_NAME,
    )
  } catch {
    return emptyMaps
  }

  if (snapshot.length === 0) {
    return emptyMaps
  }
  if (!supabase) {
    throw new Error('Supabase client unavailable for goals migration')
  }
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) {
    throw new Error('Missing Supabase session for goals migration')
  }
  const userId = session.user.id

  const goalIdMap = new Map<string, string>()
  const bucketIdMap = new Map<string, string>()
  const taskIdMap = new Map<string, string>()
  const goalRows: Array<Record<string, any>> = []
  const bucketRows: Array<Record<string, any>> = []
  const taskRows: Array<Record<string, any>> = []
  const subtaskRows: Array<Record<string, any>> = []

  snapshot.forEach((goal, goalIndex) => {
    const goalId = (() => {
      if (goal.id && goalIdMap.has(goal.id)) {
        return goalIdMap.get(goal.id)!
      }
      const generated = ensureUuid(goal.id)
      if (goal.id) {
        goalIdMap.set(goal.id, generated)
      }
      return generated
    })()
    goalRows.push({
      id: goalId,
      user_id: userId,
      name: sanitizeGoalName(goal.name),
      goal_colour: normalizeGradient((goal as any).goalColour ?? (goal as any).goal_colour),
      sort_index: (goalIndex + 1) * GOAL_SORT_STEP,
      starred: Boolean(goal.starred),
      goal_archive: Boolean(goal.archived),
      milestones_shown: typeof (goal as any).milestonesShown === 'boolean' ? (goal as any).milestonesShown : null,
    })
    ;(goal.buckets ?? []).forEach((bucket, bucketIndex) => {
      const bucketId = (() => {
        if (bucket.id && bucketIdMap.has(bucket.id)) {
          return bucketIdMap.get(bucket.id)!
        }
        const generated = ensureUuid(bucket.id)
        if (bucket.id) {
          bucketIdMap.set(bucket.id, generated)
        }
        return generated
      })()
      const surfaceStyle = ensureServerBucketStyle(bucket.surfaceStyle, DEFAULT_SURFACE_STYLE)
      bucketRows.push({
        id: bucketId,
        user_id: userId,
        goal_id: goalId,
        name: sanitizeBucketName(bucket.name),
        favorite: Boolean(bucket.favorite),
        sort_index: (bucketIndex + 1) * GOAL_SORT_STEP,
        buckets_card_style: surfaceStyle,
        bucket_archive: Boolean(bucket.archived),
      })
      ;(bucket.tasks ?? []).forEach((task, taskIndex) => {
        const text = sanitizeTaskText(task.text)
        if (!text) {
          return
        }
        const taskId = (() => {
          if (task.id && taskIdMap.has(task.id)) {
            return taskIdMap.get(task.id)!
          }
          const generated = ensureUuid(task.id)
          if (task.id) {
            taskIdMap.set(task.id, generated)
          }
          return generated
        })()
        taskRows.push({
          id: taskId,
          user_id: userId,
          container_id: bucketId,
          text,
          completed: Boolean(task.completed),
          difficulty: sanitizeDifficulty(task.difficulty),
          priority: Boolean(task.priority),
          sort_index: (taskIndex + 1) * GOAL_SORT_STEP,
          notes: typeof task.notes === 'string' ? task.notes : '',
        })
        ;(task.subtasks ?? []).forEach((subtask, subIndex) => {
          const subText = sanitizeTaskText(subtask.text)
          if (!subText) {
            return
          }
          subtaskRows.push({
            id: ensureUuid(subtask.id),
            user_id: userId,
            task_id: taskId,
            text: subText,
            completed: Boolean(subtask.completed),
            sort_index:
              typeof subtask.sortIndex === 'number' ? subtask.sortIndex : (subIndex + 1) * SUBTASK_SORT_STEP,
          })
        })
      })
    })
  })

  if (goalRows.length > 0) {
    const { error } = await supabase.from('goals').insert(goalRows)
    if (error) {
      throw error
    }
  }
  if (bucketRows.length > 0) {
    const { error } = await supabase.from('buckets').insert(bucketRows)
    if (error) {
      const code = String((error as any)?.code || '')
      if (code === '23514') {
        // Retry with null surface styles to satisfy strict server checks
        const fallbackRows = bucketRows.map((row) => ({ ...row, buckets_card_style: null }))
        const { error: retryError } = await supabase.from('buckets').insert(fallbackRows)
        if (retryError) {
          throw retryError
        }
      } else {
        throw error
      }
    }
  }
  if (taskRows.length > 0) {
    const { error } = await supabase.from('tasks').insert(taskRows)
    if (error) {
      throw error
    }
  }
  if (subtaskRows.length > 0) {
    const { error } = await supabase.from('task_subtasks').insert(subtaskRows)
    if (error) {
      throw error
    }
  }
  
  return { goalIdMap, bucketIdMap, taskIdMap }
}

// Push milestones from localStorage to DB, remapping goal IDs
const pushMilestonesToSupabase = async (goalIdMap: Map<string, string>): Promise<void> => {
  if (typeof window === 'undefined' || !supabase) return
  
  const map = readAllMilestones(GUEST_USER_ID)
  const goalIds = Object.keys(map)
  if (goalIds.length === 0) return

  try {
    for (const [oldGoalId, milestones] of Object.entries(map)) {
      // Remap the goal ID
      const newGoalId = goalIdMap.get(oldGoalId) ?? oldGoalId
      // Skip if goal wasn't migrated (no mapping exists and ID isn't a valid UUID)
      if (!isUuid(newGoalId)) continue

      for (const milestone of milestones) {
        await upsertGoalMilestone(newGoalId, {
          id: ensureUuid(milestone.id),
          name: milestone.name,
          date: milestone.date,
          completed: milestone.completed,
          role: milestone.role,
          hidden: milestone.hidden,
        })
      }
    }

    console.log('[bootstrap] Migrated milestones for', goalIds.length, 'goals')
  } catch (e) {
    console.warn('[bootstrap] Could not migrate milestones:', e)
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
 */
const migrateGuestData = async (): Promise<void> => {
  // 1. Push goals/buckets/tasks to Supabase and get ID mappings
  const { goalIdMap, bucketIdMap, taskIdMap } = await pushGoalsToSupabase()
  console.log('[bootstrap] Goals migration complete. ID maps:', {
    goals: goalIdMap.size,
    buckets: bucketIdMap.size,
    tasks: taskIdMap.size,
  })

  // CRITICAL: Clear goals data immediately after migration
  // The snapshot has demo IDs that will cause 400 errors if used
  clearGoalsCache(GUEST_USER_ID)
  storage.bootstrap.snapshotGoals.remove()

  // 2. Push milestones to Supabase (using goal ID map)
  await pushMilestonesToSupabase(goalIdMap)

  // 3. Migrate repeating rules and get rule ID map
  // Read directly from the guest key (not the current user's key)
  const guestRules = storage.domain.repeatingRules.get(GUEST_USER_ID)

  let rules: { id: string; [key: string]: unknown }[] = []
  if (guestRules && Array.isArray(guestRules)) {
    rules = guestRules.filter((r: unknown) => r && typeof r === 'object' && typeof (r as any).id === 'string')
    console.log('[bootstrap] Found', rules.length, 'guest repeating rules to migrate')
  }
  
  let ruleIdMap: Record<string, string> = {}
  if (rules.length > 0) {
    console.log('[bootstrap] Migrating', rules.length, 'repeating rules')
    ruleIdMap = await pushRepeatingRulesToSupabase(rules as any, { strict: true })
    console.log('[bootstrap] Repeating rules migrated. ID remaps:', Object.keys(ruleIdMap).length)
  }

  // 4. Migrate session history with all ID mappings
  // Read directly from the guest key (not the current user's key)
  const guestHistory = storage.domain.history.get(GUEST_USER_ID)

  let guestHistoryRecords: ReturnType<typeof sanitizeHistoryRecords> = []
  if (guestHistory) {
    guestHistoryRecords = sanitizeHistoryRecords(guestHistory)
    console.log('[bootstrap] Found', guestHistoryRecords.length, 'guest history records to migrate')
  }
  
  // Convert Maps to Records for the history function
  const goalIdRecord: Record<string, string> = Object.fromEntries(goalIdMap)
  const bucketIdRecord: Record<string, string> = Object.fromEntries(bucketIdMap)
  const taskIdRecord: Record<string, string> = Object.fromEntries(taskIdMap)
  
  await pushAllHistoryToSupabase(
    ruleIdMap,
    undefined,
    { 
      skipRemoteCheck: true, 
      strict: true,
      goalIdMap: goalIdRecord,
      bucketIdMap: bucketIdRecord,
      taskIdMap: taskIdRecord,
      sourceRecords: guestHistoryRecords.length > 0 ? guestHistoryRecords : undefined,
    }
  )
  console.log('[bootstrap] Session history migration complete')

  // Read from snapshot first (created at sign-up), fall back to IDB cache
  const snapshotRoutines = storage.bootstrap.snapshotLifeRoutines.get()
  const guestRoutines = !snapshotRoutines ? readLifeRoutinesFromCache(GUEST_USER_ID) : null
  const routinesData = snapshotRoutines || guestRoutines

  console.log('[bootstrap] Life routines migration:', {
    hasSnapshot: !!snapshotRoutines,
    hasGuestData: !!guestRoutines,
    usingSource: snapshotRoutines ? 'snapshot' : guestRoutines ? 'guest' : 'none',
  })

  // Validate - ONLY use snapshot or guest data, never fallback to current user
  let routines: LifeRoutineConfig[] = []
  if (routinesData && Array.isArray(routinesData) && routinesData.length > 0) {
    routines = routinesData
    console.log('[bootstrap] Migrating', routines.length, 'life routines')
  }
  // Fresh-account seeding: if no guest routines exist, seed defaults once during bootstrap.
  if (routines.length === 0) {
    routines = getDefaultLifeRoutines()
    console.log('[bootstrap] Seeding default life routines for fresh account:', routines.length)
  }
  
  // Clear snapshots after reading
  storage.bootstrap.snapshotLifeRoutines.remove()
  storage.bootstrap.snapshotQuickList.remove()
  storage.bootstrap.snapshotGoals.remove()
  storage.bootstrap.snapshotHistory.remove()
  storage.bootstrap.snapshotRepeating.remove()
  
  await pushLifeRoutinesToSupabase(routines, { strict: true, skipOrphanDelete: true })

  // Read quick list from IDB cache (already hydrated/migrated at boot)
  const qlTasks = readQuickListTasks(GUEST_USER_ID)
  const qlSubtasks = readQuickListSubtasks(GUEST_USER_ID)

  console.log('[bootstrap] Quick list migration:', {
    taskCount: qlTasks.length,
    subtaskCount: qlSubtasks.length,
  })

  if (qlTasks.length > 0) {
    await pushQuickListToSupabase(qlTasks, qlSubtasks)
  }

  // Migrate Daily List entries
  const guestDailyEntries = readDailyListEntries(GUEST_USER_ID)
  if (guestDailyEntries.length > 0) {
    console.log('[bootstrap] Migrating', guestDailyEntries.length, 'daily list entries')
    await pushDailyListToSupabase(guestDailyEntries)
  }

  // Migrate Snapback triggers and plans
  type LocalTrigger = { id: string; label: string; cue: string; deconstruction: string; plan: string }
  type LocalPlan = { cue: string; deconstruction: string; plan: string }

  let localTriggers: LocalTrigger[] = []
  let localPlans: Record<string, LocalPlan> = {}

  // Read local triggers (custom triggers created by guest)
  const triggersData = storage.guest.snapbackTriggers.get()
  if (triggersData && Array.isArray(triggersData)) {
    localTriggers = triggersData
    console.log('[bootstrap] Found', localTriggers.length, 'local snapback triggers')
  }

  // Read local plans (plans for history-derived triggers like Doomscrolling)
  const plansData = storage.guest.snapPlans.get()
  if (plansData && typeof plansData === 'object') {
    localPlans = plansData
    console.log('[bootstrap] Found local snapback plans for', Object.keys(localPlans).length, 'triggers')
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
  
  if (triggersToMigrate.length > 0) {
    console.log('[bootstrap] Migrating', triggersToMigrate.length, 'snapback triggers to DB')
    await pushSnapbackTriggersToSupabase(triggersToMigrate, { skipDuplicateCheck: true })
  }
  
  // Clear all guest data after successful migration
  // This ensures sign-out will show fresh defaults
  clearLifeRoutinesCache('__guest__')
  clearMilestonesCache('__guest__')
  clearQuickListCache('__guest__')
  clearDailyListEntries('__guest__')
  storage.domain.history.remove('__guest__')
  storage.domain.repeatingRules.remove('__guest__')
  clearGoalsCache('__guest__')
  // Clear snapback guest data
  storage.guest.snapbackTriggers.remove()
  storage.guest.snapPlans.remove()
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
    
    const alreadyBootstrapped = Boolean(data?.bootstrap_completed)
    
    if (alreadyBootstrapped) {
      // User already bootstrapped (returning user on page refresh)
      // Just sync to pick up any changes from other devices - don't clear anything
      console.log('[bootstrap] User already bootstrapped, syncing from DB')
      await runAllSyncs()
      return false
    }
    
    // New user: migrate guest data first
    if (!acquireBootstrapLock(userId)) {
      // Another tab is handling bootstrap, just sync
      console.log('[bootstrap] Another tab is bootstrapping, syncing from DB')
      await runAllSyncs()
      return false
    }
    
    try {
      // Migrate guest data to DB
      await migrateGuestData()
      
      // Mark bootstrap as complete
      const { error: updateError } = await supabase
        .from('profiles')
        .update({ bootstrap_completed: true })
        .eq('id', userId)
      if (updateError) {
        throw updateError
      }
      
      // Clear app data (not auth!) and sync fresh data from DB
      console.log('[bootstrap] Migration complete, clearing app data and syncing from DB')
      clearAppDataFromLocalStorage()
      await runAllSyncs()
      
      return true
    } finally {
      releaseBootstrapLock(userId)
    }
  })()
  bootstrapPromises.set(userId, task)
  try {
    return await task
  } finally {
    bootstrapPromises.delete(userId)
  }
}
