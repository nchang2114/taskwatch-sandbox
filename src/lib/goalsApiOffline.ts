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

import { isOnline, trackRequest } from './syncStatus'
import {
  queueOperation,
  registerOperationHandler,
  generateTempId,
  isTempId,
  resolveId,
  clearOfflineQueue,
  getQueueState,
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
  // Goal operations
  createGoal as apiCreateGoal,
  renameGoal as apiRenameGoal,
  setGoalColor as apiSetGoalColor,
  setGoalSurface as apiSetGoalSurface,
  setGoalStarred as apiSetGoalStarred,
  setGoalArchived as apiSetGoalArchived,
  deleteGoalById as apiDeleteGoalById,
  // Bucket operations
  createBucket as apiCreateBucket,
  renameBucket as apiRenameBucket,
  setBucketSurface as apiSetBucketSurface,
  setBucketFavorite as apiSetBucketFavorite,
  setBucketArchived as apiSetBucketArchived,
  deleteBucketById as apiDeleteBucketById,
  type DbTask,
} from './goalsApi'

// ============================================================================
// Helper functions for updating local snapshot
// ============================================================================

/**
 * Find a goal in the goals snapshot
 */
const findGoalInSnapshot = (
  snapshot: GoalSnapshot[],
  goalId: string
): { goal: GoalSnapshot; goalIndex: number } | null => {
  const goalIndex = snapshot.findIndex(g => g.id === goalId)
  if (goalIndex !== -1) {
    return { goal: snapshot[goalIndex], goalIndex }
  }
  return null
}

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
): Promise<{
  id: string
  text: string
  completed: boolean
  difficulty: 'none' | 'green' | 'yellow' | 'red'
  priority: boolean
  sort_index: number
  notes: string | null
} | null> {
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
  
  // Resolve bucket ID if it's a temp ID that has been synced
  const resolvedBucketId = resolveId(bucketId)
  
  console.log('[goalsApiOffline] createTask:', { bucketId, resolvedBucketId, isTempId: isTempId(resolvedBucketId), isOnline: isOnline() })
  
  // If online AND bucket ID is not a temp ID, sync immediately
  if (isOnline() && !isTempId(resolvedBucketId)) {
    try {
      const result = await trackRequest(() => apiCreateTask(resolvedBucketId, text, { clientId: taskId, insertAtTop }))
      return result
    } catch (error) {
      // Queue for retry
      queueOperation('createTask', { bucketId, text, taskId, insertAtTop }, taskId)
      return { id: taskId, text, completed: false, difficulty: 'none', priority: false, sort_index: 0, notes: null }
    }
  } else {
    // Queue for later
    queueOperation('createTask', { bucketId, text, taskId, insertAtTop }, taskId)
    return { id: taskId, text, completed: false, difficulty: 'none', priority: false, sort_index: 0, notes: null }
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
      await trackRequest(() => apiUpdateTaskText(resolvedTaskId, text))
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
  
  if (isOnline() && !isTempId(resolvedTaskId) && !isTempId(resolvedBucketId)) {
    try {
      return await trackRequest(() => apiSetTaskCompletedAndResort(resolvedTaskId, resolvedBucketId, completed))
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
  
  if (isOnline() && !isTempId(resolvedTaskId) && !isTempId(resolvedBucketId)) {
    try {
      await trackRequest(() => apiSetTaskPriorityAndResort(resolvedTaskId, resolvedBucketId, completed, priority))
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
      await trackRequest(() => apiSetTaskDifficulty(resolvedTaskId, difficulty))
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
      await trackRequest(() => apiUpdateTaskNotes(resolvedTaskId, notes))
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
  
  if (isOnline() && !isTempId(resolvedBucketId)) {
    try {
      await trackRequest(() => apiDeleteTask(resolvedTaskId, resolvedBucketId))
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
export async function moveTaskToBucket(
  taskId: string,
  fromBucketId: string,
  toBucketId: string,
  toIndex?: number
): Promise<void> {
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
      // Add to target bucket at specified index or end
      if (toIndex !== undefined) {
        toFound.bucket.tasks.splice(toIndex, 0, task)
      } else {
        toFound.bucket.tasks.push(task)
      }
    }
    return snapshot
  })
  
  if (isOnline() && !isTempId(resolvedTaskId) && !isTempId(resolvedFromBucketId) && !isTempId(resolvedToBucketId)) {
    try {
      await trackRequest(() => apiMoveTaskToBucket(resolvedTaskId, resolvedFromBucketId, resolvedToBucketId, toIndex))
    } catch {
      queueOperation('moveTask', { taskId: resolvedTaskId, fromBucketId: resolvedFromBucketId, toBucketId: resolvedToBucketId, toIndex })
    }
  } else {
    queueOperation('moveTask', { taskId: resolvedTaskId, fromBucketId: resolvedFromBucketId, toBucketId: resolvedToBucketId, toIndex })
  }
}

/**
 * Create or update a subtask
 */
export async function upsertTaskSubtask(
  taskId: string,
  subtask: { id: string; text: string; completed: boolean; sort_index: number; updated_at?: string }
): Promise<void> {
  const resolvedTaskId = resolveId(taskId)
  const isNewSubtask = isTempId(subtask.id)
  const resolvedSubtaskId = isNewSubtask ? subtask.id : resolveId(subtask.id)
  
  // Optimistically update local state
  updateLocalSnapshot((snapshot) => {
    const found = findTaskInSnapshot(snapshot, taskId)
    if (found) {
      const existingIndex = found.task.subtasks.findIndex(s => s.id === subtask.id)
      const subtaskSnapshot: GoalTaskSubtaskSnapshot = {
        id: resolvedSubtaskId,
        text: subtask.text,
        completed: subtask.completed,
        sortIndex: subtask.sort_index,
      }
      
      if (existingIndex !== -1) {
        found.task.subtasks[existingIndex] = subtaskSnapshot
      } else {
        found.task.subtasks.push(subtaskSnapshot)
        found.task.subtasks.sort((a, b) => a.sortIndex - b.sortIndex)
      }
    }
    return snapshot
  })
  
  if (isOnline() && !isTempId(resolvedTaskId)) {
    try {
      await trackRequest(() => apiUpsertTaskSubtask(resolvedTaskId, subtask))
    } catch {
      queueOperation('createSubtask', { 
        taskId: resolvedTaskId, 
        subtaskId: resolvedSubtaskId, 
        text: subtask.text, 
        completed: subtask.completed, 
        sortIndex: subtask.sort_index 
      }, isNewSubtask ? subtask.id : undefined)
    }
  } else {
    queueOperation('createSubtask', { 
      taskId: resolvedTaskId, 
      subtaskId: resolvedSubtaskId, 
      text: subtask.text, 
      completed: subtask.completed, 
      sortIndex: subtask.sort_index 
    }, isNewSubtask ? subtask.id : undefined)
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
      await trackRequest(() => apiDeleteTaskSubtask(resolvedTaskId, resolvedSubtaskId))
    } catch {
      queueOperation('deleteSubtask', { taskId: resolvedTaskId, subtaskId: resolvedSubtaskId })
    }
  } else {
    queueOperation('deleteSubtask', { taskId: resolvedTaskId, subtaskId: resolvedSubtaskId })
  }
}

// ============================================================================
// Goal operations (offline-aware)
// ============================================================================

/**
 * Create a new goal
 */
export async function createGoal(
  name: string,
  color: string
): Promise<{ id: string; name: string; goal_colour: string; sort_index: number; card_surface?: string | null; starred: boolean; goal_archive?: boolean; milestones_shown?: boolean } | null> {
  const goalId = generateTempId()
  
  // Optimistically update local state
  updateLocalSnapshot((snapshot) => {
    const newGoal: GoalSnapshot = {
      id: goalId,
      name,
      goalColour: color,
      surfaceStyle: 'glass',
      starred: false,
      archived: false,
      buckets: [],
    }
    snapshot.push(newGoal)
    return snapshot
  })
  
  if (isOnline()) {
    try {
      const result = await trackRequest(() => apiCreateGoal(name, color))
      if (result) {
        // Update local state with real ID
        updateLocalSnapshot((snapshot) => {
          const found = findGoalInSnapshot(snapshot, goalId)
          if (found) {
            found.goal.id = result.id
          }
          return snapshot
        })
        return result
      }
      return null
    } catch {
      queueOperation('createGoal', { name, color, goalId }, goalId)
      return { id: goalId, name, goal_colour: color, sort_index: 0, starred: false, goal_archive: false }
    }
  } else {
    queueOperation('createGoal', { name, color, goalId }, goalId)
    return { id: goalId, name, goal_colour: color, sort_index: 0, starred: false, goal_archive: false }
  }
}

/**
 * Rename a goal
 */
export async function renameGoal(goalId: string, name: string): Promise<void> {
  const resolvedGoalId = resolveId(goalId)
  
  updateLocalSnapshot((snapshot) => {
    const found = findGoalInSnapshot(snapshot, goalId)
    if (found) {
      found.goal.name = name
    }
    return snapshot
  })
  
  if (isOnline() && !isTempId(resolvedGoalId)) {
    try {
      await trackRequest(() => apiRenameGoal(resolvedGoalId, name))
    } catch {
      queueOperation('updateGoal', { goalId: resolvedGoalId, name })
    }
  } else {
    queueOperation('updateGoal', { goalId: resolvedGoalId, name })
  }
}

/**
 * Set goal color
 */
export async function setGoalColor(goalId: string, color: string): Promise<void> {
  const resolvedGoalId = resolveId(goalId)
  
  updateLocalSnapshot((snapshot) => {
    const found = findGoalInSnapshot(snapshot, goalId)
    if (found) {
      found.goal.goalColour = color
    }
    return snapshot
  })
  
  if (isOnline() && !isTempId(resolvedGoalId)) {
    try {
      await trackRequest(() => apiSetGoalColor(resolvedGoalId, color))
    } catch {
      queueOperation('updateGoalColor', { goalId: resolvedGoalId, color })
    }
  } else {
    queueOperation('updateGoalColor', { goalId: resolvedGoalId, color })
  }
}

/**
 * Set goal surface
 */
export async function setGoalSurface(goalId: string, surface: string | null): Promise<void> {
  const resolvedGoalId = resolveId(goalId)
  
  updateLocalSnapshot((snapshot) => {
    const found = findGoalInSnapshot(snapshot, goalId)
    if (found) {
      found.goal.surfaceStyle = (surface ?? 'glass') as GoalSnapshot['surfaceStyle']
    }
    return snapshot
  })
  
  if (isOnline() && !isTempId(resolvedGoalId)) {
    try {
      await trackRequest(() => apiSetGoalSurface(resolvedGoalId, surface))
    } catch {
      queueOperation('updateGoalSurface', { goalId: resolvedGoalId, surface })
    }
  } else {
    queueOperation('updateGoalSurface', { goalId: resolvedGoalId, surface })
  }
}

/**
 * Set goal starred
 */
export async function setGoalStarred(goalId: string, starred: boolean): Promise<void> {
  const resolvedGoalId = resolveId(goalId)
  
  updateLocalSnapshot((snapshot) => {
    const found = findGoalInSnapshot(snapshot, goalId)
    if (found) {
      found.goal.starred = starred
    }
    return snapshot
  })
  
  if (isOnline() && !isTempId(resolvedGoalId)) {
    try {
      await trackRequest(() => apiSetGoalStarred(resolvedGoalId, starred))
    } catch {
      queueOperation('updateGoalStarred', { goalId: resolvedGoalId, starred })
    }
  } else {
    queueOperation('updateGoalStarred', { goalId: resolvedGoalId, starred })
  }
}

/**
 * Set goal archived
 */
export async function setGoalArchived(goalId: string, archived: boolean): Promise<void> {
  const resolvedGoalId = resolveId(goalId)
  
  updateLocalSnapshot((snapshot) => {
    const found = findGoalInSnapshot(snapshot, goalId)
    if (found) {
      found.goal.archived = archived
    }
    return snapshot
  })
  
  if (isOnline() && !isTempId(resolvedGoalId)) {
    try {
      await trackRequest(() => apiSetGoalArchived(resolvedGoalId, archived))
    } catch {
      queueOperation('updateGoalArchived', { goalId: resolvedGoalId, archived })
    }
  } else {
    queueOperation('updateGoalArchived', { goalId: resolvedGoalId, archived })
  }
}

/**
 * Delete a goal
 */
export async function deleteGoalById(goalId: string): Promise<void> {
  const resolvedGoalId = resolveId(goalId)
  
  updateLocalSnapshot((snapshot) => {
    return snapshot.filter(g => g.id !== goalId)
  })
  
  // Don't queue deletes for temp IDs - they were never synced
  if (isTempId(goalId)) {
    return
  }
  
  if (isOnline()) {
    try {
      await trackRequest(() => apiDeleteGoalById(resolvedGoalId))
    } catch {
      queueOperation('deleteGoal', { goalId: resolvedGoalId })
    }
  } else {
    queueOperation('deleteGoal', { goalId: resolvedGoalId })
  }
}

// ============================================================================
// Bucket operations (offline-aware)
// ============================================================================

/**
 * Create a new bucket
 */
export async function createBucket(
  goalId: string,
  name: string,
  surface: string = 'glass'
): Promise<{ id: string; name: string; favorite: boolean; bucket_archive?: boolean; sort_index: number } | null> {
  const resolvedGoalId = resolveId(goalId)
  const bucketId = generateTempId()
  
  // Optimistically update local state
  updateLocalSnapshot((snapshot) => {
    const found = findGoalInSnapshot(snapshot, goalId)
    if (found) {
      const newBucket: GoalBucketSnapshot = {
        id: bucketId,
        name,
        favorite: false,
        archived: false,
        surfaceStyle: surface as GoalBucketSnapshot['surfaceStyle'],
        tasks: [],
      }
      found.goal.buckets.push(newBucket)
    }
    return snapshot
  })
  
  if (isOnline() && !isTempId(resolvedGoalId)) {
    try {
      const result = await trackRequest(() => apiCreateBucket(resolvedGoalId, name, surface))
      if (result) {
        // Update local state with real ID
        updateLocalSnapshot((snapshot) => {
          const goalFound = findGoalInSnapshot(snapshot, goalId)
          if (goalFound) {
            const bucketIndex = goalFound.goal.buckets.findIndex(b => b.id === bucketId)
            if (bucketIndex !== -1) {
              goalFound.goal.buckets[bucketIndex].id = result.id
            }
          }
          return snapshot
        })
        return result
      }
      return null
    } catch {
      queueOperation('createBucket', { goalId: resolvedGoalId, name, surface, bucketId }, bucketId)
      return { id: bucketId, name, favorite: false, sort_index: 0 }
    }
  } else {
    queueOperation('createBucket', { goalId: resolvedGoalId, name, surface, bucketId }, bucketId)
    return { id: bucketId, name, favorite: false, sort_index: 0 }
  }
}

/**
 * Rename a bucket
 */
export async function renameBucket(bucketId: string, name: string): Promise<void> {
  const resolvedBucketId = resolveId(bucketId)
  
  updateLocalSnapshot((snapshot) => {
    const found = findBucketInSnapshot(snapshot, bucketId)
    if (found) {
      found.bucket.name = name
    }
    return snapshot
  })
  
  if (isOnline() && !isTempId(resolvedBucketId)) {
    try {
      await trackRequest(() => apiRenameBucket(resolvedBucketId, name))
    } catch {
      queueOperation('updateBucket', { bucketId: resolvedBucketId, name })
    }
  } else {
    queueOperation('updateBucket', { bucketId: resolvedBucketId, name })
  }
}

/**
 * Set bucket surface style
 */
export async function setBucketSurface(bucketId: string, surface: string | null): Promise<void> {
  const resolvedBucketId = resolveId(bucketId)
  
  updateLocalSnapshot((snapshot) => {
    const found = findBucketInSnapshot(snapshot, bucketId)
    if (found) {
      found.bucket.surfaceStyle = (surface ?? 'glass') as GoalBucketSnapshot['surfaceStyle']
    }
    return snapshot
  })
  
  if (isOnline() && !isTempId(resolvedBucketId)) {
    try {
      await trackRequest(() => apiSetBucketSurface(resolvedBucketId, surface))
    } catch {
      queueOperation('updateBucketSurface', { bucketId: resolvedBucketId, surface })
    }
  } else {
    queueOperation('updateBucketSurface', { bucketId: resolvedBucketId, surface })
  }
}

/**
 * Set bucket favorite
 */
export async function setBucketFavorite(bucketId: string, favorite: boolean): Promise<void> {
  const resolvedBucketId = resolveId(bucketId)
  
  updateLocalSnapshot((snapshot) => {
    const found = findBucketInSnapshot(snapshot, bucketId)
    if (found) {
      found.bucket.favorite = favorite
    }
    return snapshot
  })
  
  if (isOnline() && !isTempId(resolvedBucketId)) {
    try {
      await trackRequest(() => apiSetBucketFavorite(resolvedBucketId, favorite))
    } catch {
      queueOperation('updateBucketFavorite', { bucketId: resolvedBucketId, favorite })
    }
  } else {
    queueOperation('updateBucketFavorite', { bucketId: resolvedBucketId, favorite })
  }
}

/**
 * Set bucket archived
 */
export async function setBucketArchived(bucketId: string, archived: boolean): Promise<void> {
  const resolvedBucketId = resolveId(bucketId)
  
  updateLocalSnapshot((snapshot) => {
    const found = findBucketInSnapshot(snapshot, bucketId)
    if (found) {
      found.bucket.archived = archived
    }
    return snapshot
  })
  
  if (isOnline() && !isTempId(resolvedBucketId)) {
    try {
      await trackRequest(() => apiSetBucketArchived(resolvedBucketId, archived))
    } catch {
      queueOperation('updateBucketArchived', { bucketId: resolvedBucketId, archived })
    }
  } else {
    queueOperation('updateBucketArchived', { bucketId: resolvedBucketId, archived })
  }
}

/**
 * Delete a bucket
 */
export async function deleteBucketById(bucketId: string): Promise<void> {
  const resolvedBucketId = resolveId(bucketId)
  
  updateLocalSnapshot((snapshot) => {
    for (const goal of snapshot) {
      const bucketIndex = goal.buckets.findIndex(b => b.id === bucketId)
      if (bucketIndex !== -1) {
        goal.buckets.splice(bucketIndex, 1)
        break
      }
    }
    return snapshot
  })
  
  // Don't queue deletes for temp IDs
  if (isTempId(bucketId)) {
    return
  }
  
  if (isOnline()) {
    try {
      await trackRequest(() => apiDeleteBucketById(resolvedBucketId))
    } catch {
      queueOperation('deleteBucket', { bucketId: resolvedBucketId })
    }
  } else {
    queueOperation('deleteBucket', { bucketId: resolvedBucketId })
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
    const { taskId, fromBucketId, toBucketId, toIndex } = op.payload as { taskId: string; fromBucketId: string; toBucketId: string; toIndex?: number }
    await apiMoveTaskToBucket(taskId, fromBucketId, toBucketId, toIndex)
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

// ============================================================================
// Goal operation handlers
// ============================================================================

registerOperationHandler('createGoal', async (op: OfflineOperation) => {
  try {
    const { name, color, goalId: _goalId } = op.payload as { name: string; color: string; goalId: string }
    const result = await apiCreateGoal(name, color)
    return { success: true, resolvedId: result?.id }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

registerOperationHandler('updateGoal', async (op: OfflineOperation) => {
  try {
    const { goalId, name } = op.payload as { goalId: string; name: string }
    await apiRenameGoal(goalId, name)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

registerOperationHandler('updateGoalColor', async (op: OfflineOperation) => {
  try {
    const { goalId, color } = op.payload as { goalId: string; color: string }
    await apiSetGoalColor(goalId, color)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

registerOperationHandler('updateGoalSurface', async (op: OfflineOperation) => {
  try {
    const { goalId, surface } = op.payload as { goalId: string; surface: string | null }
    await apiSetGoalSurface(goalId, surface)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

registerOperationHandler('updateGoalStarred', async (op: OfflineOperation) => {
  try {
    const { goalId, starred } = op.payload as { goalId: string; starred: boolean }
    await apiSetGoalStarred(goalId, starred)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

registerOperationHandler('updateGoalArchived', async (op: OfflineOperation) => {
  try {
    const { goalId, archived } = op.payload as { goalId: string; archived: boolean }
    await apiSetGoalArchived(goalId, archived)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

registerOperationHandler('deleteGoal', async (op: OfflineOperation) => {
  try {
    const { goalId } = op.payload as { goalId: string }
    await apiDeleteGoalById(goalId)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

// ============================================================================
// Bucket operation handlers
// ============================================================================

registerOperationHandler('createBucket', async (op: OfflineOperation) => {
  try {
    const { goalId, name, surface, bucketId: _bucketId } = op.payload as { goalId: string; name: string; surface: string; bucketId: string }
    const result = await apiCreateBucket(goalId, name, surface)
    return { success: true, resolvedId: result?.id }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

registerOperationHandler('updateBucket', async (op: OfflineOperation) => {
  try {
    const { bucketId, name } = op.payload as { bucketId: string; name: string }
    await apiRenameBucket(bucketId, name)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

registerOperationHandler('updateBucketSurface', async (op: OfflineOperation) => {
  try {
    const { bucketId, surface } = op.payload as { bucketId: string; surface: string | null }
    await apiSetBucketSurface(bucketId, surface)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

registerOperationHandler('updateBucketFavorite', async (op: OfflineOperation) => {
  try {
    const { bucketId, favorite } = op.payload as { bucketId: string; favorite: boolean }
    await apiSetBucketFavorite(bucketId, favorite)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

registerOperationHandler('updateBucketArchived', async (op: OfflineOperation) => {
  try {
    const { bucketId, archived } = op.payload as { bucketId: string; archived: boolean }
    await apiSetBucketArchived(bucketId, archived)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

registerOperationHandler('deleteBucket', async (op: OfflineOperation) => {
  try {
    const { bucketId } = op.payload as { bucketId: string }
    await apiDeleteBucketById(bucketId)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

// Expose debug functions on window for troubleshooting
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__offlineQueue = {
    clear: clearOfflineQueue,
    getState: getQueueState,
  }
}
