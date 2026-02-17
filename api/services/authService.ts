import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { envConfig } from '../../shared/env.js'
import { getDb, isUsingMemoryDb } from '../db/mongo.js'
import { getRedis } from '../db/redis.js'

const jwtPayloadSchema = z.object({
  sub: z.string().min(1),
  sid: z.string().min(1),
  nickname: z.string().min(1),
  guest: z.boolean().optional(),
})

const fallbackUserSchema = z.object({
  id: z.string().min(1),
  emailOrUsername: z.string().min(1),
  nickname: z.string().min(1),
  passwordHash: z.string().min(1),
  createdAt: z.string().min(1),
  lastLoginAt: z.string().min(1),
})

type FallbackUser = z.infer<typeof fallbackUserSchema>
type UserDoc = {
  _id: string
  emailOrUsername: string
  nickname: string
  passwordHash: string
  createdAt: Date
  lastLoginAt: Date
}

export type ManagedUser = {
  id: string
  emailOrUsername: string
  nickname: string
  createdAt: string
  lastLoginAt: string
}

const FALLBACK_USER_ACCOUNT_PREFIX = 'auth:user:account:'
const FALLBACK_USER_ID_PREFIX = 'auth:user:id:'
const FALLBACK_USER_LEGACY_PREFIX = 'auth:user:'

const adminUserIdSet = new Set((envConfig.adminUserIds ?? []).map((id) => id.trim()).filter(Boolean))
const adminUsernameSet = new Set((envConfig.adminUsernames ?? []).map((name) => name.trim().toLowerCase()).filter(Boolean))

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function fallbackUserAccountKey(emailOrUsername: string) {
  return `${FALLBACK_USER_ACCOUNT_PREFIX}${encodeURIComponent(emailOrUsername)}`
}

function fallbackUserLegacyKey(emailOrUsername: string) {
  return `${FALLBACK_USER_LEGACY_PREFIX}${encodeURIComponent(emailOrUsername)}`
}

function fallbackUserIdKey(userId: string) {
  return `${FALLBACK_USER_ID_PREFIX}${userId}`
}

function parseFallbackUser(raw: unknown): FallbackUser | null {
  if (!raw) return null
  try {
    const text =
      typeof raw === 'string'
        ? raw
        : Buffer.isBuffer(raw)
          ? raw.toString('utf8')
          : String(raw)
    return fallbackUserSchema.parse(JSON.parse(text))
  } catch {
    return null
  }
}

function toRedisString(value: string | Buffer) {
  return typeof value === 'string' ? value : value.toString('utf8')
}

function toManagedUserFromFallback(user: FallbackUser): ManagedUser {
  return {
    id: user.id,
    emailOrUsername: user.emailOrUsername,
    nickname: user.nickname,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  }
}

function toManagedUserFromDoc(user: UserDoc): ManagedUser {
  return {
    id: user._id,
    emailOrUsername: user.emailOrUsername,
    nickname: user.nickname,
    createdAt: user.createdAt.toISOString(),
    lastLoginAt: user.lastLoginAt.toISOString(),
  }
}

async function getFallbackUserByAccount(emailOrUsername: string): Promise<FallbackUser | null> {
  const redis = await getRedis()
  const modern = await redis.get(fallbackUserAccountKey(emailOrUsername))
  const fromModern = parseFallbackUser(modern)
  if (fromModern) return fromModern

  const legacy = await redis.get(fallbackUserLegacyKey(emailOrUsername))
  return parseFallbackUser(legacy)
}

async function listFallbackUsers(): Promise<FallbackUser[]> {
  const redis = await getRedis()
  const keys = await redis.keys(`${FALLBACK_USER_LEGACY_PREFIX}*`)
  if (!keys.length) return []

  const users: FallbackUser[] = []
  const seen = new Set<string>()
  for (const keyRaw of keys) {
    const key = toRedisString(keyRaw)
    if (key.startsWith(FALLBACK_USER_ID_PREFIX)) continue
    const raw = await redis.get(key)
    const user = parseFallbackUser(raw)
    if (!user || seen.has(user.id)) continue
    seen.add(user.id)
    users.push(user)
  }
  return users
}

async function getFallbackUserById(userId: string): Promise<FallbackUser | null> {
  const redis = await getRedis()
  const accountRaw = await redis.get(fallbackUserIdKey(userId))
  if (accountRaw) {
    const fromIndexedAccount = await getFallbackUserByAccount(toRedisString(accountRaw))
    if (fromIndexedAccount) return fromIndexedAccount
  }

  const allUsers = await listFallbackUsers()
  return allUsers.find((user) => user.id === userId) ?? null
}

