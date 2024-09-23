import {
  bundleRequire,
  type Options as BundleRequireOptions,
} from 'bundle-require'
import { watch } from 'chokidar'
import mri from 'mri'
import path from 'node:path'
import { Client, ConnectionError } from 'pg-nano'
import { sql } from 'pg-native'
import { camel, mapKeys } from 'radashi'
import { resolveConfig, type UserConfig } from './config/config.js'
import { findConfigFile } from './config/findConfigFile.js'
import { allMigrationHazardTypes } from './config/hazards.js'
import { debug } from './debug.js'
import { events } from './events.js'
import { log } from './log.js'

export type EnvOptions = {
  dsn?: string
  verbose?: boolean
  watch?: boolean
  /** Skip cache and reload environment */
  reloadEnv?: boolean
}

const cache = new Map<string, Promise<Env>>()

export type Env = Awaited<ReturnType<typeof loadEnv>>

export function getEnv(cwd: string, options: EnvOptions = {}) {
  const key = JSON.stringify([cwd, options.dsn])

  let env = cache.get(key)
  if (env) {
    if (!options.reloadEnv) {
      return env
    }
    env.then(env => env.close())
  }

  env = loadEnv(cwd, options)
  cache.set(key, env)
  return env
}


async function loadEnv(cwd: string, options: EnvOptions) {
  const configFilePath = findConfigFile(cwd)
  const root = configFilePath ? path.dirname(configFilePath) : cwd
  const untrackedDir = path.join(root, 'node_modules/.pg-nano')
  const schemaDir = path.join(untrackedDir, 'schema')

  let userConfig: UserConfig | undefined
  let userConfigDependencies: string[] = []

  if (configFilePath) {
    const options: Partial<BundleRequireOptions> = {}
    if (process.env.BUNDLE_REQUIRE_OPTIONS) {
      const { default: stringArgv } = await import('string-argv')
      const rawOptions = stringArgv(process.env.BUNDLE_REQUIRE_OPTIONS)
      const { '': _, ...parsedOptions } = mapKeys(mri(rawOptions), key =>
        camel(key),
      )
      if (debug.enabled) {
        log('Using BUNDLE_REQUIRE_OPTIONS →', parsedOptions)
      }
      Object.assign(options, parsedOptions)
    }
    events.emit('load-config', { configFilePath })
    const result = await bundleRequire({
      ...options,
      filepath: configFilePath,
    })
    userConfig = result.mod.default
    userConfigDependencies = result.dependencies.map(dep => path.resolve(dep))
  }

  const config = resolveConfig(root, userConfig, options)

  // https://github.com/stripe/pg-schema-diff/issues/129
  config.migration.allowHazards.push('HAS_UNTRACKABLE_DEPENDENCIES' as any)

  // Enable unsafe mode for local development.
  if (config.dev.connectionString.includes('localhost')) {
    config.migration.allowHazards.push(...allMigrationHazardTypes)
  } else {
    throw new Error('Non-local databases are not currently supported')
  }

  let client: Promise<Client> | undefined

  return {
    root,
    configFilePath: configFilePath && path.relative(root, configFilePath),
    configDependencies: userConfigDependencies,
    config,
    untrackedDir,
    schemaDir,
    verbose: options.verbose,
    watcher: options.watch
      ? watch([...config.schema.include, ...userConfigDependencies], {
        cwd: root,
        ignored: [
          ...config.schema.exclude,
          config.generate.pluginSqlDir,
          '**/.pg-nano/**',
        ],
      })
      : undefined,
    get client() {
      return (client ??= (async () => {
        events.emit('connect', config.dev.connectionString)

        const isDatabaseExistsClient = new Client({
          maxRetries: 3,
        })
        const dsn = new URL(config.dev.connectionString!);
        const databaseName = dsn.pathname?.slice(1);
        if (!databaseName.trim()) {
          throw new ConnectionError("databaseName is empty");
        }
        dsn.pathname = "/postgres"
        const createDsn = dsn.toString()
        try {
          await isDatabaseExistsClient.connect(createDsn);
          // create database if it doesn't exist
          await isDatabaseExistsClient.query(sql`
            CREATE DATABASE ${[{ type: "id", id: databaseName }]}
          `)
          log(`DATABASE: ${databaseName} CREATED`)
        } catch (error) {
          /**
           * 1. connection error
           * 2. database already exists
           *  database "2" already exists
           */
          const regex = /database\s"(\w+)"\salready\sexists/;
          if (!regex.test((error as Error)?.message)) {
            throw error
          }
        }

        const client = new Client()

        await client.connect(config.dev.connectionString)
        await client.query(sql`
          SET client_min_messages TO WARNING;
        `)

        return client
      })())
    },
    async close() {
      return client?.then(client => client.close())
    },
  }
}
