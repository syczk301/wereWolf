import { createClient } from 'redis'
import { envConfig } from '../config.js'

let client: ReturnType<typeof createClient> | null = null

const fallbackKv = new Map<string, string>()
const fallbackSets = new Map<string, Set<string>>()

function createFallbackClient() {
  const c: any = {
    __fallback: true,
    async connect() {
      return
    },
    duplicate() {
      return c
    },
    async get(key: string) {
      return fallbackKv.get(key) ?? null
    },
    async set(key: string, value: string, _opts?: any) {
      fallbackKv.set(key, value)
      return 'OK'
    },
    async del(key: string) {
      const existed = fallbackKv.delete(key)
      fallbackSets.delete(key)
      return existed ? 1 : 0
    },
    async sAdd(key: string, member: string) {
      const s = fallbackSets.get(key) ?? new Set<string>()
      const before = s.size
      s.add(member)
      fallbackSets.set(key, s)
      return s.size - before
    },
    async sRem(key: string, member: string) {
      const s = fallbackSets.get(key)
      if (!s) return 0
      const existed = s.delete(member)
      return existed ? 1 : 0
    },
    async sMembers(key: string) {
      const s = fallbackSets.get(key) ?? new Set<string>()
      return [...s]
    },
    async keys(pattern: string) {
      // Simple pattern matching for roomrt:* style patterns
      const prefix = pattern.replace('*', '')
      const results: string[] = []
      for (const k of fallbackKv.keys()) {
        if (k.startsWith(prefix)) {
          results.push(k)
        }
      }
      return results
    },
    async exists(key: string) {
      return fallbackKv.has(key) ? 1 : 0
    },
  }
  return c
}

export async function getRedis() {
  if (client) return client

  client = createClient({ url: envConfig.redisUrl })
  try {
    await client.connect()
  } catch {
    client = createFallbackClient()
    await (client as any).connect()
  }
  return client
}
