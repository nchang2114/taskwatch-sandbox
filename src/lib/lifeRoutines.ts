import { supabase, ensureSingleUserSession } from './supabaseClient'
import { DEFAULT_SURFACE_STYLE, ensureSurfaceStyle, type SurfaceStyle } from './surfaceStyles'

export type LifeRoutineConfig = {
  id: string
  title: string
  blurb: string
  surfaceStyle: SurfaceStyle
  sortIndex: number
}

const SURFACE_GRADIENTS: Record<SurfaceStyle, string> = {
  glass: 'linear-gradient(135deg, #313c67 0%, #1f2952 45%, #121830 100%)',
  midnight: 'linear-gradient(135deg, #8e9bff 0%, #6c86ff 45%, #3f51b5 100%)',
  coastal: 'linear-gradient(135deg, #97e3ff 0%, #5ec0ff 45%, #1f7adb 100%)',
  cherry: 'linear-gradient(135deg, #ffb8d5 0%, #f472b6 45%, #be3a84 100%)',
  linen: 'linear-gradient(135deg, #ffd4aa 0%, #f9a84f 45%, #d97706 100%)',
  frost: 'linear-gradient(135deg, #aee9ff 0%, #6dd3ff 45%, #1d9bf0 100%)',
  grove: 'linear-gradient(135deg, #baf5d8 0%, #4ade80 45%, #15803d 100%)',
  lagoon: 'linear-gradient(135deg, #a7dcff 0%, #60a5fa 45%, #2563eb 100%)',
  ember: 'linear-gradient(135deg, #ffd5b5 0%, #fb923c 45%, #c2410c 100%)',
  'deep-indigo': 'linear-gradient(135deg, #b4b8ff 0%, #6a6ee8 45%, #2c2f7a 100%)',
  'warm-amber': 'linear-gradient(135deg, #ffe6b3 0%, #fbbf24 45%, #b45309 100%)',
  'fresh-teal': 'linear-gradient(135deg, #99f6e4 0%, #2dd4bf 45%, #0f766e 100%)',
  'sunset-orange': 'linear-gradient(135deg, #ffc6b3 0%, #fb8a72 45%, #e1532e 100%)',
  'cool-blue': 'linear-gradient(135deg, #cfe8ff 0%, #60a5fa 45%, #1e40af 100%)',
  'soft-magenta': 'linear-gradient(135deg, #ffd1f4 0%, #f472b6 45%, #a21caf 100%)',
  'muted-lavender': 'linear-gradient(135deg, #e9e1ff 0%, #c4b5fd 45%, #6d28d9 100%)',
  'neutral-grey-blue': 'linear-gradient(135deg, #e2e8f0 0%, #94a3b8 45%, #475569 100%)',
  leaf: 'linear-gradient(135deg, #a4eec4 0%, #4ade80 45%, #15803d 100%)',
  sprout: 'linear-gradient(135deg, #bdf7d3 0%, #22c55e 45%, #166534 100%)',
  fern: 'linear-gradient(135deg, #c8f7da 0%, #16a34a 45%, #14532d 100%)',
  sage: 'linear-gradient(135deg, #d6f4e0 0%, #84cc16 45%, #4d7c0f 100%)',
  meadow: 'linear-gradient(135deg, #e0f7d6 0%, #65a30d 45%, #3f6212 100%)',
  willow: 'linear-gradient(135deg, #e5f6e0 0%, #22c55e 45%, #15803d 100%)',
  pine: 'linear-gradient(135deg, #d9f5e6 0%, #15803d 45%, #0f3d23 100%)',
  basil: 'linear-gradient(135deg, #e3f8e7 0%, #16a34a 45%, #166534 100%)',
  mint: 'linear-gradient(135deg, #d5f7ef 0%, #22c55e 45%, #0f766e 100%)',
  coral: 'linear-gradient(135deg, #ffd6c9 0%, #fb8a72 45%, #e1532e 100%)',
  peach: 'linear-gradient(135deg, #ffe1c7 0%, #fbbf24 45%, #d97706 100%)',
  apricot: 'linear-gradient(135deg, #ffe5cf 0%, #f59e0b 45%, #b45309 100%)',
  salmon: 'linear-gradient(135deg, #ffd1c7 0%, #fb8a72 45%, #e1532e 100%)',
  tangerine: 'linear-gradient(135deg, #ffe0c2 0%, #f97316 45%, #c2410c 100%)',
  papaya: 'linear-gradient(135deg, #ffe7d0 0%, #fb923c 45%, #c2410c 100%)',
}

