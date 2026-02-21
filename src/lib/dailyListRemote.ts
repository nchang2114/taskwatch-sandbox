/**
 * Daily List remote sync — persists daily list entries to Supabase.
 *
 * Each entry is a lightweight reference (taskId) stored in the
 * `daily_list_entries` table. The full task data lives in `tasks`.
 */

import { ensureSingleUserSession, supabase } from './supabaseClient'
import { getCurrentUserId } from './namespaceManager'
import {
  DAILY_LIST_ID,
  writeDailyListEntries,
  readDailyListEntries,
  type DailyListEntryRecord,
} from './idbDailyList'

// ── Fetch ───────────────────────────────────────────────────────────────────

export async function fetchDailyListRemoteEntries(): Promise<DailyListEntryRecord[] | null> {
  if (!supabase) return null
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return null

  const userId = getCurrentUserId()

  const { data, error } = await supabase
    .from('daily_list_entries')
    .select('id, task_id, sort_index, added_at')
    .eq('user_id', session.user.id)
    .order('sort_index', { ascending: true })

  if (error) {
    console.warn('[dailyListRemote] fetch failed', error)
    return null
  }

  const rows = Array.isArray(data) ? data : []
  return rows.map((row) => ({
    id: row.id,
    userId,
    dailyListId: DAILY_LIST_ID,
    taskId: typeof row.task_id === 'string' ? row.task_id : '',
    sortIndex: typeof row.sort_index === 'number' ? row.sort_index : 0,
    addedAt: typeof row.added_at === 'string' ? row.added_at : new Date().toISOString(),
  }))
}

// ── Push ────────────────────────────────────────────────────────────────────

export async function pushDailyListToSupabase(entries: DailyListEntryRecord[]): Promise<void> {
  if (!supabase) return
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return

  const userId = session.user.id

  // Delete existing entries for this user
  const { error: deleteError } = await supabase
    .from('daily_list_entries')
    .delete()
    .eq('user_id', userId)

  if (deleteError) {
    console.warn('[dailyListRemote] delete failed', deleteError)
    return
  }

  if (entries.length === 0) return

  const rows = entries.map((entry) => ({
    id: entry.id,
    user_id: userId,
    daily_list_id: DAILY_LIST_ID,
    task_id: entry.taskId,
    sort_index: entry.sortIndex,
    added_at: entry.addedAt,
  }))

  const { error: insertError } = await supabase
    .from('daily_list_entries')
    .insert(rows)

  if (insertError) {
    console.warn('[dailyListRemote] insert failed', insertError)
  }
}

// ── Sync ────────────────────────────────────────────────────────────────────

/**
 * Syncs daily list from Supabase to IDB cache.
 * Called during bootstrap / runAllSyncs.
 */
export async function syncDailyListFromSupabase(): Promise<DailyListEntryRecord[] | null> {
  const session = await ensureSingleUserSession()
  if (!session?.user?.id) return null

  const remote = await fetchDailyListRemoteEntries()
  if (!remote) return null

  const userId = getCurrentUserId()
  writeDailyListEntries(userId, remote)

  console.log('[dailyListRemote] Synced', remote.length, 'daily list entries from Supabase')
  return remote
}
