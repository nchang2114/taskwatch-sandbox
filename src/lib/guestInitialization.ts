import { DEMO_GOALS } from './demoGoals'
import { createGoalsSnapshot, publishGoalsSnapshot } from './goalsSync'
import { assembleSnapshot, hydrateGoalsData, readQuickListTasks } from './idbGoals'
import { hydrateLifeRoutines, readLifeRoutinesFromCache } from './idbLifeRoutines'
import { readSeedState, writeSeedState } from './idbSeedState'
import { getDefaultLifeRoutines, writeStoredLifeRoutines } from './lifeRoutines'
import { GUEST_USER_ID, getCurrentUserId } from './namespaceManager'
import {
  getDefaultQuickListRecords,
  type QuickListEntry,
  writeStoredQuickList,
} from './quickList'
import {
  createSampleHistoryRecords,
  persistHistorySnapshot,
  sanitizeHistoryRecords,
  type HistoryEntry,
  type HistoryRecord,
} from './sessionHistory'
import { storage } from './storage'

const GUEST_DEFAULTS_SEED_VERSION = 1

let guestInitPromise: Promise<void> | null = null

const toQuickListEntries = (userId: string): QuickListEntry[] => {
  const { tasks, subtasks } = getDefaultQuickListRecords(userId)
  const subtasksByTask = new Map<string, typeof subtasks>()
  subtasks.forEach((subtask) => {
    const list = subtasksByTask.get(subtask.taskId) ?? []
    list.push(subtask)
    subtasksByTask.set(subtask.taskId, list)
  })
  return tasks.map((task) => ({
    ...task,
    subtasks: (subtasksByTask.get(task.id) ?? []).slice().sort((a, b) => a.sortIndex - b.sortIndex),
  }))
}

const toHistoryEntries = (records: HistoryRecord[]): HistoryEntry[] =>
  records.map((record) => {
    const { createdAt: _c, updatedAt: _u, pendingAction: _p, ...entry } = record
    return entry
  })

const seedGuestDefaults = (): void => {
  const goalsSnapshot = createGoalsSnapshot(DEMO_GOALS as any)
  publishGoalsSnapshot(goalsSnapshot, GUEST_USER_ID)

  writeStoredLifeRoutines(getDefaultLifeRoutines(), { sync: false })

  writeStoredQuickList(toQuickListEntries(GUEST_USER_ID))

  persistHistorySnapshot(toHistoryEntries(createSampleHistoryRecords()))
}

export async function ensureGuestDefaultsInitialized(userId?: string): Promise<void> {
  const targetUserId = userId ?? getCurrentUserId()
  if (targetUserId !== GUEST_USER_ID) {
    return
  }
  if (guestInitPromise) {
    return guestInitPromise
  }

  guestInitPromise = (async () => {
    try {
      await Promise.all([hydrateGoalsData(GUEST_USER_ID), hydrateLifeRoutines(GUEST_USER_ID)])

      const seedState = await readSeedState(GUEST_USER_ID).catch(() => null)
      if (seedState?.guestDefaultsSeedVersion === GUEST_DEFAULTS_SEED_VERSION) {
        return
      }

      const goalsEmpty = assembleSnapshot(GUEST_USER_ID).length === 0
      const lifeRoutinesEmpty = readLifeRoutinesFromCache(GUEST_USER_ID).length === 0
      const quickListEmpty = readQuickListTasks(GUEST_USER_ID).length === 0
      const historyEmpty = sanitizeHistoryRecords(storage.domain.history.get(GUEST_USER_ID) ?? []).length === 0

      if (goalsEmpty && lifeRoutinesEmpty && quickListEmpty && historyEmpty) {
        seedGuestDefaults()
      }

      await writeSeedState(GUEST_USER_ID, {
        guestDefaultsSeedVersion: GUEST_DEFAULTS_SEED_VERSION,
      }).catch(() => {})
    } catch {
      // Initialization is best-effort; avoid blocking app render.
    }
  })().finally(() => {
    guestInitPromise = null
  })

  return guestInitPromise
}
