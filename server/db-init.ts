import 'dotenv/config'
import { initDatabase } from './config/dbInit.js'
import { loadEnv } from './config/env.js'

// npm run db:init   → create the database and load schema + seed if it does not exist yet
// npm run db:reset  → DROP the database and start again (development only)

const reset = process.argv.includes('--reset')
const env = loadEnv()

if (reset && env.NODE_ENV === 'production') {
  console.error('[db] Refusing to reset the database when NODE_ENV=production.')
  process.exit(1)
}

try {
  if (reset) console.log(`[db] Dropping database "${env.DB_NAME}"…`)
  const result = await initDatabase(env, { reset })
  if (result.created) {
    console.log(`[db] Created "${env.DB_NAME}" (schema v${result.schemaVersion})${result.sampleDataLoaded ? ' with sample data' : ''}.`)
    console.log('[db] Sign in with username "admin" and PIN 000000; the first sign-in asks you to set your own.')
  } else if (result.migrated.length) {
    console.log(`[db] Upgraded "${env.DB_NAME}" to schema v${result.schemaVersion}: ${result.migrated.join(', ')}`)
  } else {
    console.log(`[db] "${env.DB_NAME}" already set up (schema v${result.schemaVersion}). Nothing to do.`)
  }
} catch (error) {
  console.error('[db] Failed:', error instanceof Error ? error.message : error)
  process.exit(1)
}