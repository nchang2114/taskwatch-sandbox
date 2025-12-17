/**
 * Offline Operation Queue
 * 
 * Queues operations that failed due to being offline and replays them when back online.
 * Each operation is stored with enough context to replay it.
 */

import { isOnline, onBackOnline, setPendingCountForSource, setSyncing } from './syncStatus'

export type OfflineOperationType = 
  | 'createTask'
  | 'updateTaskText'
  | 'updateTaskCompleted'
  | 'updateTaskPriority'
  | 'updateTaskDifficulty'
  | 'updateTaskNotes'
  | 'deleteTask'
  | 'moveTask'
  | 'createSubtask'
  | 'updateSubtask'
  | 'deleteSubtask'
  | 'createBucket'
  | 'updateBucket'
  | 'updateBucketSurface'
  | 'updateBucketFavorite'
  | 'updateBucketArchived'
  | 'deleteBucket'
  | 'createGoal'
  | 'updateGoal'
  | 'updateGoalColor'
  | 'updateGoalSurface'
  | 'updateGoalStarred'
  | 'updateGoalArchived'
  | 'deleteGoal'

export type OfflineOperation = {
  id: string
  type: OfflineOperationType
  timestamp: number
  payload: Record<string, unknown>
  // For optimistic updates, we need to know the temp ID used locally
  tempId?: string
  // The actual ID after syncing (for mapping temp IDs to real IDs)
  resolvedId?: string
  // Number of retry attempts
  retries: number
  // Last error message if failed
  lastError?: string
}

const QUEUE_STORAGE_KEY = 'nc-taskwatch-offline-queue'
const MAX_RETRIES = 3

// In-memory queue for faster access
let operationQueue: OfflineOperation[] = []

// Handlers registered by goalsApi to replay operations
const operationHandlers: Map<OfflineOperationType, (op: OfflineOperation) => Promise<{ success: boolean; resolvedId?: string; error?: string }>> = new Map()

/**
 * Generate a temporary ID for optimistic updates
 */
export const generateTempId = (): string => {
  return `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Check if an ID is a temporary offline ID
 * Supports both `temp-` (queue generated) and `temp_` (UI optimistic) formats
 */
export const isTempId = (id: string): boolean => {
  return id.startsWith('temp-') || id.startsWith('temp_')
}

/**
 * Read queue from localStorage
 */
const readQueue = (): OfflineOperation[] => {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(QUEUE_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Write queue to localStorage
 */
const writeQueue = (queue: OfflineOperation[]): void => {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queue))
  } catch {}
}

/**
 * Initialize queue from localStorage
 */
export const initOfflineQueue = (): void => {
  operationQueue = readQueue()
  updatePendingCount()
}

/**
 * Update the global pending count based on queue length
 */
const updatePendingCount = (): void => {
  setPendingCountForSource('queue', operationQueue.length)
}

/**
 * Add an operation to the queue
 */
export const queueOperation = (
  type: OfflineOperationType,
  payload: Record<string, unknown>,
  tempId?: string
): OfflineOperation => {
  const operation: OfflineOperation = {
    id: `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    timestamp: Date.now(),
    payload,
    tempId,
    retries: 0,
  }
  
  operationQueue.push(operation)
  writeQueue(operationQueue)
  updatePendingCount()
  
  return operation
}

/**
 * Remove an operation from the queue (after successful sync)
 */
const removeOperation = (operationId: string): void => {
  operationQueue = operationQueue.filter(op => op.id !== operationId)
  writeQueue(operationQueue)
  updatePendingCount()
}

/**
 * Update an operation in the queue (e.g., increment retries)
 */
const updateOperation = (operationId: string, updates: Partial<OfflineOperation>): void => {
  const index = operationQueue.findIndex(op => op.id === operationId)
  if (index !== -1) {
    operationQueue[index] = { ...operationQueue[index], ...updates }
    writeQueue(operationQueue)
  }
}

/**
 * Register a handler for an operation type
 */
export const registerOperationHandler = (
  type: OfflineOperationType,
  handler: (op: OfflineOperation) => Promise<{ success: boolean; resolvedId?: string; error?: string }>
): void => {
  operationHandlers.set(type, handler)
}

/**
 * Map of temp IDs to resolved IDs (populated during sync)
 */
const tempIdMap: Map<string, string> = new Map()

/**
 * Get resolved ID for a temp ID (or return original if not temp)
 */
export const resolveId = (id: string): string => {
  if (!isTempId(id)) return id
  return tempIdMap.get(id) ?? id
}

/**
 * Process a single operation
 */
