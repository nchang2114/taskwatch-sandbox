/**
 * Namespace Manager
 *
 * Single source of truth for the current user identity.
 * All domain modules read from here instead of maintaining
 * their own per-domain ownership trackers.
 *
 * - '__guest__'  — Default for unauthenticated users
 * - '<uuid>'     — Authenticated user's Supabase ID
 */

export const GUEST_USER_ID = '__guest__'

const STORAGE_KEY = 'nc-taskwatch-current-user'

// In-memory cache so reads never hit localStorage after first access
let cachedUserId: string | null = null

// Change listeners
type UserChangeCallback = (previousUserId: string, newUserId: string) => void
const listeners = new Set<UserChangeCallback>()

/**
 * Normalize a nullable/undefined user ID to a concrete string.
 * Null, undefined, or blank → GUEST_USER_ID.
 */
const normalize = (userId: string | null | undefined): string =>
  typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : GUEST_USER_ID

/**
 * Get the current user ID. Returns '__guest__' when unauthenticated.
 */
export function getCurrentUserId(): string {
  if (cachedUserId !== null) {
    return cachedUserId
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    cachedUserId = stored && stored.trim().length > 0 ? stored.trim() : GUEST_USER_ID
  } catch {
    cachedUserId = GUEST_USER_ID
  }
  return cachedUserId
}

/**
 * Set the current user ID. Pass null to switch to guest.
 * Notifies all change listeners if the value actually changed.
 */
export function setCurrentUserId(userId: string | null | undefined): void {
  const previous = getCurrentUserId()
  const next = normalize(userId)
  cachedUserId = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // localStorage unavailable — in-memory cache still works
  }
  if (previous !== next) {
    notifyListeners(previous, next)
  }
}

/**
 * Check if the current user is a guest (unauthenticated).
 */
export function isGuest(): boolean {
  return getCurrentUserId() === GUEST_USER_ID
}

/**
 * Subscribe to user changes.
 * @returns Unsubscribe function
 */
export function onUserChange(callback: UserChangeCallback): () => void {
  listeners.add(callback)
  return () => listeners.delete(callback)
}

function notifyListeners(previous: string, next: string): void {
  listeners.forEach((cb) => {
    try {
      cb(previous, next)
    } catch (error) {
      console.error('[namespaceManager] listener error:', error)
    }
  })
}