async function saveFallbackUser(user: FallbackUser) {
  const redis = await getRedis()
  const payload = JSON.stringify(user)
  await redis.set(fallbackUserAccountKey(user.emailOrUsername), payload)
  await redis.set(fallbackUserLegacyKey(user.emailOrUsername), payload)
  await redis.set(fallbackUserIdKey(user.id), user.emailOrUsername)
}

async function deleteFallbackUser(user: FallbackUser) {
  const redis = await getRedis()
  await redis.del([
    fallbackUserAccountKey(user.emailOrUsername),
    fallbackUserLegacyKey(user.emailOrUsername),
    fallbackUserIdKey(user.id),
  ])
}

async function clearSessionsForUser(userId: string) {
  const redis = await getRedis()
  const keys = await redis.keys('session:*')
  if (!keys.length) return

  const matched: string[] = []
  for (const keyRaw of keys) {
    const key = toRedisString(keyRaw)
    const sidUserId = await redis.get(key)
    if (sidUserId && toRedisString(sidUserId) === userId) matched.push(key)
  }

  if (matched.length) {
    await redis.del(matched)
  }
}

async function getUserDocById(userId: string): Promise<UserDoc | null> {
  await getDb()
  if (isUsingMemoryDb()) {
    const fallbackUser = await getFallbackUserById(userId)
    if (!fallbackUser) return null
    return {
      _id: fallbackUser.id,
      emailOrUsername: fallbackUser.emailOrUsername,
      nickname: fallbackUser.nickname,
      passwordHash: fallbackUser.passwordHash,
      createdAt: new Date(fallbackUser.createdAt),
      lastLoginAt: new Date(fallbackUser.lastLoginAt),
    }
  }

  const db = await getDb()
  const users = db.collection<UserDoc>('users')
  return await users.findOne({ _id: userId })
}

export async function isAdminUser(userId: string) {
  if (!userId || userId.startsWith('guest:')) return false
  if (adminUserIdSet.has(userId)) return true
  if (!adminUsernameSet.size) return false

  const user = await getUserDocById(userId)
  if (!user) return false
  return adminUsernameSet.has(user.emailOrUsername.toLowerCase())
}

export async function listManagedUsers(input?: { query?: string; limit?: number }): Promise<ManagedUser[]> {
  const query = String(input?.query ?? '').trim().toLowerCase()
  const limit = Math.max(1, Math.min(Number(input?.limit ?? 200), 500))

  await getDb()
  if (isUsingMemoryDb()) {
    const users = await listFallbackUsers()
    const filtered = query
      ? users.filter((user) => {
          const fields = [user.id, user.emailOrUsername, user.nickname]
          return fields.some((field) => field.toLowerCase().includes(query))
        })
      : users

    return filtered
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(toManagedUserFromFallback)
  }

  const db = await getDb()
  const users = db.collection<UserDoc>('users')
  const filter = query
    ? {
        $or: [
          { _id: { $regex: escapeRegex(query), $options: 'i' } },
          { emailOrUsername: { $regex: escapeRegex(query), $options: 'i' } },
          { nickname: { $regex: escapeRegex(query), $options: 'i' } },
        ],
      }
    : {}

  const docs = await users.find(filter as any).sort({ createdAt: -1 }).limit(limit).toArray()
  return docs.map((doc) => toManagedUserFromDoc(doc as UserDoc))
}

export async function updateManagedUser(userId: string, patch: { nickname?: string; password?: string }): Promise<ManagedUser> {
  if (!userId || userId.startsWith('guest:')) throw new Error('INVALID_USER')

  const nextNickname = typeof patch.nickname === 'string' ? patch.nickname.trim().slice(0, 20) : undefined
  const nextPassword = typeof patch.password === 'string' ? patch.password : undefined
  if (!nextNickname && !nextPassword) throw new Error('INVALID_PATCH')

  await getDb()
  if (isUsingMemoryDb()) {
    const user = await getFallbackUserById(userId)
    if (!user) throw new Error('NOT_FOUND')

    if (nextNickname) user.nickname = nextNickname
    if (nextPassword) user.passwordHash = await bcrypt.hash(nextPassword, 10)
    await saveFallbackUser(user)
    return toManagedUserFromFallback(user)
  }

  const db = await getDb()
  const users = db.collection<UserDoc>('users')
  const current = await users.findOne({ _id: userId })
  if (!current) throw new Error('NOT_FOUND')

  const toSet: Partial<UserDoc> = {}
  if (nextNickname) toSet.nickname = nextNickname
  if (nextPassword) toSet.passwordHash = await bcrypt.hash(nextPassword, 10)
  await users.updateOne({ _id: userId }, { $set: toSet })

  return toManagedUserFromDoc({ ...current, ...toSet })
}

