import { openDB, STORE } from './idbStore'

export type SeedStateRecord = {
  userId: string
  guestDefaultsSeedVersion?: number
  updatedAt: number
}

export async function readSeedState(userId: string): Promise<SeedStateRecord | null> {
  const db = await openDB()
  return new Promise<SeedStateRecord | null>((resolve, reject) => {
    const tx = db.transaction(STORE.seedState, 'readonly')
    const request = tx.objectStore(STORE.seedState).get(userId)
    request.onsuccess = () => resolve((request.result as SeedStateRecord | undefined) ?? null)
    request.onerror = () => reject(request.error)
  })
}

export async function writeSeedState(
  userId: string,
  patch: Omit<Partial<SeedStateRecord>, 'userId'>,
): Promise<SeedStateRecord> {
  const existing = await readSeedState(userId)
  const next: SeedStateRecord = {
    userId,
    updatedAt: Date.now(),
    ...(existing ?? {}),
    ...patch,
  }

  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE.seedState, 'readwrite')
    tx.objectStore(STORE.seedState).put(next)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })

  return next
}

export async function clearSeedState(userId: string): Promise<void> {
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE.seedState, 'readwrite')
    tx.objectStore(STORE.seedState).delete(userId)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
