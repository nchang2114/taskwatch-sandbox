import { GUEST_USER_ID, getCurrentUserId } from './namespaceManager'
import { openDB, STORE } from './idbStore'
import { storage } from './storage'

export type SnapbackOverviewRecord = {
  id: string
  user_id: string
  trigger_name: string
  cue_text: string
  deconstruction_text: string
  plan_text: string
  sort_index: number
  created_at: string
  updated_at: string
}

type LegacyLocalTrigger = {
  id?: string
  label?: string
  cue?: string
  deconstruction?: string
  plan?: string
}

type LegacyPlan = {
  cue?: string
  deconstruction?: string
  plan?: string
}

const cache = new Map<string, SnapbackOverviewRecord[]>()
const hydratedUsers = new Set<string>()

const createId = (prefix: string): string => {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
  } catch {}
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const deriveNameFromKey = (key: string): string => {
  const raw = key.startsWith('trigger-') ? key.slice('trigger-'.length) : key
  return asText(raw)
}

async function queryByUserId(userId: string): Promise<SnapbackOverviewRecord[]> {
  const db = await openDB()
  return new Promise<SnapbackOverviewRecord[]>((resolve, reject) => {
    const tx = db.transaction(STORE.snapbackOverview, 'readonly')
    const index = tx.objectStore(STORE.snapbackOverview).index('user_id')
    const request = index.getAll(userId)
    request.onsuccess = () => resolve(request.result as SnapbackOverviewRecord[])
    request.onerror = () => reject(request.error)
  })
}

async function deleteByUserId(userId: string): Promise<void> {
  const db = await openDB()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE.snapbackOverview, 'readwrite')
    const store = tx.objectStore(STORE.snapbackOverview)
    const index = store.index('user_id')
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