export async function deleteManagedUser(userId: string) {
  if (!userId || userId.startsWith('guest:')) throw new Error('INVALID_USER')

  await getDb()
  if (isUsingMemoryDb()) {
    const user = await getFallbackUserById(userId)
    if (!user) throw new Error('NOT_FOUND')
    await deleteFallbackUser(user)
    await clearSessionsForUser(userId)
    return
  }

  const db = await getDb()
  const users = db.collection<UserDoc>('users')
  const result = await users.deleteOne({ _id: userId })
  if (!result?.deletedCount) throw new Error('NOT_FOUND')
  await clearSessionsForUser(userId)
}

export async function registerUser(input: {
  emailOrUsername: string
  password: string
  nickname: string
}) {
  await getDb()
  if (isUsingMemoryDb()) {
    const exists = await getFallbackUserByAccount(input.emailOrUsername)
    if (exists) throw new Error('账号已存在')

    const passwordHash = await bcrypt.hash(input.password, 10)
    const nowIso = new Date().toISOString()
    const userId = nanoid(12)

    await saveFallbackUser({
      id: userId,
      emailOrUsername: input.emailOrUsername,
      nickname: input.nickname,
      passwordHash,
      createdAt: nowIso,
      lastLoginAt: nowIso,
    })

    return { id: userId, nickname: input.nickname }
  }

  const db = await getDb()
  const users = db.collection<UserDoc>('users')

  const exists = await users.findOne({ emailOrUsername: input.emailOrUsername })
  if (exists) throw new Error('账号已存在')

  const passwordHash = await bcrypt.hash(input.password, 10)
  const now = new Date()
  const userId = nanoid(12)

  await users.insertOne({
    _id: userId,
    emailOrUsername: input.emailOrUsername,
    nickname: input.nickname,
    passwordHash,
    createdAt: now,
    lastLoginAt: now,
  })

  return { id: userId, nickname: input.nickname }
}

export async function loginUser(input: { emailOrUsername: string; password: string }) {
  await getDb()
  if (isUsingMemoryDb()) {
    const user = await getFallbackUserByAccount(input.emailOrUsername)
    if (!user) throw new Error('账号或密码错误')

    const ok = await bcrypt.compare(input.password, user.passwordHash)
    if (!ok) throw new Error('账号或密码错误')

    user.lastLoginAt = new Date().toISOString()
    await saveFallbackUser(user)

    const sessionId = nanoid(24)
    const redis = await getRedis()
    await redis.set(`session:${sessionId}`, user.id, { EX: 60 * 60 * 24 * 30 })

    const token = jwt.sign({ sub: user.id, sid: sessionId, nickname: user.nickname }, envConfig.jwtSecret, {
      expiresIn: '30d',
    })

    return { accessToken: token, user: { id: user.id, nickname: user.nickname, isGuest: false as const } }
  }

  const db = await getDb()
  const users = db.collection<UserDoc>('users')

  const user = await users.findOne({
    emailOrUsername: input.emailOrUsername,
  })

  if (!user) {
    throw new Error('账号或密码错误')
  }

  const ok = await bcrypt.compare(input.password, user.passwordHash)
  if (!ok) throw new Error('账号或密码错误')

  await users.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } })

  const sessionId = nanoid(24)
  const redis = await getRedis()
  await redis.set(`session:${sessionId}`, user._id, { EX: 60 * 60 * 24 * 30 })

  const token = jwt.sign({ sub: user._id, sid: sessionId, nickname: user.nickname }, envConfig.jwtSecret, {
    expiresIn: '30d',
  })

  return { accessToken: token, user: { id: user._id, nickname: user.nickname, isGuest: false as const } }
}

