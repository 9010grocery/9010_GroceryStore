import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise'
import type { Env } from './env.js'

/** Bump when a new file is added to database/migrations (002_….sql is version 2, and so on). */
export const SCHEMA_VERSION = 9

/** The account every new system starts with. The first sign-in has to replace all of it (see must_change_credentials). */
export const DEFAULT_OWNER = { username: 'admin', pin: '000000', first_name: 'Store', last_name: 'Owner' }

export interface DbInitResult {
  created: boolean
  schemaVersion: number
  sampleDataLoaded: boolean
  /** Migration files applied by this run, e.g. ["002_imports_and_live_data.sql"]. */
  migrated: string[]
  /** True when this run created the default admin account (no owner existed). */
  defaultOwnerCreated: boolean
  /** Unique per database (a reset makes a new one); see ensureInstallId. */
  installId: string
}

/**
 * A random id stored in the database the first time it is set up. Sign-in tokens carry it and each PC remembers it,
 * so after the database is reset old sign-ins stop working and PCs throw away their saved copy of the old data.
 */
async function ensureInstallId(connection: Connection): Promise<string> {
  const [rows] = await connection.query<RowDataPacket[]>("SELECT setting_value FROM system_settings WHERE setting_key = 'install_id'")
  if (rows[0]?.setting_value) return String(rows[0].setting_value)
  const id = randomUUID()
  await connection.query("INSERT INTO system_settings (setting_key, setting_value, description) VALUES ('install_id', ?, 'Identifies this database; changes when it is reset')", [id])
  return id
}

async function connect(env: Env): Promise<Connection> {
  return mysql.createConnection({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    multipleStatements: true,
    timezone: '+08:00',
    charset: 'utf8mb4_unicode_ci',
  })
}

async function appliedVersion(connection: Connection, database: string): Promise<number | null> {
  const [tables] = await connection.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
    [database, 'schema_migrations'],
  )
  if (Number(tables[0]?.n ?? 0) === 0) return null
  const [rows] = await connection.query<RowDataPacket[]>('SELECT MAX(version) AS version FROM schema_migrations')
  const version = rows[0]?.version
  return version === null || version === undefined ? 0 : Number(version)
}

/**
 * Applies database/migrations/NNN_*.sql for every version after `from`, in order, recording each in
 * schema_migrations. MySQL commits DDL immediately, so a file that fails halfway is not rolled back: the error
 * names the file so the half-applied statements can be checked by hand (or, in development, npm run db:reset).
 */
async function runMigrations(connection: Connection, env: Env, from: number): Promise<string[]> {
  const dir = path.join(env.DATABASE_DIR, 'migrations')
  const files = existsSync(dir) ? (await readdir(dir)).filter((name) => /^\d{3}_.+\.sql$/.test(name)).sort() : []
  const applied: string[] = []
  for (let version = from + 1; version <= SCHEMA_VERSION; version++) {
    const file = files.find((name) => Number(name.slice(0, 3)) === version)
    if (!file) throw new Error(`Missing database/migrations/${String(version).padStart(3, '0')}_*.sql for schema version ${version}.`)
    try {
      await connection.query(await readFile(path.join(dir, file), 'utf8'))
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    await connection.query('INSERT INTO schema_migrations (version, description) VALUES (?, ?)', [version, file])
    applied.push(file)
  }
  return applied
}

/**
 * Makes sure the system can be signed into: when no owner account exists (new database, or every owner removed)
 * it adds the default admin, flagged so the first sign-in must change the username, name and PIN.
 */
async function ensureDefaultOwner(connection: Connection): Promise<boolean> {
  const [owners] = await connection.query<RowDataPacket[]>(
    "SELECT 1 FROM users u JOIN roles r ON r.role_id = u.role_id WHERE r.role_name = 'Owner' AND u.pin_hash IS NOT NULL LIMIT 1",
  )
  if (owners.length) return false
  const [taken] = await connection.query<RowDataPacket[]>('SELECT 1 FROM users WHERE username = ?', [DEFAULT_OWNER.username])
  if (taken.length) throw new Error(`No owner account exists, but the username "${DEFAULT_OWNER.username}" is used by someone else. Rename that user, then restart.`)
  await connection.query(
    `INSERT INTO users (username, pin_hash, must_change_credentials, role_id, first_name, last_name, is_active)
     SELECT ?, ?, TRUE, role_id, ?, ?, TRUE FROM roles WHERE role_name = 'Owner'`,
    [DEFAULT_OWNER.username, await bcrypt.hash(DEFAULT_OWNER.pin, 12), DEFAULT_OWNER.first_name, DEFAULT_OWNER.last_name],
  )
  return true
}

/**
 * First run: creates the database, runs schema.sql, then seed.sql (and sample-data.sql when enabled)
 * in one transaction. Later runs apply pending migrations. Every run then makes sure an owner account exists
 * (the default admin on a new system).
 */
export async function initDatabase(env: Env, options: { reset?: boolean } = {}): Promise<DbInitResult> {
  const connection = await connect(env)
  const db = env.DB_NAME
  try {
    if (options.reset) await connection.query(`DROP DATABASE IF EXISTS \`${db}\``)
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    await connection.query(`USE \`${db}\``)
    await connection.query("SET time_zone = '+08:00'")

    const version = await appliedVersion(connection, db)
    if (version === 0) {
      throw new Error(`Database "${db}" was only partly set up by an earlier run. Back up anything you need, then run "npm run db:reset".`)
    }
    if (version !== null) {
      const migrated = version < SCHEMA_VERSION ? await runMigrations(connection, env, version) : []
      const defaultOwnerCreated = await ensureDefaultOwner(connection)
      const installId = await ensureInstallId(connection)
      return { created: false, schemaVersion: Math.max(version, SCHEMA_VERSION), sampleDataLoaded: false, migrated, defaultOwnerCreated, installId }
    }

    const schemaSql = await readFile(path.join(env.DATABASE_DIR, 'schema.sql'), 'utf8')
    const seedSql = await readFile(path.join(env.DATABASE_DIR, 'seed.sql'), 'utf8')

    const samplePath = path.join(env.DATABASE_DIR, 'sample-data.sql')
    const loadSample = env.LOAD_SAMPLE_DATA && existsSync(samplePath)
    const sampleSql = loadSample ? await readFile(samplePath, 'utf8') : ''

    // DDL commits implicitly in MySQL, so the schema runs on its own; data loads as one transaction.
    await connection.query(schemaSql)
    await connection.beginTransaction()
    try {
      await connection.query(seedSql)
      if (sampleSql) await connection.query(sampleSql)
      // schema.sql is version 1; runMigrations below records each later version.
      await connection.query('INSERT INTO schema_migrations (version, description) VALUES (?, ?)', [
        1,
        loadSample ? 'Initial schema, seed and sample data' : 'Initial schema and seed',
      ])
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    }
    // schema.sql is version 1; a new database then gets the same migrations as an upgraded one.
    const migrated = await runMigrations(connection, env, 1)
    const defaultOwnerCreated = await ensureDefaultOwner(connection)
    const installId = await ensureInstallId(connection)
    return { created: true, schemaVersion: SCHEMA_VERSION, sampleDataLoaded: loadSample, migrated, defaultOwnerCreated, installId }
  } finally {
    await connection.end()
  }
}