const gradientFromSurface = (surface: SurfaceStyle | null | undefined): string =>
  (surface && SURFACE_GRADIENTS[surface]) || 'linear-gradient(135deg, #FFF8BF 0%, #FFF8BF 100%)'

const surfaceStyleFromColour = (colour: string | null | undefined): SurfaceStyle => {
  if (typeof colour !== 'string') return DEFAULT_SURFACE_STYLE
  const normalized = colour.trim().toLowerCase()
  const match = (Object.entries(SURFACE_GRADIENTS) as Array<[SurfaceStyle, string]>).find(
    ([, gradient]) => gradient.toLowerCase() === normalized,
  )
  return match ? match[0] : DEFAULT_SURFACE_STYLE
}

import { getCurrentUserId, GUEST_USER_ID, onUserChange } from './namespaceManager'
import { hydrateLifeRoutines, readLifeRoutinesFromCache, writeLifeRoutinesToCache } from './idbLifeRoutines'

export const LIFE_ROUTINE_UPDATE_EVENT = 'nc-life-routines:updated'
/** @deprecated Use GUEST_USER_ID from namespaceManager instead */
export const LIFE_ROUTINE_GUEST_USER_ID = GUEST_USER_ID
export const LIFE_ROUTINE_USER_EVENT = 'nc-life-routines:user-updated'

const cloneRoutine = (routine: LifeRoutineConfig): LifeRoutineConfig => ({ ...routine })

const LIFE_ROUTINE_DEFAULTS: LifeRoutineConfig[] = [
  {
    id: 'life-sleep',
    title: 'Sleep',
    blurb: 'Wind-down rituals, lights-out target, and no-screens buffer.',
    surfaceStyle: 'midnight',
    sortIndex: 0,
  },
  {
    id: 'life-cook',
    title: 'Cook/Eat',
    blurb: 'Prep staples, plan groceries, and keep easy meals ready.',
    surfaceStyle: 'grove',
    sortIndex: 1,
  },
  {
    id: 'life-travel',
    title: 'Travel',
    blurb: 'Commutes, drives, and any time you’re physically getting from A to B.',
    surfaceStyle: 'cool-blue',
    sortIndex: 2,
  },
  {
    id: 'life-mindfulness',
    title: 'Mindfulness',
    blurb: 'Breathwork, journaling prompts, and quick resets.',
    surfaceStyle: 'muted-lavender',
    sortIndex: 3,
  },
  {
    id: 'life-admin',
    title: 'Life Admin',
    blurb: 'Inbox zero, bills, and those small adulting loops.',
    surfaceStyle: 'neutral-grey-blue',
    sortIndex: 4,
  },
  {
    id: 'life-nature',
    title: 'Nature',
    blurb: 'Walks outside, sunlight breaks, or a weekend trail plan.',
    surfaceStyle: 'fresh-teal',
    sortIndex: 5,
  },
  {
    id: 'life-socials',
    title: 'Socials',
    blurb: 'Reach out to friends, plan hangs, and reply to messages.',
    surfaceStyle: 'sunset-orange',
    sortIndex: 6,
  },
  {
    id: 'life-relationships',
    title: 'Relationships',
    blurb: 'Date nights, check-ins, and celebrate the small stuff.',
    surfaceStyle: 'soft-magenta',
    sortIndex: 7,
  },
  {
    id: 'life-chill',
    title: 'Chill',
    blurb: 'Reading sessions, board games, or general downtime.',
    surfaceStyle: 'deep-indigo',
    sortIndex: 8,
  },
]

export const getDefaultLifeRoutines = (): LifeRoutineConfig[] =>
  LIFE_ROUTINE_DEFAULTS.map((routine, index) =>
    cloneRoutine({
      ...routine,
      sortIndex: index,
    }),
  )

const sanitizeLifeRoutine = (value: unknown): LifeRoutineConfig | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!id) {
    return null
  }
  const titleRaw = typeof record.title === 'string' ? record.title.trim() : ''
  const blurbRaw = typeof record.blurb === 'string' ? record.blurb.trim() : ''
  const surfaceStyle = ensureSurfaceStyle(record.surfaceStyle, DEFAULT_SURFACE_STYLE)
  const sortIndex = typeof record.sortIndex === 'number' && Number.isFinite(record.sortIndex) ? record.sortIndex : 0

  return {
    id,
    title: titleRaw || 'Routine',
    blurb: blurbRaw || '',
    surfaceStyle,
    sortIndex,
  }
}