export async function guestLogin(input?: { nickname?: string }) {
  const nick = (input?.nickname || '').trim().slice(0, 20)
  const guestId = `guest:${nanoid(10)}`
  const nickname = nick || `游客${Math.floor(Math.random() * 9000 + 1000)}`

  const sessionId = nanoid(24)
  const redis = await getRedis()
  await redis.set(`session:${sessionId}`, guestId, { EX: 60 * 60 * 24 * 7 })

  const token = jwt.sign({ sub: guestId, sid: sessionId, nickname, guest: true }, envConfig.jwtSecret, {
    expiresIn: '7d',
  })

  return { accessToken: token, user: { id: guestId, nickname, isGuest: true as const } }
}

export async function upgradeGuestToUser(input: {
  token: string
  emailOrUsername: string
  password: string
  nickname?: string
}) {
  const decoded = jwt.verify(input.token, envConfig.jwtSecret)
  const parsed = jwtPayloadSchema.parse(decoded)
  if (!parsed.sub.startsWith('guest:')) throw new Error('NOT_GUEST')

  await getDb()
  if (isUsingMemoryDb()) {
    const exists = await getFallbackUserByAccount(input.emailOrUsername)
    if (exists) throw new Error('账号已存在')

    const nickname = (input.nickname?.trim() || parsed.nickname).slice(0, 20)
    const passwordHash = await bcrypt.hash(input.password, 10)
    const nowIso = new Date().toISOString()
    const userId = nanoid(12)

    await saveFallbackUser({
      id: userId,
      emailOrUsername: input.emailOrUsername,
      nickname,
      passwordHash,
      createdAt: nowIso,
      lastLoginAt: nowIso,
    })

    const redis = await getRedis()
    await redis.del(`session:${parsed.sid}`)

    const sessionId = nanoid(24)
    await redis.set(`session:${sessionId}`, userId, { EX: 60 * 60 * 24 * 30 })

    const token = jwt.sign({ sub: userId, sid: sessionId, nickname }, envConfig.jwtSecret, {
      expiresIn: '30d',
    })

    return { accessToken: token, user: { id: userId, nickname, isGuest: false as const } }
  }

  const db = await getDb()
  const users = db.collection<UserDoc>('users')

  const exists = await users.findOne({ emailOrUsername: input.emailOrUsername })
  if (exists) throw new Error('账号已存在')

  const nickname = (input.nickname?.trim() || parsed.nickname).slice(0, 20)
  const passwordHash = await bcrypt.hash(input.password, 10)
  const now = new Date()
  const userId = nanoid(12)

  await users.insertOne({
    _id: userId,
    emailOrUsername: input.emailOrUsername,
    nickname,
    passwordHash,
    createdAt: now,
    lastLoginAt: now,
  })

  const redis = await getRedis()
  await redis.del(`session:${parsed.sid}`)

  const sessionId = nanoid(24)
  await redis.set(`session:${sessionId}`, userId, { EX: 60 * 60 * 24 * 30 })

  try {
    await db
      .collection<any>('replays')
      .updateMany(
        { ownerUserIds: parsed.sub },
        ({ $addToSet: { ownerUserIds: userId }, $pull: { ownerUserIds: parsed.sub } } as any),
      )
  } catch {
    return {
      accessToken: jwt.sign({ sub: userId, sid: sessionId, nickname }, envConfig.jwtSecret, { expiresIn: '30d' }),
      user: { id: userId, nickname, isGuest: false as const },
    }
  }

  const token = jwt.sign({ sub: userId, sid: sessionId, nickname }, envConfig.jwtSecret, {
    expiresIn: '30d',
  })

  return { accessToken: token, user: { id: userId, nickname, isGuest: false as const } }
}

export async function logoutToken(token: string) {
  const decoded = jwt.verify(token, envConfig.jwtSecret)
  const parsed = jwtPayloadSchema.safeParse(decoded)
  if (!parsed.success) return
  const redis = await getRedis()
  await redis.del(`session:${parsed.data.sid}`)
}

export async function verifyAccessToken(token: string) {
  const decoded = jwt.verify(token, envConfig.jwtSecret)
  const parsed = jwtPayloadSchema.parse(decoded)

  const redis = await getRedis()
  const userIdRaw = await redis.get(`session:${parsed.sid}`)
  const userId = userIdRaw ? toRedisString(userIdRaw) : ''
  if (!userId || userId !== parsed.sub) throw new Error('UNAUTHORIZED')

  return { id: parsed.sub, nickname: parsed.nickname, isGuest: parsed.sub.startsWith('guest:') }
}
