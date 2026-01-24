import { nanoid } from 'nanoid'
import { z } from 'zod'
import type { RoomState, RoomSummary } from '../../shared/types.js'
import { getDb } from '../db/mongo.js'
import { getRedis } from '../db/redis.js'

const roleConfigSchema = z.object({
  werewolf: z.number().int().min(1).max(5),
  seer: z.number().int().min(0).max(1),
  witch: z.number().int().min(0).max(1),
  hunter: z.number().int().min(0).max(1),
  guard: z.number().int().min(0).max(1),
})

const timersSchema = z.object({
  nightSeconds: z.number().int().min(10).max(180),
  daySpeechSeconds: z.number().int().min(10).max(300),
  dayVoteSeconds: z.number().int().min(10).max(180),
  settlementSeconds: z.number().int().min(5).max(120),
})

function defaultRoleConfig(playerCount: number) {
  // 标准狼人杀配置
  // 9人局: 3狼 1预言家 1女巫 1猎人 3村民
  // 12人局: 4狼 1预言家 1女巫 1猎人 1守卫 4村民
  // 15人局: 4狼 1预言家 1女巫 1猎人 1守卫 7村民
  if (playerCount >= 12) {
    return { werewolf: 4, seer: 1, witch: 1, hunter: 1, guard: 1 }
  } else if (playerCount >= 9) {
    return { werewolf: 3, seer: 1, witch: 1, hunter: 1, guard: 0 }
  } else if (playerCount >= 6) {
    return { werewolf: 2, seer: 1, witch: 1, hunter: 0, guard: 0 }
  } else {
    return { werewolf: 1, seer: 1, witch: 0, hunter: 0, guard: 0 }
  }
}

function defaultTimers() {
  return { nightSeconds: 45, daySpeechSeconds: 60, dayVoteSeconds: 45, settlementSeconds: 20 }
}

type RoomDoc = {
  _id: string
  name: string
  ownerUserId: string
  status: 'waiting' | 'playing' | 'ended'
  maxPlayers: number
  roomNumber?: number
  createdAt: Date
}

type RoomRuntime = {
  roomId: string
  roomNumber: number
  name: string
  status: 'waiting' | 'playing' | 'ended'
  ownerUserId: string
  maxPlayers: number
  members: { seat: number; userId?: string; nickname?: string; isReady: boolean; isAlive: boolean; isBot?: boolean }[]
  roleConfig: { werewolf: number; seer: number; witch: number; hunter: number; guard: number }
  timers: { nightSeconds: number; daySpeechSeconds: number; dayVoteSeconds: number; settlementSeconds: number }
  gameId?: string
  createdAt: number
}

async function loadRuntime(roomId: string): Promise<RoomRuntime | null> {
  const redis = await getRedis()
  const raw = await redis.get(`roomrt:${roomId}`)
  if (!raw) return null
  return JSON.parse(String(raw)) as RoomRuntime
}

async function saveRuntime(rt: RoomRuntime) {
  const redis = await getRedis()
  await redis.set(`roomrt:${rt.roomId}`, JSON.stringify(rt))
}

async function buildState(rt: RoomRuntime): Promise<RoomState> {
  return {
    id: rt.roomId,
    roomNumber: rt.roomNumber,
    name: rt.name,
    status: rt.status,
    ownerUserId: rt.ownerUserId,
    maxPlayers: rt.maxPlayers,
    gameId: rt.gameId,
    roleConfig: rt.roleConfig,
    timers: rt.timers,
    members: rt.members.map((m) => ({
      seat: m.seat,
      user: m.userId && m.nickname ? { id: m.userId, nickname: m.nickname } : undefined,
      isReady: m.isReady,
      isAlive: m.isAlive,
      isBot: !!m.isBot,
    })),
  }
}

