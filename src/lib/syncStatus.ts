/**
 * Sync Status Management
 * 
 * Tracks online/offline state and pending sync operations.
 * Provides a reactive way for components to subscribe to sync status changes.
 */

export type SyncStatusState = 'synced' | 'syncing' | 'offline' | 'pending'

export const SYNC_STATUS_CHANGE_EVENT = 'nc-taskwatch:sync-status-change'

// Internal state
let currentOnlineState = true // Default to online, will be set properly in initSyncStatusListeners
let pendingCount = 0
let isSyncing = false
let initialized = false

/**
 * Calculate the current sync status based on online state and pending operations
 */
const calculateStatus = (): SyncStatusState => {
  if (!currentOnlineState) {
    return 'offline'
  }
  if (isSyncing) {
    return 'syncing'
  }
  if (pendingCount > 0) {
    return 'pending'
  }
  return 'synced'
}

/**
 * Dispatch a sync status change event
 */
const dispatchStatusChange = () => {
  if (typeof window === 'undefined') return
  const status = calculateStatus()
  const event = new CustomEvent<{ status: SyncStatusState; pendingCount: number }>(
    SYNC_STATUS_CHANGE_EVENT,
    { detail: { status, pendingCount } }
  )
  window.dispatchEvent(event)
}

/**
 * Get the current sync status
 */
export const getSyncStatus = (): SyncStatusState => calculateStatus()

/**
 * Get the current pending operation count
 */
export const getPendingCount = (): number => pendingCount

/**
 * Check if currently online
 */
export const isOnline = (): boolean => currentOnlineState

/**
 * Update the pending count (called by sync modules)
 */
export const setPendingCount = (count: number) => {
  const prev = pendingCount
  pendingCount = Math.max(0, count)
  if (prev !== pendingCount) {
    dispatchStatusChange()
  }
}

/**
 * Set syncing state (called when actively pushing to server)
 */
export const setSyncing = (syncing: boolean) => {
  const prev = isSyncing
  isSyncing = syncing
  if (prev !== isSyncing) {
    dispatchStatusChange()
  }
}

/**
 * Callbacks to run when coming back online
 */
const onlineCallbacks: Array<() => void> = []

/**
 * Register a callback to run when connection is restored
 */
export const onBackOnline = (callback: () => void) => {
  onlineCallbacks.push(callback)
  return () => {
    const idx = onlineCallbacks.indexOf(callback)
    if (idx !== -1) onlineCallbacks.splice(idx, 1)
  }
}

/**
 * Initialize online/offline listeners
 * Should be called once at app startup
 */
export const initSyncStatusListeners = () => {
  if (typeof window === 'undefined') return
  if (initialized) return
  initialized = true

  const handleOnline = () => {
    const wasOffline = !currentOnlineState
    currentOnlineState = true
    dispatchStatusChange()
    
    // Run registered callbacks when coming back online
    if (wasOffline) {
      onlineCallbacks.forEach(cb => {
        try { cb() } catch {}
      })
    }
  }

  const handleOffline = () => {
    currentOnlineState = false
    dispatchStatusChange()
  }

  window.addEventListener('online', handleOnline)
  window.addEventListener('offline', handleOffline)

  // Set initial state from navigator
  currentOnlineState = typeof navigator !== 'undefined' ? navigator.onLine : true
  dispatchStatusChange()
}

/**
 * Subscribe to sync status changes
 */
export const subscribeSyncStatus = (
  callback: (status: SyncStatusState, pendingCount: number) => void
): (() => void) => {
  if (typeof window === 'undefined') return () => {}

  const handler = (event: Event) => {
    const customEvent = event as CustomEvent<{ status: SyncStatusState; pendingCount: number }>
    callback(customEvent.detail.status, customEvent.detail.pendingCount)
  }

  window.addEventListener(SYNC_STATUS_CHANGE_EVENT, handler)
  
  // Immediately call with current state
  callback(calculateStatus(), pendingCount)

  return () => {
    window.removeEventListener(SYNC_STATUS_CHANGE_EVENT, handler)
  }
}
