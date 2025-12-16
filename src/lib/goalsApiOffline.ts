/**
 * Offline-aware Goals API
 * 
 * Wraps goalsApi functions to:
 * 1. Update local state immediately (optimistic updates)
 * 2. Queue operations when offline
 * 3. Sync to server when online
 * 
 * This module provides the same API surface as goalsApi but with offline support.
 */

import { isOnline } from './syncStatus'
import {
  queueOperation,
  registerOperationHandler,
  generateTempId,
  isTempId,
  resolveId,
  type OfflineOperation,
} from './offlineQueue'
import {
  readStoredGoalsSnapshot,
  publishGoalsSnapshot,
  type GoalSnapshot,
  type GoalBucketSnapshot,
  type GoalTaskSnapshot,
  type GoalTaskSubtaskSnapshot,
} from './goalsSync'
import {
  createTask as apiCreateTask,
  updateTaskText as apiUpdateTaskText,
  setTaskCompletedAndResort as apiSetTaskCompletedAndResort,
  setTaskPriorityAndResort as apiSetTaskPriorityAndResort,
  setTaskDifficulty as apiSetTaskDifficulty,
  updateTaskNotes as apiUpdateTaskNotes,
  deleteTaskById as apiDeleteTask,
  moveTaskToBucket as apiMoveTaskToBucket,
  upsertTaskSubtask as apiUpsertTaskSubtask,
  deleteTaskSubtask as apiDeleteTaskSubtask,
  type DbTask,
} from './goalsApi'

// ============================================================================
// Helper functions for updating local snapshot
// ============================================================================

/**
 * Find a task in the goals snapshot
 */
const findTaskInSnapshot = (
  snapshot: GoalSnapshot[],
  taskId: string
): { goal: GoalSnapshot; bucket: GoalBucketSnapshot; task: GoalTaskSnapshot; taskIndex: number } | null => {
  for (const goal of snapshot) {
    for (const bucket of goal.buckets) {
      const taskIndex = bucket.tasks.findIndex(t => t.id === taskId)
      if (taskIndex !== -1) {
        return { goal, bucket, task: bucket.tasks[taskIndex], taskIndex }
      }
    }
  }
  return null
}

/**
 * Find a bucket in the goals snapshot
 */
const findBucketInSnapshot = (
  snapshot: GoalSnapshot[],
  bucketId: string
): { goal: GoalSnapshot; bucket: GoalBucketSnapshot; bucketIndex: number } | null => {
  for (const goal of snapshot) {
    const bucketIndex = goal.buckets.findIndex(b => b.id === bucketId)
    if (bucketIndex !== -1) {
      return { goal, bucket: goal.buckets[bucketIndex], bucketIndex }
    }
  }
  return null
}

/**
 * Deep clone a goals snapshot for modification
 */
const cloneSnapshot = (snapshot: GoalSnapshot[]): GoalSnapshot[] => {
  return JSON.parse(JSON.stringify(snapshot))
}

/**
 * Update the local snapshot and publish changes
 */
const updateLocalSnapshot = (updater: (snapshot: GoalSnapshot[]) => GoalSnapshot[]): GoalSnapshot[] => {
  const current = readStoredGoalsSnapshot()
  const updated = updater(cloneSnapshot(current))
  publishGoalsSnapshot(updated)
  return updated
}

// ============================================================================
// Offline-aware API functions
// ============================================================================

/**
 * Create a new task
 */
export async function createTask(
  bucketId: string,
  text: string,
  options?: { clientId?: string; insertAtTop?: boolean }
): Promise<{ id: string; text: string; completed: boolean } | null> {
  const taskId = options?.clientId ?? generateTempId()
  const insertAtTop = options?.insertAtTop ?? false
  
  // Optimistically update local state
  updateLocalSnapshot((snapshot) => {
    const found = findBucketInSnapshot(snapshot, bucketId)
    if (!found) return snapshot
    
    const newTask: GoalTaskSnapshot = {
      id: taskId,
      text,
      completed: false,
      priority: false,
      difficulty: 'none',
      subtasks: [],
    }
    
    if (insertAtTop) {
      found.bucket.tasks.unshift(newTask)
    } else {
      // Insert at end of active (uncompleted) tasks
      const lastActiveIndex = found.bucket.tasks.findIndex(t => t.completed)
      if (lastActiveIndex === -1) {
        found.bucket.tasks.push(newTask)
      } else {
        found.bucket.tasks.splice(lastActiveIndex, 0, newTask)
      }
    }
    
    return snapshot
  })
  
  // If online, sync immediately
  if (isOnline()) {
    try {
      const result = await apiCreateTask(bucketId, text, { clientId: taskId, insertAtTop })
      return result
    } catch (error) {
      // Queue for retry
      queueOperation('createTask', { bucketId, text, taskId, insertAtTop }, taskId)
      return { id: taskId, text, completed: false }
    }
  } else {
    // Queue for later
    queueOperation('createTask', { bucketId, text, taskId, insertAtTop }, taskId)
    return { id: taskId, text, completed: false }
  }
}