async function replaceUserRecords(userId: string, rows: SnapbackOverviewRecord[]): Promise<void> {
  const db = await openDB()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE.snapbackOverview, 'readwrite')
    const store = tx.objectStore(STORE.snapbackOverview)
    const index = store.index('user_id')
    const cursorReq = index.openKeyCursor(userId)
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (cursor) {
        store.delete(cursor.primaryKey)
        cursor.continue()
      } else {
        rows.forEach((row) => store.put(row))
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

const sortRows = (rows: SnapbackOverviewRecord[]): SnapbackOverviewRecord[] =>
  rows.slice().sort((a, b) => a.sort_index - b.sort_index)

const normalizeRowsForUser = (
  userId: string,
  rows: SnapbackOverviewRecord[],
  previous: SnapbackOverviewRecord[],
): SnapbackOverviewRecord[] => {
  const previousById = new Map(previous.map((row) => [row.id, row]))
  const nowIso = new Date().toISOString()
  const normalized: SnapbackOverviewRecord[] = []
  const seenIds = new Set<string>()
  const seenNames = new Set<string>()

  rows.forEach((candidate, index) => {
    const triggerName = asText(candidate?.trigger_name)
    if (!triggerName) {
      return
    }
    const triggerKey = triggerName.toLowerCase()
    if (seenNames.has(triggerKey)) {
      return
    }
    seenNames.add(triggerKey)
    const existing = previousById.get(candidate.id)
    const id = asText(candidate?.id) || existing?.id || createId('snapback')
    if (seenIds.has(id)) {
      return
    }
    seenIds.add(id)
    normalized.push({
      id,
      user_id: userId,
      trigger_name: triggerName,
      cue_text: typeof candidate?.cue_text === 'string' ? candidate.cue_text : existing?.cue_text ?? '',
      deconstruction_text:
        typeof candidate?.deconstruction_text === 'string'
          ? candidate.deconstruction_text
          : existing?.deconstruction_text ?? '',
      plan_text: typeof candidate?.plan_text === 'string' ? candidate.plan_text : existing?.plan_text ?? '',
      sort_index: index,
      created_at:
        typeof candidate?.created_at === 'string'
          ? candidate.created_at
          : existing?.created_at ?? nowIso,
      updated_at: nowIso,
    })
  })

  return normalized
}

const migrateLegacyGuestRows = (): SnapbackOverviewRecord[] => {
  const nowIso = new Date().toISOString()
  const rowsById = new Map<string, SnapbackOverviewRecord>()
  const nameToId = new Map<string, string>()
  const order: string[] = []

  const putRow = (input: {
    id?: string
    triggerName?: string
    cueText?: string
    deconstructionText?: string
    planText?: string
  }): void => {
    const triggerName = asText(input.triggerName)
    if (!triggerName) {
      return
    }
    const normalizedName = triggerName.toLowerCase()
    const preferredId = asText(input.id)
    const id =
      nameToId.get(normalizedName) ??
      (preferredId && !rowsById.has(preferredId) ? preferredId : '') ??
      createId('snapback')
    const resolvedId = id || createId('snapback')
    const existing = rowsById.get(resolvedId)
    if (!existing) {
      rowsById.set(resolvedId, {
        id: resolvedId,
        user_id: GUEST_USER_ID,
        trigger_name: triggerName,
        cue_text: input.cueText ?? '',
        deconstruction_text: input.deconstructionText ?? '',
        plan_text: input.planText ?? '',
        sort_index: order.length,
        created_at: nowIso,
        updated_at: nowIso,
      })
      nameToId.set(normalizedName, resolvedId)
      order.push(resolvedId)
      return
    }
    rowsById.set(resolvedId, {
      ...existing,
      cue_text: input.cueText ?? existing.cue_text,
      deconstruction_text: input.deconstructionText ?? existing.deconstruction_text,
      plan_text: input.planText ?? existing.plan_text,
      updated_at: nowIso,
    })
  }

  const localTriggersRaw = storage.guest.snapbackTriggers.get()
  const localTriggers = Array.isArray(localTriggersRaw) ? (localTriggersRaw as LegacyLocalTrigger[]) : []
  localTriggers.forEach((trigger) => {
    putRow({
      id: trigger.id,
      triggerName: trigger.label,
      cueText: typeof trigger.cue === 'string' ? trigger.cue : '',
      deconstructionText: typeof trigger.deconstruction === 'string' ? trigger.deconstruction : '',
      planText: typeof trigger.plan === 'string' ? trigger.plan : '',
    })
  })

  const localPlansRaw = storage.guest.snapPlans.get()
  const localPlans =
    localPlansRaw && typeof localPlansRaw === 'object'
      ? (localPlansRaw as Record<string, LegacyPlan>)
      : {}
  Object.entries(localPlans).forEach(([key, plan]) => {
    putRow({
      id: key,
      triggerName: deriveNameFromKey(key),
      cueText: typeof plan?.cue === 'string' ? plan.cue : '',
      deconstructionText: typeof plan?.deconstruction === 'string' ? plan.deconstruction : '',
      planText: typeof plan?.plan === 'string' ? plan.plan : '',
    })
  })

  const localCustomRaw = storage.focus.snapbackCustomTriggers.get()
  const localCustom = Array.isArray(localCustomRaw)
    ? (localCustomRaw as Array<{ id?: string; label?: string }>)
    : []
  localCustom.forEach((trigger) => {
    putRow({
      id: trigger.id,
      triggerName: trigger.label,
    })
  })

  const overviewLabelsRaw = storage.focus.overviewTriggers.get()
  const overviewLabels = Array.isArray(overviewLabelsRaw) ? (overviewLabelsRaw as string[]) : []
  overviewLabels.forEach((label) => {
    const name = asText(label)
    if (!name) {
      return
    }
    putRow({
      id: `trigger-${name}`,
      triggerName: name,
    })
  })

  return order
    .map((id, sortIndex) => {
      const row = rowsById.get(id)
      if (!row) return null
      return { ...row, sort_index: sortIndex, updated_at: nowIso }
    })
    .filter((row): row is SnapbackOverviewRecord => Boolean(row))
}

export function readSnapbackOverviewRows(userId: string): SnapbackOverviewRecord[] {
  return sortRows(cache.get(userId) ?? [])
}

export function readStoredSnapbackOverviewRows(): SnapbackOverviewRecord[] {
  return readSnapbackOverviewRows(getCurrentUserId())
}

export function writeSnapbackOverviewRows(userId: string, rows: SnapbackOverviewRecord[]): SnapbackOverviewRecord[] {
  const previous = cache.get(userId) ?? []
  const normalized = normalizeRowsForUser(userId, rows, previous)
  cache.set(userId, normalized)
  replaceUserRecords(userId, normalized).catch(() => {})
  return normalized
}

export function clearSnapbackOverviewCache(userId: string): void {
  cache.delete(userId)
  deleteByUserId(userId).catch(() => {})
}

export async function hydrateSnapbackOverview(userId: string): Promise<void> {
  if (hydratedUsers.has(userId)) {
    return
  }

  try {
    const idbRows = await queryByUserId(userId)
    if (idbRows.length > 0) {
      cache.set(userId, sortRows(idbRows))
      hydratedUsers.add(userId)
      return
    }

    if (userId === GUEST_USER_ID) {
      const migrated = migrateLegacyGuestRows()
      if (migrated.length > 0) {
        cache.set(userId, migrated)
        await replaceUserRecords(userId, migrated)
        storage.guest.snapbackTriggers.remove()
        storage.guest.snapPlans.remove()
        storage.focus.snapbackCustomTriggers.remove()
        storage.focus.overviewTriggers.remove()
        hydratedUsers.add(userId)
        return
      }
    }

    cache.set(userId, [])
    hydratedUsers.add(userId)
  } catch {
    cache.set(userId, [])
    hydratedUsers.add(userId)
  }
}
