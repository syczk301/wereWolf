import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { config } from '../config.js'
import { getDb } from '../db/mongo.js'
import { getRedis } from '../db/redis.js'

const jwtPayloadSchema = z.object({
  sub: z.string().min(1),
  sid: z.string().min(1),
  nickname: z.string().min(1),
  guest: z.boolean().optional(),
})

export async function registerUser(input: {
  emailOrUsername: string
  password: string
  nickname: string
}) {
  const db = await getDb()
  const users = db.collection<{ _id: string; emailOrUsername: string; nickname: string; passwordHash: string; createdAt: Date; lastLoginAt: Date }>('users')

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
  const db = await getDb()
  const users = db.collection<{ _id: string; emailOrUsername: string; nickname: string; passwordHash: string; createdAt: Date; lastLoginAt: Date }>('users')

  const user = await users.findOne({
    emailOrUsername: input.emailOrUsername,
  })

  if (!user) throw new Error('账号或密码错误')

  const ok = await bcrypt.compare(input.password, user.passwordHash)
  if (!ok) throw new Error('账号或密码错误')

  await users.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } })

  const sessionId = nanoid(24)
  const redis = await getRedis()
  await redis.set(`session:${sessionId}`, user._id, { EX: 60 * 60 * 24 * 30 })

  const token = jwt.sign({ sub: user._id, sid: sessionId, nickname: user.nickname }, config.jwtSecret, {
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

  const token = jwt.sign({ sub: guestId, sid: sessionId, nickname, guest: true }, config.jwtSecret, {
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
  const decoded = jwt.verify(input.token, config.jwtSecret)
  const parsed = jwtPayloadSchema.parse(decoded)
  if (!parsed.sub.startsWith('guest:')) throw new Error('NOT_GUEST')

  const db = await getDb()
  const users = db.collection<{ _id: string; emailOrUsername: string; nickname: string; passwordHash: string; createdAt: Date; lastLoginAt: Date }>('users')

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
      accessToken: jwt.sign({ sub: userId, sid: sessionId, nickname }, config.jwtSecret, { expiresIn: '30d' }),
      user: { id: userId, nickname, isGuest: false as const },
    }
  }

  const token = jwt.sign({ sub: userId, sid: sessionId, nickname }, config.jwtSecret, {
    expiresIn: '30d',
  })

  return { accessToken: token, user: { id: userId, nickname, isGuest: false as const } }
}

export async function logoutToken(token: string) {
  const decoded = jwt.verify(token, config.jwtSecret)
  const parsed = jwtPayloadSchema.safeParse(decoded)
  if (!parsed.success) return
  const redis = await getRedis()
  await redis.del(`session:${parsed.data.sid}`)
}

export async function verifyAccessToken(token: string) {
  const decoded = jwt.verify(token, config.jwtSecret)
  const parsed = jwtPayloadSchema.parse(decoded)

  const redis = await getRedis()
  const userId = await redis.get(`session:${parsed.sid}`)
  if (!userId || userId !== parsed.sub) throw new Error('UNAUTHORIZED')

  return { id: parsed.sub, nickname: parsed.nickname, isGuest: parsed.sub.startsWith('guest:') }
}