/**
 * Update task text
 */
export async function updateTaskText(taskId: string, text: string): Promise<void> {
  const resolvedTaskId = resolveId(taskId)
  
  // Optimistically update local state
  updateLocalSnapshot((snapshot) => {
    const found = findTaskInSnapshot(snapshot, taskId)
    if (found) {
      found.task.text = text
    }
    return snapshot
  })
  
  if (isOnline() && !isTempId(resolvedTaskId)) {
    try {
      await apiUpdateTaskText(resolvedTaskId, text)
    } catch {
      queueOperation('updateTaskText', { taskId: resolvedTaskId, text })
    }
  } else {
    queueOperation('updateTaskText', { taskId: resolvedTaskId, text })
  }
}

/**
 * Set task completed status
 */
export async function setTaskCompletedAndResort(
  taskId: string,
  bucketId: string,
  completed: boolean
): Promise<DbTask | null> {
  const resolvedTaskId = resolveId(taskId)
  const resolvedBucketId = resolveId(bucketId)
  
  // Optimistically update local state
  updateLocalSnapshot((snapshot) => {
    const found = findTaskInSnapshot(snapshot, taskId)
    if (found) {
      found.task.completed = completed
      
      // Move task to appropriate section (active or completed)
      const bucket = found.bucket
      const task = bucket.tasks.splice(found.taskIndex, 1)[0]
      
      if (completed) {
        // Move to end (completed section)
        bucket.tasks.push(task)
      } else {
        // Move to end of active tasks (before completed)
        const firstCompletedIndex = bucket.tasks.findIndex(t => t.completed)
        if (firstCompletedIndex === -1) {
          bucket.tasks.push(task)
        } else {
          bucket.tasks.splice(firstCompletedIndex, 0, task)
        }
      }
    }
    return snapshot
  })
  
  if (isOnline() && !isTempId(resolvedTaskId)) {
    try {
      return await apiSetTaskCompletedAndResort(resolvedTaskId, resolvedBucketId, completed)
    } catch {
      queueOperation('updateTaskCompleted', { taskId: resolvedTaskId, bucketId: resolvedBucketId, completed })
      return null
    }
  } else {
    queueOperation('updateTaskCompleted', { taskId: resolvedTaskId, bucketId: resolvedBucketId, completed })
    return null
  }
}

/**
 * Set task priority
 */
export async function setTaskPriorityAndResort(
  taskId: string,
  bucketId: string,
  completed: boolean,
  priority: boolean
): Promise<void> {
  const resolvedTaskId = resolveId(taskId)
  const resolvedBucketId = resolveId(bucketId)
  
  // Optimistically update local state
  updateLocalSnapshot((snapshot) => {
    const found = findTaskInSnapshot(snapshot, taskId)
    if (found) {
      found.task.priority = priority
    }
    return snapshot
  })
  
  if (isOnline() && !isTempId(resolvedTaskId)) {
    try {
      await apiSetTaskPriorityAndResort(resolvedTaskId, resolvedBucketId, completed, priority)
    } catch {
      queueOperation('updateTaskPriority', { taskId: resolvedTaskId, bucketId: resolvedBucketId, completed, priority })
    }
  } else {
    queueOperation('updateTaskPriority', { taskId: resolvedTaskId, bucketId: resolvedBucketId, completed, priority })
  }
}

/**
 * Set task difficulty
 */
export async function setTaskDifficulty(
  taskId: string,
  difficulty: 'none' | 'green' | 'yellow' | 'red'
): Promise<void> {
  const resolvedTaskId = resolveId(taskId)
  
  // Optimistically update local state
  updateLocalSnapshot((snapshot) => {
    const found = findTaskInSnapshot(snapshot, taskId)
    if (found) {
      found.task.difficulty = difficulty
    }
    return snapshot
  })
  
  if (isOnline() && !isTempId(resolvedTaskId)) {
    try {
      await apiSetTaskDifficulty(resolvedTaskId, difficulty)
    } catch {
      queueOperation('updateTaskDifficulty', { taskId: resolvedTaskId, difficulty })
    }
  } else {
    queueOperation('updateTaskDifficulty', { taskId: resolvedTaskId, difficulty })
  }
}

