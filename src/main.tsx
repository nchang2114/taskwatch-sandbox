import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { hydrateGoalsData } from './lib/idbGoals'
import { hydrateMilestones } from './lib/idbMilestones'
import { hydrateLifeRoutines } from './lib/idbLifeRoutines'
import { hydrateUserPreferences } from './lib/idbUserPreferences'
import { hydrateDailyList } from './lib/idbDailyList'
import { hydrateSnapbackOverview } from './lib/idbSnapbackOverview'
import { getCurrentUserId, GUEST_USER_ID, setCurrentUserId } from './lib/namespaceManager'
import { ensureGuestDefaultsInitialized } from './lib/guestInitialization'
import { ensureSingleUserSession } from './lib/supabaseClient'

// Some third-party instrumentation assumes document.classList exists; provide a no-op shim to prevent runtime errors.
if (typeof document !== 'undefined' && !(document as any).classList) {
  const emptyClassList = {
    length: 0,
    add() {},
    remove() {},
    contains() {
      return false
    },
    toggle() {
      return false
    },
    item() {
      return null
    },
    forEach() {},
    toString() {
      return ''
    },
    [Symbol.iterator]: function* () {
      /* no-op */
    },
  }
  Object.defineProperty(document, 'classList', { value: emptyClassList, configurable: true })
}

async function boot() {
  // Resolve the actual auth session before hydration so we load the correct
  // namespace (guest vs authenticated user) on first paint.
  try {
    const session = await ensureSingleUserSession()
    setCurrentUserId(session?.user?.id ?? null)
  } catch {
    setCurrentUserId(null)
  }

  const userId = getCurrentUserId()
  const hydrationTasks: Array<Promise<void>> = [
    hydrateGoalsData(userId),
    hydrateMilestones(userId),
    hydrateLifeRoutines(userId),
    hydrateUserPreferences(userId),
    hydrateDailyList(userId),
    hydrateSnapbackOverview(userId),
  ]
  if (userId !== GUEST_USER_ID) {
    hydrationTasks.push(hydrateLifeRoutines(GUEST_USER_ID))
    hydrationTasks.push(hydrateSnapbackOverview(GUEST_USER_ID))
  }
  await Promise.all(hydrationTasks)
  if (userId === GUEST_USER_ID) {
    await ensureGuestDefaultsInitialized(userId)
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
boot()
