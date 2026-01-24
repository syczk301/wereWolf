import type { Collection, Document, Db } from 'mongodb'
import { MongoClient } from 'mongodb'
import { envConfig } from '../../shared/env.js'

let client: MongoClient | null = null
let forceMemory = false

type MemDoc = Record<string, any> & { _id: string }
type MemCollection = {
  findOne: (filter: any) => Promise<any | null>
  insertOne: (doc: any) => Promise<void>
  updateOne: (filter: any, update: any) => Promise<void>
  updateMany: (filter: any, update: any) => Promise<void>
  find: (filter: any) => { sort: (spec: any) => any; limit: (n: number) => any; toArray: () => Promise<any[]> }
}

const memStore = {
  users: new Map<string, MemDoc>(),
  rooms: new Map<string, MemDoc>(),
  games: new Map<string, MemDoc>(),
  replays: new Map<string, MemDoc>(),
}

function matchFilter(doc: any, filter: any): boolean {
  if (!filter || Object.keys(filter).length === 0) return true

  for (const [key, val] of Object.entries(filter)) {
    if (key === '$or' && Array.isArray(val)) {
      if (!val.some((sub) => matchFilter(doc, sub))) return false
      continue
    }

    if (val && typeof val === 'object' && !Array.isArray(val)) {
      if ('$in' in val) {
        const list = (val as any).$in
        if (!Array.isArray(list) || !list.includes(doc[key])) return false
        continue
      }

      if (key === 'ownerUserIds') {
        const ids = Array.isArray(doc.ownerUserIds) ? doc.ownerUserIds : []
        if (!ids.includes(val)) return false
        continue
      }
    }

    if (key === 'ownerUserIds') {
      const ids = Array.isArray(doc.ownerUserIds) ? doc.ownerUserIds : []
      if (!ids.includes(val)) return false
      continue
    }

    if (doc[key] !== val) return false
  }

  return true
}

function applyUpdate(doc: any, update: any) {
  if (!update || typeof update !== 'object') return

  if (update.$set && typeof update.$set === 'object') {
    Object.assign(doc, update.$set)
  }

  if (update.$addToSet && typeof update.$addToSet === 'object') {
    for (const [k, v] of Object.entries(update.$addToSet)) {
      if (!Array.isArray(doc[k])) doc[k] = []
      if (!doc[k].includes(v)) doc[k].push(v)
    }
  }

  if (update.$pull && typeof update.$pull === 'object') {
    for (const [k, v] of Object.entries(update.$pull)) {
      if (!Array.isArray(doc[k])) continue
      doc[k] = doc[k].filter((x: any) => x !== v)
    }
  }
}

function createMemCollection(map: Map<string, MemDoc>): MemCollection {
  return {
    async findOne(filter: any) {
      for (const d of map.values()) {
        if (matchFilter(d, filter)) return { ...d }
      }
      return null
    },
    async insertOne(doc: any) {
      const id = String(doc._id ?? doc.id)
      map.set(id, { ...(doc as any), _id: id })
    },
    async updateOne(filter: any, update: any) {
      for (const [id, d] of map.entries()) {
        if (!matchFilter(d, filter)) continue
        const next = { ...d }
        applyUpdate(next, update)
        map.set(id, next)
        return
      }
    },
    async updateMany(filter: any, update: any) {
      for (const [id, d] of map.entries()) {
        if (!matchFilter(d, filter)) continue
        const next = { ...d }
        applyUpdate(next, update)
        map.set(id, next)
      }
    },
    find(filter: any) {
      const base = [...map.values()].filter((d) => matchFilter(d, filter)).map((d) => ({ ...d }))
      let list = base
      const chain = {
        sort(spec: any) {
          const [field, dir] = Object.entries(spec ?? {})[0] ?? []
          if (field) {
            const mult = dir === -1 ? -1 : 1
            list = [...list].sort((a: any, b: any) => {
              const av = a[field]
              const bv = b[field]
              if (av === bv) return 0
              return av > bv ? mult : -mult
            })
          }
          return chain
        },
        limit(n: number) {
          list = list.slice(0, n)
          return chain
        },
        async toArray() {
          return list
        },
      }
      return chain
    },
  }
}

const memDb = {
  collection<TSchema extends Document = Document>(name: string): Collection<TSchema> {
    const map = (memStore as any)[name] as Map<string, MemDoc>
    if (!map) throw new Error('UNKNOWN_COLLECTION')
    return createMemCollection(map) as any
  },
}

export type DbLike = Pick<Db, 'collection'>

export async function getMongoClient(): Promise<MongoClient> {
  if (forceMemory) return { db: () => memDb } as any
  if (client) return client
  client = new MongoClient(envConfig.mongodbUri)
  try {
    await client.connect()
  } catch {
    client = null
    forceMemory = true
    return { db: () => memDb } as any
  }
  return client
}

export async function getDb() {
  const c = await getMongoClient()
  return (c as any).db() as DbLike
}