/**
 * Update task notes
 */
export async function updateTaskNotes(taskId: string, notes: string): Promise<void> {
  const resolvedTaskId = resolveId(taskId)
  
  // Optimistically update local state
  updateLocalSnapshot((snapshot) => {
    const found = findTaskInSnapshot(snapshot, taskId)
    if (found) {
      found.task.notes = notes
    }
    return snapshot
  })
  
  if (isOnline() && !isTempId(resolvedTaskId)) {
    try {
      await apiUpdateTaskNotes(resolvedTaskId, notes)
    } catch {
      queueOperation('updateTaskNotes', { taskId: resolvedTaskId, notes })
    }
  } else {
    queueOperation('updateTaskNotes', { taskId: resolvedTaskId, notes })
  }
}

/**
 * Delete a task
 */
export async function deleteTask(taskId: string, bucketId: string): Promise<void> {
  const resolvedTaskId = resolveId(taskId)
  const resolvedBucketId = resolveId(bucketId)
  
  // Optimistically update local state
  updateLocalSnapshot((snapshot) => {
    const found = findTaskInSnapshot(snapshot, taskId)
    if (found) {
      found.bucket.tasks.splice(found.taskIndex, 1)
    }
    return snapshot
  })
  
  // Don't queue deletes for temp IDs - they were never synced
  if (isTempId(taskId)) {
    return
  }
  
  if (isOnline()) {
    try {
      await apiDeleteTask(resolvedTaskId, resolvedBucketId)
    } catch {
      queueOperation('deleteTask', { taskId: resolvedTaskId, bucketId: resolvedBucketId })
    }
  } else {
    queueOperation('deleteTask', { taskId: resolvedTaskId, bucketId: resolvedBucketId })
  }
}

/**
 * Move task to another bucket
 */
export async function moveTaskToBucket(taskId: string, fromBucketId: string, toBucketId: string): Promise<void> {
  const resolvedTaskId = resolveId(taskId)
  const resolvedFromBucketId = resolveId(fromBucketId)
  const resolvedToBucketId = resolveId(toBucketId)
  
  // Optimistically update local state
  updateLocalSnapshot((snapshot) => {
    const fromFound = findTaskInSnapshot(snapshot, taskId)
    const toFound = findBucketInSnapshot(snapshot, toBucketId)
    
    if (fromFound && toFound) {
      // Remove from source bucket
      const [task] = fromFound.bucket.tasks.splice(fromFound.taskIndex, 1)
      // Add to target bucket
      toFound.bucket.tasks.push(task)
    }
    return snapshot
  })
  
  if (isOnline() && !isTempId(resolvedTaskId)) {
    try {
      await apiMoveTaskToBucket(resolvedTaskId, resolvedFromBucketId, resolvedToBucketId)
    } catch {
      queueOperation('moveTask', { taskId: resolvedTaskId, fromBucketId: resolvedFromBucketId, toBucketId: resolvedToBucketId })
    }
  } else {
    queueOperation('moveTask', { taskId: resolvedTaskId, fromBucketId: resolvedFromBucketId, toBucketId: resolvedToBucketId })
  }
}

/**
 * Create or update a subtask
 */
export async function upsertTaskSubtask(
  taskId: string,
  subtaskId: string,
  text: string,
  completed: boolean,
  sortIndex: number
): Promise<void> {
  const resolvedTaskId = resolveId(taskId)
  const isNewSubtask = isTempId(subtaskId)
  const resolvedSubtaskId = isNewSubtask ? subtaskId : resolveId(subtaskId)
  
  // Optimistically update local state
  updateLocalSnapshot((snapshot) => {
    const found = findTaskInSnapshot(snapshot, taskId)
    if (found) {
      const existingIndex = found.task.subtasks.findIndex(s => s.id === subtaskId)
      const subtask: GoalTaskSubtaskSnapshot = {
        id: resolvedSubtaskId,
        text,
        completed,
        sortIndex,
      }
      
      if (existingIndex !== -1) {
        found.task.subtasks[existingIndex] = subtask
      } else {
        found.task.subtasks.push(subtask)
        found.task.subtasks.sort((a, b) => a.sortIndex - b.sortIndex)
      }
    }
    return snapshot
  })
  
  const subtaskPayload = { id: resolvedSubtaskId, text, completed, sort_index: sortIndex }
  
  if (isOnline() && !isTempId(resolvedTaskId)) {
    try {
      await apiUpsertTaskSubtask(resolvedTaskId, subtaskPayload)
    } catch {
      queueOperation('createSubtask', { taskId: resolvedTaskId, subtaskId: resolvedSubtaskId, text, completed, sortIndex }, isNewSubtask ? subtaskId : undefined)
    }
  } else {
    queueOperation('createSubtask', { taskId: resolvedTaskId, subtaskId: resolvedSubtaskId, text, completed, sortIndex }, isNewSubtask ? subtaskId : undefined)
  }
}

