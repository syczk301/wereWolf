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
  username: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  emailOrUsername: z.string().min(1).optional(),
  nickname: z.string().min(1),
  passwordHash: z.string().min(1),
  createdAt: z.string().min(1),
  lastLoginAt: z.string().min(1),
})

type FallbackUser = z.infer<typeof fallbackUserSchema>
type UserDoc = {
  _id: string
  username?: string
  email?: string
  emailOrUsername?: string
  nickname: string
  passwordHash: string
  createdAt: Date
  lastLoginAt: Date
}

export type ManagedUser = {
  id: string
  emailOrUsername: string
  username?: string
  email?: string
  nickname: string
  createdAt: string
  lastLoginAt: string
}

const FALLBACK_USER_ACCOUNT_PREFIX = 'auth:user:account:'
const FALLBACK_USER_LEGACY_PREFIX = 'auth:user:'
const FALLBACK_USER_ID_PREFIX = 'auth:user:id:'
const FALLBACK_USER_USERNAME_PREFIX = 'auth:user:username:'
const FALLBACK_USER_EMAIL_PREFIX = 'auth:user:email:'

const adminUserIdSet = new Set((envConfig.adminUserIds ?? []).map((id) => id.trim()).filter(Boolean))
const adminUsernameSet = new Set((envConfig.adminUsernames ?? []).map((name) => name.trim().toLowerCase()).filter(Boolean))

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function toRedisString(value: string | Buffer) {
  return typeof value === 'string' ? value : value.toString('utf8')
}