const processOperation = async (operation: OfflineOperation): Promise<boolean> => {
  const handler = operationHandlers.get(operation.type)
  if (!handler) {
    console.warn(`[offlineQueue] No handler registered for operation type: ${operation.type}`)
    console.log('[offlineQueue] Registered handlers:', Array.from(operationHandlers.keys()))
    return false
  }
  
  try {
    // Resolve any temp IDs in the payload before processing
    const resolvedPayload = { ...operation.payload }
    for (const [key, value] of Object.entries(resolvedPayload)) {
      if (typeof value === 'string' && isTempId(value)) {
        resolvedPayload[key] = resolveId(value)
      }
    }
    
    const result = await handler({ ...operation, payload: resolvedPayload })
    
    if (result.success) {
      // If we got a resolved ID, store the mapping
      if (operation.tempId && result.resolvedId) {
        tempIdMap.set(operation.tempId, result.resolvedId)
      }
      removeOperation(operation.id)
      return true
    } else {
      // Increment retry count
      const newRetries = operation.retries + 1
      if (newRetries >= MAX_RETRIES) {
        console.error(`[offlineQueue] Operation ${operation.id} failed after ${MAX_RETRIES} retries:`, result.error)
        // Remove failed operation to prevent infinite retries
        removeOperation(operation.id)
        return false
      }
      updateOperation(operation.id, { retries: newRetries, lastError: result.error })
      return false
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error(`[offlineQueue] Error processing operation ${operation.id}:`, errorMsg)
    updateOperation(operation.id, { retries: operation.retries + 1, lastError: errorMsg })
    return false
  }
}

/**
 * Get operation priority for dependency ordering
 * Lower number = higher priority (process first)
 */
const getOperationPriority = (type: OfflineOperationType): number => {
  // Goals must be created before buckets, buckets before tasks
  switch (type) {
    case 'createGoal':
      return 0
    case 'updateGoal':
    case 'updateGoalColor':
    case 'updateGoalSurface':
    case 'updateGoalStarred':
    case 'updateGoalArchived':
      return 1
    case 'createBucket':
      return 2
    case 'updateBucket':
    case 'updateBucketSurface':
    case 'updateBucketFavorite':
    case 'updateBucketArchived':
      return 3
    case 'createTask':
      return 4
    case 'updateTaskText':
    case 'updateTaskCompleted':
    case 'updateTaskPriority':
    case 'updateTaskDifficulty':
    case 'updateTaskNotes':
    case 'moveTask':
      return 5
    case 'createSubtask':
    case 'updateSubtask':
      return 6
    case 'deleteSubtask':
      return 7
    case 'deleteTask':
      return 8
    case 'deleteBucket':
      return 9
    case 'deleteGoal':
      return 10
    default:
      return 5
  }
}

/**
 * Process all queued operations in order
 */
export const processQueue = async (): Promise<void> => {
  if (!isOnline()) {
    console.log('[offlineQueue] Skipping queue processing: offline')
    return
  }
  
  if (operationQueue.length === 0) {
    console.log('[offlineQueue] Queue is empty, nothing to process')
    return
  }
  
  console.log(`[offlineQueue] Processing ${operationQueue.length} pending operations...`)
  setSyncing(true)
  
  try {
    // Sort operations by dependency order (goals first, then buckets, then tasks)
    // Also maintain timestamp order within each priority level
    const sortedQueue = [...operationQueue].sort((a, b) => {
      const priorityDiff = getOperationPriority(a.type) - getOperationPriority(b.type)
      if (priorityDiff !== 0) return priorityDiff
      return a.timestamp - b.timestamp
    })
    
    console.log('[offlineQueue] Processing order:', sortedQueue.map(op => `${op.type}(${op.tempId || 'no-temp-id'})`))
    
    for (const operation of sortedQueue) {
      if (!isOnline()) {
        // Went offline during processing, stop
        console.log('[offlineQueue] Went offline during processing, stopping')
        break
      }
      
      console.log(`[offlineQueue] Processing operation: ${operation.type}`, operation.payload)
      const success = await processOperation(operation)
      console.log(`[offlineQueue] Operation ${operation.type} ${success ? 'succeeded' : 'failed'}`)
    }
  } finally {
    setSyncing(false)
    updatePendingCount()
    console.log(`[offlineQueue] Queue processing complete. ${operationQueue.length} operations remaining.`)
  }
}

/**
 * Check if there are pending operations
 */
export const hasPendingOperations = (): boolean => {
  return operationQueue.length > 0
}

/**
 * Get the current queue (for debugging/display)
 */
export const getQueue = (): readonly OfflineOperation[] => {
  return operationQueue
}

/**
 * Clear the entire queue (use with caution)
 */
export const clearQueue = (): void => {
  operationQueue = []
  writeQueue([])
  tempIdMap.clear()
  updatePendingCount()
}

// Initialize queue from localStorage on module load
if (typeof window !== 'undefined') {
  initOfflineQueue()
  
  // Register to process queue when coming back online
  onBackOnline(() => {
    // Small delay to let the network stabilize
    setTimeout(() => {
      void processQueue()
    }, 1000)
  })
  
  // Also process queue on initial page load if online and have pending items
  // Use a longer delay to ensure all operation handlers are registered
  setTimeout(() => {
    if (isOnline() && operationQueue.length > 0) {
      console.log('[offlineQueue] Processing pending operations on page load')
      void processQueue()
    }
  }, 2000)
}

/**
 * Manually trigger queue processing (for retry button)
 */
export const retryPendingOperations = async (): Promise<void> => {
  if (!isOnline()) {
    console.warn('[offlineQueue] Cannot retry: currently offline')
    return
  }
  await processQueue()
}