/**
 * Delete a subtask
 */
export async function deleteTaskSubtask(taskId: string, subtaskId: string): Promise<void> {
  const resolvedTaskId = resolveId(taskId)
  const resolvedSubtaskId = resolveId(subtaskId)
  
  // Optimistically update local state
  updateLocalSnapshot((snapshot) => {
    const found = findTaskInSnapshot(snapshot, taskId)
    if (found) {
      found.task.subtasks = found.task.subtasks.filter(s => s.id !== subtaskId)
    }
    return snapshot
  })
  
  // Don't queue deletes for temp IDs
  if (isTempId(subtaskId)) {
    return
  }
  
  if (isOnline() && !isTempId(resolvedTaskId)) {
    try {
      await apiDeleteTaskSubtask(resolvedTaskId, resolvedSubtaskId)
    } catch {
      queueOperation('deleteSubtask', { taskId: resolvedTaskId, subtaskId: resolvedSubtaskId })
    }
  } else {
    queueOperation('deleteSubtask', { taskId: resolvedTaskId, subtaskId: resolvedSubtaskId })
  }
}

// ============================================================================
// Register operation handlers for replay
// ============================================================================

registerOperationHandler('createTask', async (op: OfflineOperation) => {
  try {
    const { bucketId, text, taskId, insertAtTop } = op.payload as { bucketId: string; text: string; taskId: string; insertAtTop: boolean }
    const result = await apiCreateTask(bucketId, text, { clientId: taskId, insertAtTop })
    return { success: true, resolvedId: result?.id }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

registerOperationHandler('updateTaskText', async (op: OfflineOperation) => {
  try {
    const { taskId, text } = op.payload as { taskId: string; text: string }
    await apiUpdateTaskText(taskId, text)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

registerOperationHandler('updateTaskCompleted', async (op: OfflineOperation) => {
  try {
    const { taskId, bucketId, completed } = op.payload as { taskId: string; bucketId: string; completed: boolean }
    await apiSetTaskCompletedAndResort(taskId, bucketId, completed)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

registerOperationHandler('updateTaskPriority', async (op: OfflineOperation) => {
  try {
    const { taskId, bucketId, completed, priority } = op.payload as { taskId: string; bucketId: string; completed: boolean; priority: boolean }
    await apiSetTaskPriorityAndResort(taskId, bucketId, completed, priority)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

registerOperationHandler('updateTaskDifficulty', async (op: OfflineOperation) => {
  try {
    const { taskId, difficulty } = op.payload as { taskId: string; difficulty: 'none' | 'green' | 'yellow' | 'red' }
    await apiSetTaskDifficulty(taskId, difficulty)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

registerOperationHandler('updateTaskNotes', async (op: OfflineOperation) => {
  try {
    const { taskId, notes } = op.payload as { taskId: string; notes: string }
    await apiUpdateTaskNotes(taskId, notes)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

registerOperationHandler('deleteTask', async (op: OfflineOperation) => {
  try {
    const { taskId, bucketId } = op.payload as { taskId: string; bucketId: string }
    await apiDeleteTask(taskId, bucketId)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

registerOperationHandler('moveTask', async (op: OfflineOperation) => {
  try {
    const { taskId, fromBucketId, toBucketId } = op.payload as { taskId: string; fromBucketId: string; toBucketId: string }
    await apiMoveTaskToBucket(taskId, fromBucketId, toBucketId)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

registerOperationHandler('createSubtask', async (op: OfflineOperation) => {
  try {
    const { taskId, subtaskId, text, completed, sortIndex } = op.payload as { taskId: string; subtaskId: string; text: string; completed: boolean; sortIndex: number }
    await apiUpsertTaskSubtask(taskId, { id: subtaskId, text, completed, sort_index: sortIndex })
    return { success: true, resolvedId: subtaskId }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

registerOperationHandler('deleteSubtask', async (op: OfflineOperation) => {
  try {
    const { taskId, subtaskId } = op.payload as { taskId: string; subtaskId: string }
    await apiDeleteTaskSubtask(taskId, subtaskId)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})