function isEmailLike(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

function normalizeUsername(value: string) {
  return value.trim()
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase()
}

function fallbackUserAccountKey(account: string) {
  return `${FALLBACK_USER_ACCOUNT_PREFIX}${encodeURIComponent(account)}`
}

function fallbackUserLegacyKey(account: string) {
  return `${FALLBACK_USER_LEGACY_PREFIX}${encodeURIComponent(account)}`
}

function fallbackUserIdKey(userId: string) {
  return `${FALLBACK_USER_ID_PREFIX}${userId}`
}

function fallbackUsernameKey(username: string) {
  return `${FALLBACK_USER_USERNAME_PREFIX}${encodeURIComponent(username.toLowerCase())}`
}

function fallbackEmailKey(email: string) {
  return `${FALLBACK_USER_EMAIL_PREFIX}${encodeURIComponent(email.toLowerCase())}`
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

function resolveUserIdentity(user: {
  username?: string
  email?: string
  emailOrUsername?: string
}) {
  const username = normalizeUsername(
    user.username || (user.emailOrUsername && !isEmailLike(user.emailOrUsername) ? user.emailOrUsername : ''),
  )
  const email = normalizeEmail(
    user.email || (user.emailOrUsername && isEmailLike(user.emailOrUsername) ? user.emailOrUsername : ''),
  )
  const emailOrUsername = normalizeUsername(user.emailOrUsername || username || email)
  const primaryAccount = username || emailOrUsername || email
  return { username, email, emailOrUsername, primaryAccount }
}

function toManagedUserFromFallback(user: FallbackUser): ManagedUser {
  const identity = resolveUserIdentity(user)
  return {
    id: user.id,
    emailOrUsername: identity.emailOrUsername || identity.username || identity.email,
    username: identity.username || undefined,
    email: identity.email || undefined,
    nickname: user.nickname,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  }
}

function toManagedUserFromDoc(user: UserDoc): ManagedUser {
  const identity = resolveUserIdentity(user)
  return {
    id: user._id,
    emailOrUsername: identity.emailOrUsername || identity.username || identity.email,
    username: identity.username || undefined,
    email: identity.email || undefined,
    nickname: user.nickname,
    createdAt: user.createdAt.toISOString(),
    lastLoginAt: user.lastLoginAt.toISOString(),
  }
}

function buildMongoAccountFilter(rawAccount: string) {
  const account = rawAccount.trim()
  const accountLower = account.toLowerCase()
  return {
    $or: [
      { username: { $regex: `^${escapeRegex(account)}$`, $options: 'i' } },
      { email: accountLower },
      { emailOrUsername: { $regex: `^${escapeRegex(account)}$`, $options: 'i' } },
    ],
  }
}

function buildMongoIdentityExistsFilter(rawUsername: string, rawEmail: string) {
  const username = normalizeUsername(rawUsername)
  const email = normalizeEmail(rawEmail)
  return {
    $or: [
      { username: { $regex: `^${escapeRegex(username)}$`, $options: 'i' } },
      { email },
      { emailOrUsername: { $regex: `^${escapeRegex(username)}$`, $options: 'i' } },
      { emailOrUsername: email },
    ],
  }
}

function buildMongoEmailIdentityFilter(rawEmail: string) {
  const email = normalizeEmail(rawEmail)
  return {
    $or: [
      { email },
      { emailOrUsername: { $regex: `^${escapeRegex(email)}$`, $options: 'i' } },
    ],
  }
}

async function getFallbackUserByAccountAlias(account: string): Promise<FallbackUser | null> {
  const target = account.trim()
  if (!target) return null
  const redis = await getRedis()

  const modern = await redis.get(fallbackUserAccountKey(target))
  const fromModern = parseFallbackUser(modern)
  if (fromModern) return fromModern

  const legacy = await redis.get(fallbackUserLegacyKey(target))
  return parseFallbackUser(legacy)
}

async function getFallbackUserByLookup(rawAccount: string): Promise<FallbackUser | null> {
  const account = rawAccount.trim()
  if (!account) return null
  const redis = await getRedis()

  if (isEmailLike(account)) {
    const email = normalizeEmail(account)
    const emailAliasRaw = await redis.get(fallbackEmailKey(email))
    if (emailAliasRaw) {
      const fromEmailIndex = await getFallbackUserByAccountAlias(toRedisString(emailAliasRaw))
      if (fromEmailIndex) return fromEmailIndex
    }
  }

  const usernameAliasRaw = await redis.get(fallbackUsernameKey(account))
  if (usernameAliasRaw) {
    const fromUsernameIndex = await getFallbackUserByAccountAlias(toRedisString(usernameAliasRaw))
    if (fromUsernameIndex) return fromUsernameIndex
  }

  const directCandidates = Array.from(new Set([account, account.toLowerCase()])).filter(Boolean)
  for (const candidate of directCandidates) {
    const byAlias = await getFallbackUserByAccountAlias(candidate)
    if (byAlias) return byAlias
  }

  return null
}

async function getFallbackUserByEmail(rawEmail: string): Promise<FallbackUser | null> {
  const email = normalizeEmail(rawEmail)
  if (!email) return null

  const user = await getFallbackUserByLookup(email)
  if (!user) return null

  const identity = resolveUserIdentity(user)
  if (!identity.email || identity.email !== email) return null
  return user
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
    if (key.startsWith(FALLBACK_USER_USERNAME_PREFIX)) continue
    if (key.startsWith(FALLBACK_USER_EMAIL_PREFIX)) continue
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
    const fromIndexedAccount = await getFallbackUserByAccountAlias(toRedisString(accountRaw))
    if (fromIndexedAccount) return fromIndexedAccount
  }

  const allUsers = await listFallbackUsers()
  return allUsers.find((user) => user.id === userId) ?? null
}

async function saveFallbackUser(user: FallbackUser) {
  const redis = await getRedis()
  const payload = JSON.stringify(user)
  const identity = resolveUserIdentity(user)
  if (!identity.primaryAccount) throw new Error('INVALID_USER')

  await redis.set(fallbackUserAccountKey(identity.primaryAccount), payload)
  await redis.set(fallbackUserLegacyKey(identity.primaryAccount), payload)
  await redis.set(fallbackUserIdKey(user.id), identity.primaryAccount)

  if (identity.emailOrUsername && identity.emailOrUsername !== identity.primaryAccount) {
    await redis.set(fallbackUserAccountKey(identity.emailOrUsername), payload)
    await redis.set(fallbackUserLegacyKey(identity.emailOrUsername), payload)
  }

  if (identity.username) {
    await redis.set(fallbackUsernameKey(identity.username), identity.primaryAccount)
  }
  if (identity.email) {
    await redis.set(fallbackEmailKey(identity.email), identity.primaryAccount)
  }
}

async function deleteFallbackUser(user: FallbackUser) {
  const redis = await getRedis()
  const identity = resolveUserIdentity(user)
  const keys = new Set<string>()

  if (identity.primaryAccount) {
    keys.add(fallbackUserAccountKey(identity.primaryAccount))
    keys.add(fallbackUserLegacyKey(identity.primaryAccount))
  }
  if (identity.emailOrUsername) {
    keys.add(fallbackUserAccountKey(identity.emailOrUsername))
    keys.add(fallbackUserLegacyKey(identity.emailOrUsername))
  }
  if (identity.username) keys.add(fallbackUsernameKey(identity.username))
  if (identity.email) keys.add(fallbackEmailKey(identity.email))
  keys.add(fallbackUserIdKey(user.id))

  await redis.del([...keys])
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

function toUserDocFromFallback(user: FallbackUser): UserDoc {
  const identity = resolveUserIdentity(user)
  return {
    _id: user.id,
    username: identity.username || undefined,
    email: identity.email || undefined,
    emailOrUsername: identity.emailOrUsername || undefined,
    nickname: user.nickname,
    passwordHash: user.passwordHash,
    createdAt: new Date(user.createdAt),
    lastLoginAt: new Date(user.lastLoginAt),
  }
}

async function getUserDocById(userId: string): Promise<UserDoc | null> {
  await getDb()
  if (isUsingMemoryDb()) {
    const fallbackUser = await getFallbackUserById(userId)
    if (!fallbackUser) return null
    return toUserDocFromFallback(fallbackUser)
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

  const identity = resolveUserIdentity(user)
  const candidates = [identity.username, identity.emailOrUsername, identity.email]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase())
  return candidates.some((candidate) => adminUsernameSet.has(candidate))
}

export async function listManagedUsers(input?: { query?: string; limit?: number }): Promise<ManagedUser[]> {
  const query = String(input?.query ?? '').trim().toLowerCase()
  const limit = Math.max(1, Math.min(Number(input?.limit ?? 200), 500))

  await getDb()
  if (isUsingMemoryDb()) {
    const users = await listFallbackUsers()
    const filtered = query
      ? users.filter((user) => {
          const identity = resolveUserIdentity(user)
          const fields = [user.id, identity.username, identity.email, identity.emailOrUsername, user.nickname]
          return fields.some((field) => String(field ?? '').toLowerCase().includes(query))
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
          { username: { $regex: escapeRegex(query), $options: 'i' } },
          { email: { $regex: escapeRegex(query), $options: 'i' } },
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
  username: string
  email: string
  password: string
  nickname: string
}) {
  const username = normalizeUsername(input.username)
  const email = normalizeEmail(input.email)
  const nickname = input.nickname.trim()
  if (!username) throw new Error('USERNAME_REQUIRED')
  if (!email) throw new Error('EMAIL_REQUIRED')

  await getDb()
  if (isUsingMemoryDb()) {
    const usernameExists = await getFallbackUserByLookup(username)
    if (usernameExists) throw new Error('账号已存在')
    const emailExists = await getFallbackUserByLookup(email)
    if (emailExists) throw new Error('账号已存在')

    const passwordHash = await bcrypt.hash(input.password, 10)
    const nowIso = new Date().toISOString()
    const userId = nanoid(12)

    await saveFallbackUser({
      id: userId,
      username,
      email,
      emailOrUsername: username,
      nickname,
      passwordHash,
      createdAt: nowIso,
      lastLoginAt: nowIso,
    })

    return { id: userId, nickname }
  }

  const db = await getDb()
  const users = db.collection<UserDoc>('users')

  const exists = await users.findOne(buildMongoIdentityExistsFilter(username, email) as any)
  if (exists) throw new Error('账号已存在')

  const passwordHash = await bcrypt.hash(input.password, 10)
  const now = new Date()
  const userId = nanoid(12)

  await users.insertOne({
    _id: userId,
    username,
    email,
    emailOrUsername: username,
    nickname,
    passwordHash,
    createdAt: now,
    lastLoginAt: now,
  })

  return { id: userId, nickname }
}

export async function loginUser(input: { emailOrUsername: string; password: string }) {
  const account = input.emailOrUsername.trim()
  if (!account) throw new Error('账号或密码错误')

  await getDb()
  if (isUsingMemoryDb()) {
    const user = await getFallbackUserByLookup(account)
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
  const user = await users.findOne(buildMongoAccountFilter(account) as any)
  if (!user) throw new Error('账号或密码错误')

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

export async function isEmailRegistered(rawEmail: string) {
  const email = normalizeEmail(rawEmail)
  if (!email) return false

  await getDb()
  if (isUsingMemoryDb()) {
    const user = await getFallbackUserByEmail(email)
    return !!user
  }

  const db = await getDb()
  const users = db.collection<UserDoc>('users')
  const user = await users.findOne(buildMongoEmailIdentityFilter(email) as any, {
    projection: { _id: 1 },
  })
  return !!user
}

export async function resetPasswordByEmail(input: { email: string; newPassword: string }) {
  const email = normalizeEmail(input.email)
  if (!email) throw new Error('EMAIL_REQUIRED')
  if (!input.newPassword || input.newPassword.length < 6) throw new Error('INVALID_INPUT')

  await getDb()
  if (isUsingMemoryDb()) {
    const user = await getFallbackUserByEmail(email)
    if (!user) throw new Error('EMAIL_NOT_FOUND')

    user.passwordHash = await bcrypt.hash(input.newPassword, 10)
    await saveFallbackUser(user)
    await clearSessionsForUser(user.id)
    return
  }

  const db = await getDb()
  const users = db.collection<UserDoc>('users')
  const user = await users.findOne(buildMongoEmailIdentityFilter(email) as any, {
    projection: { _id: 1 },
  })
  if (!user) throw new Error('EMAIL_NOT_FOUND')

  const passwordHash = await bcrypt.hash(input.newPassword, 10)
  await users.updateOne({ _id: user._id }, { $set: { passwordHash } })
  await clearSessionsForUser(user._id)
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
  username: string
  email: string
  password: string
  nickname?: string
}) {
  const decoded = jwt.verify(input.token, envConfig.jwtSecret)
  const parsed = jwtPayloadSchema.parse(decoded)
  if (!parsed.sub.startsWith('guest:')) throw new Error('NOT_GUEST')

  const username = normalizeUsername(input.username)
  const email = normalizeEmail(input.email)
  if (!username) throw new Error('USERNAME_REQUIRED')
  if (!email) throw new Error('EMAIL_REQUIRED')

  await getDb()
  if (isUsingMemoryDb()) {
    const usernameExists = await getFallbackUserByLookup(username)
    if (usernameExists) throw new Error('账号已存在')
    const emailExists = await getFallbackUserByLookup(email)
    if (emailExists) throw new Error('账号已存在')

    const nickname = (input.nickname?.trim() || parsed.nickname).slice(0, 20)
    const passwordHash = await bcrypt.hash(input.password, 10)
    const nowIso = new Date().toISOString()
    const userId = nanoid(12)

    await saveFallbackUser({
      id: userId,
      username,
      email,
      emailOrUsername: username,
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
  const exists = await users.findOne(buildMongoIdentityExistsFilter(username, email) as any)
  if (exists) throw new Error('账号已存在')

  const nickname = (input.nickname?.trim() || parsed.nickname).slice(0, 20)
  const passwordHash = await bcrypt.hash(input.password, 10)
  const now = new Date()
  const userId = nanoid(12)

  await users.insertOne({
    _id: userId,
    username,
    email,
    emailOrUsername: username,
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