export const sanitizeLifeRoutineList = (value: unknown): LifeRoutineConfig[] => {
  // If nothing stored or provided, return an empty list; seeding is handled explicitly elsewhere.
  if (!Array.isArray(value)) {
    return []
  }
  // Otherwise, respect the user’s customized list exactly (including empty = user removed all)
  const seen = new Set<string>()
  const result: LifeRoutineConfig[] = []
  for (const entry of value) {
    const routine = sanitizeLifeRoutine(entry)
    if (!routine) continue
    if (seen.has(routine.id)) continue
    seen.add(routine.id)
    result.push(cloneRoutine(routine))
  }
  // Preserve empty if user intentionally removed all
  return result.map((routine, index) => ({
    ...cloneRoutine(routine),
    sortIndex: index,
  }))
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ensureRoutineId = (id: string | undefined | null): string => {
  if (id && UUID_REGEX.test(id)) {
    return id
  }
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
  } catch {}
  return `routine-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

type LifeRoutineDbRow = {
  id: string
  title?: string | null
  blurb?: string | null
  surface_colour?: string | null
  sort_index?: number | null
}

const storeLifeRoutinesLocal = (routines: LifeRoutineConfig[], userId?: string | null): LifeRoutineConfig[] => {
  // Ensure all routines have stable UUIDs before storing
  const normalized = routines.map((routine) => {
    const id = ensureRoutineId(routine.id)
    return {
      ...cloneRoutine(routine),
      id,
    }
  })
  
  if (typeof window !== 'undefined') {
    try {
      writeLifeRoutinesToCache(userId ?? getCurrentUserId(), normalized)
      window.dispatchEvent(new CustomEvent(LIFE_ROUTINE_UPDATE_EVENT, { detail: normalized }))
    } catch {
      // ignore storage errors
    }
  }
  return normalized
}

// Cross-tab sync for life routines removed — IDB is now the primary store.
// Cross-tab sync will be added back via BroadcastChannel in a future step.



export const readLifeRoutineOwnerId = (): string => getCurrentUserId()

// Read raw local value without default seeding; returns empty array when absent
const readRawLifeRoutinesLocal = (userId?: string | null): LifeRoutineConfig[] => {
  return readLifeRoutinesFromCache(userId ?? getCurrentUserId())
}

const mapDbRowToRoutine = (row: LifeRoutineDbRow): LifeRoutineConfig | null => {
  const id = typeof row.id === 'string' ? row.id : null
  const title = typeof row.title === 'string' ? row.title : null
  if (!id || !title) {
    return null
  }
  const blurb = typeof row.blurb === 'string' ? row.blurb : ''
  const surfaceColourRaw = typeof (row as any).surface_colour === 'string' ? ((row as any).surface_colour as string) : null
  const surfaceStyle = surfaceStyleFromColour(surfaceColourRaw)
  const sortIndex = typeof row.sort_index === 'number' && Number.isFinite(row.sort_index) ? row.sort_index : 0
  return {
    id,
    title,
    blurb,
    surfaceStyle,
    sortIndex,
  }
}

export const pushLifeRoutinesToSupabase = async (
  routines: LifeRoutineConfig[],
  options?: { strict?: boolean; skipOrphanDelete?: boolean },
): Promise<void> => {
  const strict = Boolean(options?.strict)
  const skipOrphanDelete = Boolean(options?.skipOrphanDelete)
  const fail = (message: string, err?: unknown) => {
    if (strict) {
      throw err instanceof Error ? err : new Error(message)
    }
  }
  if (!supabase) {
    fail('Supabase client unavailable')
    return
  }
  const session = await ensureSingleUserSession()
  if (!session) {
    fail('No Supabase session for life routines sync')
    return
  }

  const normalized = sanitizeLifeRoutineList(routines).map((routine) => ({
    ...routine,
    id: ensureRoutineId(routine.id),
  }))

  // Don't write back to localStorage here - it would trigger storage events
  // and create an infinite sync loop across tabs
  
  const rows = normalized.map((routine, index) => ({
    id: routine.id,
    user_id: session.user.id,
    title: routine.title,
    blurb: routine.blurb,
    surface_colour: gradientFromSurface(routine.surfaceStyle),
    sort_index: index,
  }))

  const { data: remoteIdsData, error: remoteIdsError } = await supabase
    .from('life_routines')
    .select('id')
    .eq('user_id', session.user.id)

  if (remoteIdsError) {
    fail('Failed to load remote life routines', remoteIdsError)
    return
  }

  if (rows.length > 0) {
    const { error: upsertError } = await supabase.from('life_routines').upsert(rows, { onConflict: 'id' })
    if (upsertError) {
      fail('Failed to upsert life routines', upsertError)
      return
    }
  }

  // Skip orphan deletion during bootstrap (no remote data exists yet)
  if (skipOrphanDelete) {
    return
  }

  const remoteIds = new Set((remoteIdsData ?? []).map((row) => row.id))
  const localIds = new Set(rows.map((row) => row.id))
  const idsToDelete: string[] = []
  remoteIds.forEach((id) => {
    if (!localIds.has(id)) {
      idsToDelete.push(id)
    }
  })
  if (idsToDelete.length > 0) {
    const { error: deleteError } = await supabase.from('life_routines').delete().in('id', idsToDelete)
    if (deleteError) {
      fail('Failed to prune remote life routines', deleteError)
    }
  }
}

export const readStoredLifeRoutines = (): LifeRoutineConfig[] => {
  if (typeof window === 'undefined') {
    return []
  }
  try {
    const parsed = readLifeRoutinesFromCache(getCurrentUserId())
    if (parsed.length === 0) {
      return []
    }
    const sanitized = sanitizeLifeRoutineList(parsed)
    if (sanitized.length > 0) {
      return sanitized
    }
    return []
  } catch {
    return []
  }
}

export const writeStoredLifeRoutines = (
  routines: LifeRoutineConfig[],
  options?: { sync?: boolean },
): LifeRoutineConfig[] => {
  const { sync = true } = options ?? {}
  const sanitized = sanitizeLifeRoutineList(routines)
  const stored = storeLifeRoutinesLocal(sanitized)
  if (sync) {
    void pushLifeRoutinesToSupabase(stored)
  }
  return stored
}

// Namespace change listener: refresh life-routine state for the active user.
if (typeof window !== 'undefined') {
  onUserChange((_previous, next) => {
    if (next === GUEST_USER_ID) {
      // Hydrate guest cache before dispatching so listeners read the latest
      // guest routines (which may be intentionally empty).
      void (async () => {
        try {
          await hydrateLifeRoutines(GUEST_USER_ID)
        } catch {
          // Ignore hydration errors; listeners will read best-effort state.
        }
        try {
          window.dispatchEvent(new Event(LIFE_ROUTINE_USER_EVENT))
        } catch {}
      })()
      return
    }
    try {
      window.dispatchEvent(new Event(LIFE_ROUTINE_USER_EVENT))
    } catch {}
  })
}

export const syncLifeRoutinesWithSupabase = async (): Promise<LifeRoutineConfig[] | null> => {
  if (!supabase) {
    return []
  }
  const session = await ensureSingleUserSession()
  if (!session) {
    return null
  }

  // Ensure the in-memory cache is populated for this user before deciding
  // whether local or remote should win. This prevents false "empty local"
  // reads during startup/user alignment races.
  try {
    await hydrateLifeRoutines(session.user.id)
  } catch {
    // Non-fatal: continue and fall back to existing cache read behavior.
  }
  
  const localRaw = readRawLifeRoutinesLocal(session.user.id)
  const localSanitized = sanitizeLifeRoutineList(Array.isArray(localRaw) ? localRaw : [])

  // Local always wins when it has data — push to remote so other devices converge.
  if (localSanitized.length > 0) {
    const stored = storeLifeRoutinesLocal(localSanitized, session.user.id)
    void pushLifeRoutinesToSupabase(stored)
    return stored
  }

  // Local empty — pull from remote.
  const { data, error } = await supabase
    .from('life_routines')
    .select('id, title, blurb, surface_colour, sort_index')
    .eq('user_id', session.user.id)
    .order('sort_index', { ascending: true })

  if (error) {
    return null
  }

  const remoteRows = data ?? []
  if (remoteRows.length > 0) {
    const mapped = remoteRows
      .map((row) => mapDbRowToRoutine(row as LifeRoutineDbRow))
      .filter((routine): routine is LifeRoutineConfig => Boolean(routine))
    const sanitized = sanitizeLifeRoutineList(mapped)
    return storeLifeRoutinesLocal(sanitized, session.user.id)
  }

  // Both empty: keep empty. Default seeding is handled only during
  // first-time account bootstrap in bootstrap.ts.
  return storeLifeRoutinesLocal([], session.user.id)
}
