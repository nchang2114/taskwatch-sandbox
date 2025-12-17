/**
 * Offline-aware Goals API (Simplified)
 * 
 * Wraps goalsApi functions to:
 * 1. Update local state immediately (optimistic updates)
 * 2. Queue operations when offline
 * 3. Sync to server when online
 * 
 * Uses real UUIDs for all entities - no temp ID mapping needed.
 */

import { isOnline, trackRequest } from './syncStatus'
import {
  queueOperation,
  registerOperationHandler,
  clearOfflineQueue,
  getQueueState,
  type OfflineOperation,
} from './offlineQueue'
import { generateUuid } from './quickListRemote'
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
  // Use provided clientId or generate a real UUID (not temp ID)
  const taskId = options?.clientId ?? generateUuid()
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
  
  console.log('[goalsApiOffline] createTask:', { bucketId, taskId, isOnline: isOnline() })
  
  // If online, sync immediately with the same UUID
  if (isOnline()) {
    try {
      const result = await trackRequest(() => apiCreateTask(bucketId, text, { clientId: taskId, insertAtTop }))
      return result
    } catch (error) {
      // Queue for retry with the same UUID
      queueOperation('createTask', { bucketId, text, taskId, insertAtTop })
      return { id: taskId, text, completed: false, difficulty: 'none', priority: false, sort_index: 0, notes: null }
    }
  } else {
    // Queue for later with the same UUID
    queueOperation('createTask', { bucketId, text, taskId, insertAtTop })
    return { id: taskId, text, completed: false, difficulty: 'none', priority: false, sort_index: 0, notes: null }
  }
}

/**
 * Update task text
 */