export const roomService = {
  async createRoom(ownerUserId: string, ownerNickname: string, name: string, maxPlayers: number) {
    const db = await getDb()
    const rooms = db.collection<RoomDoc>('rooms')
    const roomId = nanoid(10)
    const roomNumber = Math.floor(1000 + Math.random() * 9000) // Simple 4-digit ID
    const now = new Date()

    const safeName = (name || '新房间').slice(0, 40)
    await rooms.insertOne({
      _id: roomId,
      roomNumber,
      name: safeName,
      ownerUserId,
      status: 'waiting',
      maxPlayers,
      createdAt: now,
    })

    const members = Array.from({ length: maxPlayers }, (_, i) => ({
      seat: i + 1,
      isReady: false,
      isAlive: true,
      userId: undefined as string | undefined, // Explicit type for clarity
      nickname: undefined as string | undefined,
    }))

    // Optimized: Pre-seat the owner in seat 1
    members[0].userId = ownerUserId
    members[0].nickname = ownerNickname
    members[0].isReady = false

    const rt: RoomRuntime = {
      roomId,
      roomNumber,
      name: safeName,
      status: 'waiting',
      ownerUserId,
      maxPlayers,
      members: members as any,
      roleConfig: defaultRoleConfig(Math.min(maxPlayers, 12)),
      timers: defaultTimers(),
      createdAt: now.getTime(),
    }

    await saveRuntime(rt)
    return await buildState(rt)
  },

  async listRooms(): Promise<RoomSummary[]> {
    const db = await getDb()
    const rooms = db.collection<RoomDoc>('rooms')
    const docs = await rooms
      .find({ status: { $in: ['waiting', 'playing'] } })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray()

    const result: RoomSummary[] = []
    for (const d of docs) {
      const rt = await loadRuntime(d._id)
      const playerCount = rt ? rt.members.filter((m) => !!m.userId).length : 0
      result.push({
        id: d._id,
        roomNumber: d.roomNumber,
        name: d.name,
        status: d.status,
        playerCount,
        maxPlayers: d.maxPlayers,
      })
    }
    return result
  },

  async getRoomState(roomId: string): Promise<RoomState> {
    let rt = await loadRuntime(roomId)
    if (!rt) {
      const db = await getDb()
      const rooms = db.collection<RoomDoc>('rooms')
      const doc = await rooms.findOne({ _id: roomId })
      if (!doc) throw new Error('房间不存在')
      rt = {
        roomId: doc._id,
        name: doc.name,
        status: doc.status,
        ownerUserId: doc.ownerUserId,
        maxPlayers: doc.maxPlayers,
        members: Array.from({ length: doc.maxPlayers }, (_, i) => ({
          seat: i + 1,
          isReady: false,
          isAlive: true,
        })),
        roleConfig: defaultRoleConfig(Math.min(doc.maxPlayers, 12)),
        timers: defaultTimers(),
        gameId: undefined,
        roomNumber: doc.roomNumber || 0,
        createdAt: doc.createdAt?.getTime() || Date.now(),
      }
      await saveRuntime(rt)
    }
    return await buildState(rt)
  },
  async joinRoom(roomId: string, userId: string, nickname: string) {
    const rt = (await loadRuntime(roomId))
    if (!rt) throw new Error('房间不存在')
    const already = rt.members.find((m) => m.userId === userId)
    if (already) return

    const seat = rt.members.find((m) => !m.userId)
    if (!seat) throw new Error('房间已满')
    seat.userId = userId
    seat.nickname = nickname
    seat.isReady = false
    seat.isAlive = true
    await saveRuntime(rt)
  },

  async addBot(roomId: string, userId: string) {
    const rt = (await loadRuntime(roomId))
    if (!rt) throw new Error('房间不存在')
    if (rt.ownerUserId !== userId) throw new Error('仅房主可添加机器人')
    if (rt.status !== 'waiting') throw new Error('游戏进行中不可修改')

    const seat = rt.members.find((m) => !m.userId)
    if (!seat) throw new Error('房间已满')

    const botId = `bot_${nanoid(8)}`
    const botNames = ['小强', '大华', '二蛋', '阿飞', '老铁', '豆包', '皮皮', '旺财']
    const randomName = botNames[Math.floor(Math.random() * botNames.length)] + Math.floor(Math.random() * 100)

    seat.userId = botId
    seat.nickname = randomName
    seat.isReady = true
    seat.isAlive = true
    seat.isBot = true
    await saveRuntime(rt)
  },

  async fillBots(roomId: string) {
    const rt = await loadRuntime(roomId)
    if (!rt) return

    let changed = false
    const botNames = ['小强', '大华', '二蛋', '阿飞', '老铁', '豆包', '皮皮', '旺财', '阿呆', 'C-3PO', 'R2-D2', '小爱']

    for (const m of rt.members) {
      if (!m.userId) {
        const botId = `bot_${nanoid(8)}`
        const randomName = botNames[Math.floor(Math.random() * botNames.length)] + Math.floor(Math.random() * 100)

        m.userId = botId
        m.nickname = randomName
        m.isReady = true
        m.isAlive = true
        m.isBot = true
        changed = true
      }
    }

    if (changed) {
      await saveRuntime(rt)
    }
  },

  async leaveRoom(roomId: string, userId: string): Promise<{ dissolved: boolean; newOwnerId?: string }> {
    const rt = await loadRuntime(roomId)
    if (!rt) throw new Error('房间不存在')

    // 游戏进行中不允许退出
    if (rt.status === 'playing') throw new Error('游戏进行中不可退出')

    const memberIndex = rt.members.findIndex((m) => m.userId === userId)
    if (memberIndex === -1) throw new Error('未加入房间')

    const isOwner = rt.ownerUserId === userId

    // 清空该座位
    const member = rt.members[memberIndex]
    member.userId = undefined
    member.nickname = undefined
    member.isReady = false
    member.isAlive = true
    member.isBot = false

    // 检查剩余真实玩家（非机器人）
    const remainingPlayers = rt.members.filter((m) => m.userId && !m.isBot)

    if (remainingPlayers.length === 0) {
      // 没有其他真实玩家，解散房间
      const redis = await getRedis()
      const db = await getDb()
      await redis.del(`roomrt:${roomId}`)
      await db.collection<RoomDoc>('rooms').deleteOne({ _id: roomId })
      return { dissolved: true }
    }

    if (isOwner) {
      // 房主退出，按座位号顺序转让给下一个真实玩家
      const sortedPlayers = remainingPlayers.sort((a, b) => a.seat - b.seat)
      const newOwner = sortedPlayers[0]
      rt.ownerUserId = newOwner.userId!

      // 更新 MongoDB 中的房主信息
      const db = await getDb()
      await db.collection<RoomDoc>('rooms').updateOne(
        { _id: roomId },
        { $set: { ownerUserId: newOwner.userId } }
      )

      await saveRuntime(rt)
      return { dissolved: false, newOwnerId: newOwner.userId }
    }

    await saveRuntime(rt)
    return { dissolved: false }
  },

  async setReady(roomId: string, userId: string, ready: boolean) {
    const rt = (await loadRuntime(roomId))
    if (!rt) throw new Error('房间不存在')
    const m = rt.members.find((x) => x.userId === userId)
    if (!m) throw new Error('未加入房间')
    m.isReady = ready
    await saveRuntime(rt)
  },

  async updateConfig(roomId: string, userId: string, patch: { roleConfig?: any; timers?: any }) {
    const rt = (await loadRuntime(roomId))
    if (!rt) throw new Error('房间不存在')
    if (rt.ownerUserId !== userId) throw new Error('仅房主可修改')
    if (rt.status !== 'waiting') throw new Error('游戏进行中不可修改')

    if (patch.roleConfig) {
      const rc = roleConfigSchema.parse(patch.roleConfig) as RoomRuntime['roleConfig']
      rt.roleConfig = rc
    }

    if (patch.timers) {
      const t = timersSchema.parse(patch.timers) as RoomRuntime['timers']
      rt.timers = t
    }

    await saveRuntime(rt)
  },

  async attachGame(roomId: string, gameId: string) {
    const rt = (await loadRuntime(roomId))
    if (!rt) throw new Error('房间不存在')
    rt.status = 'playing'
    rt.gameId = gameId
    for (const m of rt.members) {
      if (m.userId) {
        m.isReady = false
        m.isAlive = true
      }
    }
    await saveRuntime(rt)

    const db = await getDb()
    const rooms = db.collection<RoomDoc>('rooms')
    await rooms.updateOne({ _id: roomId }, { $set: { status: 'playing' } })
    return await buildState(rt)
  },

  async markEnded(roomId: string) {
    const rt = await loadRuntime(roomId)
    if (!rt) return
    rt.status = 'ended'
    rt.gameId = undefined
    for (const m of rt.members) {
      if (m.userId) m.isReady = false
      m.isAlive = true
    }
    await saveRuntime(rt)

    const db = await getDb()
    const rooms = db.collection<RoomDoc>('rooms')
    await rooms.updateOne({ _id: roomId }, { $set: { status: 'ended' } })
  },

  async getRuntime(roomId: string) {
    const rt = await loadRuntime(roomId)
    if (!rt) throw new Error('房间不存在')
    return rt
  },

  async checkAndExpireRooms(io?: any) {
    try {
      const redis = await getRedis()
      const db = await getDb()
      const now = Date.now()
      const twoMinutesAgo = new Date(now - 120000)

      // Part 1: Clean Redis-based runtimes
      const keys = await redis.keys('roomrt:*')
      console.log(`[Expiry Check] Found ${keys.length} Redis keys`)
      for (const key of keys) {
        const raw = await redis.get(key)
        if (!raw) continue
        const rt = JSON.parse(String(raw)) as RoomRuntime

        if (rt.status !== 'waiting') continue

        const createdAt = rt.createdAt || 0
        const diff = now - createdAt

        if (diff > 120000) {
          console.log(`[Expiry] Room ${rt.roomId} expired. Age: ${Math.floor(diff / 1000)}s`)
          if (io) {
            io.to(rt.roomId).emit('toast', { type: 'info', message: '房间长时间未开始，已自动解散' })
            io.to(rt.roomId).emit('room:expired', { roomId: rt.roomId })
          }
          await redis.del(key)
          await db.collection<RoomDoc>('rooms').deleteOne({ _id: rt.roomId })
        }
      }

      // Part 2: Clean orphaned MongoDB rooms
      const orphanedRooms = await db.collection<RoomDoc>('rooms')
        .find({
          status: 'waiting',
          $or: [
            { createdAt: { $lt: twoMinutesAgo } },
            { createdAt: { $exists: false } }
          ]
        })
        .toArray()

      console.log(`[Expiry Check] Found ${orphanedRooms.length} orphaned MongoDB rooms`)

      for (const room of orphanedRooms) {
        const hasRuntime = await redis.exists(`roomrt:${room._id}`)
        if (!hasRuntime) {
          console.log(`[Expiry] Orphaned room ${room._id} deleted from MongoDB`)
          await db.collection<RoomDoc>('rooms').deleteOne({ _id: room._id })
        }
      }
    } catch (err) {
      console.error('[Expiry Check] Error:', err)
    }
  },
}