export async function updateTaskText(taskId: string, text: string): Promise<void> {
  // Optimistically update local state
  updateLocalSnapshot((snapshot) => {
    const found = findTaskInSnapshot(snapshot, taskId)
    if (found) {
      found.task.text = text
    }
    return snapshot
  })
  
  if (isOnline()) {
    try {
      await trackRequest(() => apiUpdateTaskText(taskId, text))
    } catch {
      queueOperation('updateTaskText', { taskId, text })
    }
  } else {
    queueOperation('updateTaskText', { taskId, text })
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
  
  if (isOnline()) {
    try {
      return await trackRequest(() => apiSetTaskCompletedAndResort(taskId, bucketId, completed))
    } catch {
      queueOperation('updateTaskCompleted', { taskId, bucketId, completed })
      return null
    }
  } else {
    queueOperation('updateTaskCompleted', { taskId, bucketId, completed })
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
  // Optimistically update local state
  updateLocalSnapshot((snapshot) => {
    const found = findTaskInSnapshot(snapshot, taskId)
    if (found) {
      found.task.priority = priority
      
      // Move task to appropriate position based on priority
      const bucket = found.bucket
      const task = bucket.tasks.splice(found.taskIndex, 1)[0]
      
      if (priority && !completed) {
        // Priority tasks go to the very top (before other priority tasks)
        bucket.tasks.unshift(task)
      } else if (!completed) {
        // Non-priority active tasks go after priority tasks but before completed
        const firstNonPriorityIndex = bucket.tasks.findIndex(t => !t.priority && !t.completed)
        const firstCompletedIndex = bucket.tasks.findIndex(t => t.completed)
        
        if (firstNonPriorityIndex !== -1) {
          bucket.tasks.splice(firstNonPriorityIndex, 0, task)
        } else if (firstCompletedIndex !== -1) {
          bucket.tasks.splice(firstCompletedIndex, 0, task)
        } else {
          bucket.tasks.push(task)
        }
      } else {
        // Completed tasks go to the end
        bucket.tasks.push(task)
      }
    }
    return snapshot
  })
  
  if (isOnline()) {
    try {
      await trackRequest(() => apiSetTaskPriorityAndResort(taskId, bucketId, completed, priority))
    } catch {
      queueOperation('updateTaskPriority', { taskId, bucketId, completed, priority })
    }
  } else {
    queueOperation('updateTaskPriority', { taskId, bucketId, completed, priority })
  }
}

/**
 * Set task difficulty
 */
export async function setTaskDifficulty(
  taskId: string,
  difficulty: 'none' | 'green' | 'yellow' | 'red'
): Promise<void> {
  // Optimistically update local state
  updateLocalSnapshot((snapshot) => {
    const found = findTaskInSnapshot(snapshot, taskId)
    if (found) {
      found.task.difficulty = difficulty
    }
    return snapshot
  })
  
  if (isOnline()) {
    try {
      await trackRequest(() => apiSetTaskDifficulty(taskId, difficulty))
    } catch {
      queueOperation('updateTaskDifficulty', { taskId, difficulty })
    }
  } else {
    queueOperation('updateTaskDifficulty', { taskId, difficulty })
  }
}

/**
 * Update task notes
 */
export async function updateTaskNotes(taskId: string, notes: string): Promise<void> {
  // Optimistically update local state
  updateLocalSnapshot((snapshot) => {
    const found = findTaskInSnapshot(snapshot, taskId)
    if (found) {
      found.task.notes = notes
    }
    return snapshot
  })
  
  if (isOnline()) {
    try {
      await trackRequest(() => apiUpdateTaskNotes(taskId, notes))
    } catch {
      queueOperation('updateTaskNotes', { taskId, notes })
    }
  } else {
    queueOperation('updateTaskNotes', { taskId, notes })
  }
}

/**
 * Delete a task
 */
export async function deleteTask(taskId: string, bucketId: string): Promise<void> {
  // Optimistically update local state
  updateLocalSnapshot((snapshot) => {
    const found = findTaskInSnapshot(snapshot, taskId)
    if (found) {
      found.bucket.tasks.splice(found.taskIndex, 1)
    }
    return snapshot
  })
  
  if (isOnline()) {
    try {
      await trackRequest(() => apiDeleteTask(taskId, bucketId))
    } catch {
      queueOperation('deleteTask', { taskId, bucketId })
    }
  } else {
    queueOperation('deleteTask', { taskId, bucketId })
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
  
  if (isOnline()) {
    try {
      await trackRequest(() => apiMoveTaskToBucket(taskId, fromBucketId, toBucketId, toIndex))
    } catch {
      queueOperation('moveTask', { taskId, fromBucketId, toBucketId, toIndex })
    }
  } else {
    queueOperation('moveTask', { taskId, fromBucketId, toBucketId, toIndex })
  }
}

/**
 * Create or update a subtask
 */
export async function upsertTaskSubtask(
  taskId: string,
  subtask: { id: string; text: string; completed: boolean; sort_index: number; updated_at?: string }
): Promise<void> {
  // Optimistically update local state
  updateLocalSnapshot((snapshot) => {
    const found = findTaskInSnapshot(snapshot, taskId)
    if (found) {
      const existingIndex = found.task.subtasks.findIndex(s => s.id === subtask.id)
      const subtaskSnapshot: GoalTaskSubtaskSnapshot = {
        id: subtask.id,
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
  
  if (isOnline()) {
    try {
      await trackRequest(() => apiUpsertTaskSubtask(taskId, subtask))
    } catch {
      queueOperation('createSubtask', { 
        taskId, 
        subtaskId: subtask.id, 
        text: subtask.text, 
        completed: subtask.completed, 
        sortIndex: subtask.sort_index 
      })
    }
  } else {
    queueOperation('createSubtask', { 
      taskId, 
      subtaskId: subtask.id, 
      text: subtask.text, 
      completed: subtask.completed, 
      sortIndex: subtask.sort_index 
    })
  }
}

/**
 * Delete a subtask
 */
export async function deleteTaskSubtask(taskId: string, subtaskId: string): Promise<void> {
  // Optimistically update local state
  updateLocalSnapshot((snapshot) => {
    const found = findTaskInSnapshot(snapshot, taskId)
    if (found) {
      found.task.subtasks = found.task.subtasks.filter(s => s.id !== subtaskId)
    }
    return snapshot
  })
  
  if (isOnline()) {
    try {
      await trackRequest(() => apiDeleteTaskSubtask(taskId, subtaskId))
    } catch {
      queueOperation('deleteSubtask', { taskId, subtaskId })
    }
  } else {
    queueOperation('deleteSubtask', { taskId, subtaskId })
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
  // Generate real UUID (not temp ID)
  const goalId = generateUuid()
  
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
      // Pass the UUID we generated so server uses same ID
      const result = await trackRequest(() => apiCreateGoal(name, color, { id: goalId }))
      return result
    } catch {
      queueOperation('createGoal', { name, color, goalId })
      return { id: goalId, name, goal_colour: color, sort_index: 0, starred: false, goal_archive: false }
    }
  } else {
    queueOperation('createGoal', { name, color, goalId })
    return { id: goalId, name, goal_colour: color, sort_index: 0, starred: false, goal_archive: false }
  }
}

/**
 * Rename a goal
 */
export async function renameGoal(goalId: string, name: string): Promise<void> {
  updateLocalSnapshot((snapshot) => {
    const found = findGoalInSnapshot(snapshot, goalId)
    if (found) {
      found.goal.name = name
    }
    return snapshot
  })
  
  if (isOnline()) {
    try {
      await trackRequest(() => apiRenameGoal(goalId, name))
    } catch {
      queueOperation('updateGoal', { goalId, name })
    }
  } else {
    queueOperation('updateGoal', { goalId, name })
  }
}

/**
 * Set goal color
 */
export async function setGoalColor(goalId: string, color: string): Promise<void> {
  updateLocalSnapshot((snapshot) => {
    const found = findGoalInSnapshot(snapshot, goalId)
    if (found) {
      found.goal.goalColour = color
    }
    return snapshot
  })
  
  if (isOnline()) {
    try {
      await trackRequest(() => apiSetGoalColor(goalId, color))
    } catch {
      queueOperation('updateGoalColor', { goalId, color })
    }
  } else {
    queueOperation('updateGoalColor', { goalId, color })
  }
}

/**
 * Set goal surface
 */
export async function setGoalSurface(goalId: string, surface: string | null): Promise<void> {
  updateLocalSnapshot((snapshot) => {
    const found = findGoalInSnapshot(snapshot, goalId)
    if (found) {
      found.goal.surfaceStyle = (surface ?? 'glass') as GoalSnapshot['surfaceStyle']
    }
    return snapshot
  })
  
  if (isOnline()) {
    try {
      await trackRequest(() => apiSetGoalSurface(goalId, surface))
    } catch {
      queueOperation('updateGoalSurface', { goalId, surface })
    }
  } else {
    queueOperation('updateGoalSurface', { goalId, surface })
  }
}

/**
 * Set goal starred
 */
export async function setGoalStarred(goalId: string, starred: boolean): Promise<void> {
  updateLocalSnapshot((snapshot) => {
    const found = findGoalInSnapshot(snapshot, goalId)
    if (found) {
      found.goal.starred = starred
    }
    return snapshot
  })
  
  if (isOnline()) {
    try {
      await trackRequest(() => apiSetGoalStarred(goalId, starred))
    } catch {
      queueOperation('updateGoalStarred', { goalId, starred })
    }
  } else {
    queueOperation('updateGoalStarred', { goalId, starred })
  }
}

/**
 * Set goal archived
 */
export async function setGoalArchived(goalId: string, archived: boolean): Promise<void> {
  updateLocalSnapshot((snapshot) => {
    const found = findGoalInSnapshot(snapshot, goalId)
    if (found) {
      found.goal.archived = archived
    }
    return snapshot
  })
  
  if (isOnline()) {
    try {
      await trackRequest(() => apiSetGoalArchived(goalId, archived))
    } catch {
      queueOperation('updateGoalArchived', { goalId, archived })
    }
  } else {
    queueOperation('updateGoalArchived', { goalId, archived })
  }
}

/**
 * Delete a goal
 */
export async function deleteGoalById(goalId: string): Promise<void> {
  updateLocalSnapshot((snapshot) => {
    return snapshot.filter(g => g.id !== goalId)
  })
  
  if (isOnline()) {
    try {
      await trackRequest(() => apiDeleteGoalById(goalId))
    } catch {
      queueOperation('deleteGoal', { goalId })
    }
  } else {
    queueOperation('deleteGoal', { goalId })
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
  // Generate real UUID (not temp ID)
  const bucketId = generateUuid()
  
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
      // Insert at the beginning (new buckets appear at top)
      found.goal.buckets.unshift(newBucket)
    }
    return snapshot
  })
  
  if (isOnline()) {
    try {
      // Pass the UUID we generated so server uses same ID
      const result = await trackRequest(() => apiCreateBucket(goalId, name, surface, { id: bucketId }))
      return result
    } catch {
      queueOperation('createBucket', { goalId, name, surface, bucketId })
      return { id: bucketId, name, favorite: false, sort_index: 0 }
    }
  } else {
    queueOperation('createBucket', { goalId, name, surface, bucketId })
    return { id: bucketId, name, favorite: false, sort_index: 0 }
  }
}

/**
 * Rename a bucket
 */
export async function renameBucket(bucketId: string, name: string): Promise<void> {
  updateLocalSnapshot((snapshot) => {
    const found = findBucketInSnapshot(snapshot, bucketId)
    if (found) {
      found.bucket.name = name
    }
    return snapshot
  })
  
  if (isOnline()) {
    try {
      await trackRequest(() => apiRenameBucket(bucketId, name))
    } catch {
      queueOperation('updateBucket', { bucketId, name })
    }
  } else {
    queueOperation('updateBucket', { bucketId, name })
  }
}

/**
 * Set bucket surface style
 */
export async function setBucketSurface(bucketId: string, surface: string | null): Promise<void> {
  updateLocalSnapshot((snapshot) => {
    const found = findBucketInSnapshot(snapshot, bucketId)
    if (found) {
      found.bucket.surfaceStyle = (surface ?? 'glass') as GoalBucketSnapshot['surfaceStyle']
    }
    return snapshot
  })
  
  if (isOnline()) {
    try {
      await trackRequest(() => apiSetBucketSurface(bucketId, surface))
    } catch {
      queueOperation('updateBucketSurface', { bucketId, surface })
    }
  } else {
    queueOperation('updateBucketSurface', { bucketId, surface })
  }
}

/**
 * Set bucket favorite
 */
export async function setBucketFavorite(bucketId: string, favorite: boolean): Promise<void> {
  updateLocalSnapshot((snapshot) => {
    const found = findBucketInSnapshot(snapshot, bucketId)
    if (found) {
      found.bucket.favorite = favorite
    }
    return snapshot
  })
  
  if (isOnline()) {
    try {
      await trackRequest(() => apiSetBucketFavorite(bucketId, favorite))
    } catch {
      queueOperation('updateBucketFavorite', { bucketId, favorite })
    }
  } else {
    queueOperation('updateBucketFavorite', { bucketId, favorite })
  }
}

/**
 * Set bucket archived
 */
export async function setBucketArchived(bucketId: string, archived: boolean): Promise<void> {
  updateLocalSnapshot((snapshot) => {
    const found = findBucketInSnapshot(snapshot, bucketId)
    if (found) {
      found.bucket.archived = archived
    }
    return snapshot
  })
  
  if (isOnline()) {
    try {
      await trackRequest(() => apiSetBucketArchived(bucketId, archived))
    } catch {
      queueOperation('updateBucketArchived', { bucketId, archived })
    }
  } else {
    queueOperation('updateBucketArchived', { bucketId, archived })
  }
}

/**
 * Delete a bucket
 */
export async function deleteBucketById(bucketId: string): Promise<void> {
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
  
  if (isOnline()) {
    try {
      await trackRequest(() => apiDeleteBucketById(bucketId))
    } catch {
      queueOperation('deleteBucket', { bucketId })
    }
  } else {
    queueOperation('deleteBucket', { bucketId })
  }
}

// ============================================================================
// Register operation handlers for replay
// ============================================================================

registerOperationHandler('createTask', async (op: OfflineOperation) => {
  try {
    const { bucketId, text, taskId, insertAtTop } = op.payload as { bucketId: string; text: string; taskId: string; insertAtTop: boolean }
    // Pass the UUID we generated so server uses same ID
    await apiCreateTask(bucketId, text, { clientId: taskId, insertAtTop })
    return { success: true }
  } catch (error) {
    // 409 Conflict means task already exists - treat as success
    const errorMsg = error instanceof Error ? error.message : String(error)
    if (errorMsg.includes('409') || errorMsg.includes('conflict') || errorMsg.includes('duplicate')) {
      console.log('[offlineQueue] createTask: task already exists, treating as success')
      return { success: true }
    }
    return { success: false, error: errorMsg }
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
    return { success: true }
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
    const { name, color, goalId } = op.payload as { name: string; color: string; goalId: string }
    // Pass the UUID we generated so server uses same ID
    await apiCreateGoal(name, color, { id: goalId })
    return { success: true }
  } catch (error) {
    // 409 Conflict means goal already exists - treat as success
    const errorMsg = error instanceof Error ? error.message : String(error)
    if (errorMsg.includes('409') || errorMsg.includes('conflict') || errorMsg.includes('duplicate')) {
      console.log('[offlineQueue] createGoal: goal already exists, treating as success')
      return { success: true }
    }
    return { success: false, error: errorMsg }
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
    const { goalId, name, surface, bucketId } = op.payload as { goalId: string; name: string; surface: string; bucketId: string }
    // Pass the UUID we generated so server uses same ID
    await apiCreateBucket(goalId, name, surface, { id: bucketId })
    return { success: true }
  } catch (error) {
    // 409 Conflict means bucket already exists - treat as success
    const errorMsg = error instanceof Error ? error.message : String(error)
    if (errorMsg.includes('409') || errorMsg.includes('conflict') || errorMsg.includes('duplicate')) {
      console.log('[offlineQueue] createBucket: bucket already exists, treating as success')
      return { success: true }
    }
    return { success: false, error: errorMsg }
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
