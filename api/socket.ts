import type { Server as SocketIOServer, Socket } from 'socket.io'
import { createAdapter } from '@socket.io/redis-adapter'
import { getRedis } from './db/redis.js'
import { verifyAccessToken } from './services/authService.js'
import { roomService } from './services/roomService.js'
import { gameService } from './services/gameService.js'

type ClientToServerEvents = {
  'room:join': (payload: { roomId: string }, cb?: (resp: { ok: true } | { ok: false; error: string }) => void) => void
  'room:leave': (payload: { roomId: string }) => void
  'room:ready': (payload: { roomId: string; ready: boolean }) => void
  'room:start': (payload: { roomId: string }) => void
  'room:config:update': (payload: { roomId: string; roleConfig?: any; timers?: any }) => void
  'room:bot:add': (payload: { roomId: string }) => void
  'chat:send': (payload: { roomId: string; text: string }) => void
  'game:action': (payload: { roomId: string; actionType: string; payload: any }) => void
}

type ServerToClientEvents = {
  'room:state': (payload: any) => void
  'room:dissolved': (payload: { roomId: string }) => void
  'game:state': (payload: any) => void
  'game:private': (payload: any) => void
  'chat:new': (payload: any) => void
  'toast': (payload: { type: 'info' | 'error'; message: string }) => void
}

type SocketData = { userId: string; nickname: string }

export async function initSocket(io: SocketIOServer<ClientToServerEvents, ServerToClientEvents, any, SocketData>) {
  const pub = await getRedis()
  if (!(pub as any).__fallback) {
    const sub = pub.duplicate()
    await sub.connect()
    io.adapter(createAdapter(pub as any, sub as any))
  }

  io.use(async (socket, next) => {
    const token = typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : ''
    if (!token) return next(new Error('UNAUTHORIZED'))

    try {
      const user = await verifyAccessToken(token)
      socket.data.userId = user.id
      socket.data.nickname = user.nickname
      next()
    } catch {
      next(new Error('UNAUTHORIZED'))
    }
  })

  io.on('connection', (socket) => {
    socket.join(`user:${socket.data.userId}`)

    socket.on('room:join', async ({ roomId }, cb) => {
      try {
        await socket.join(roomId)
        await roomService.joinRoom(roomId, socket.data.userId, socket.data.nickname)
        const roomState = await roomService.getRoomState(roomId)
        io.to(roomId).emit('room:state', roomState)

        if (roomState.gameId) {
          const gamePublic = await gameService.getGamePublicState(roomState.gameId)
          const gamePrivate = await gameService.getGamePrivateState(roomState.gameId, socket.data.userId)
          socket.emit('game:state', gamePublic)
          socket.emit('game:private', gamePrivate)
        }
        cb?.({ ok: true })
      } catch (e: any) {
        cb?.({ ok: false, error: e?.message ?? 'JOIN_FAILED' })
      }
    })

    socket.on('room:leave', async ({ roomId }) => {
      try {
        const result = await roomService.leaveRoom(roomId, socket.data.userId)

        // 离开 socket.io 房间
        await socket.leave(roomId)

        if (result.dissolved) {
          // 房间已解散，通知所有人
          io.to(roomId).emit('room:dissolved', { roomId })
          io.to(roomId).emit('toast', { type: 'info', message: '房间已解散' })
        } else {
          // 更新房间状态给剩余玩家
          const roomState = await roomService.getRoomState(roomId)
          io.to(roomId).emit('room:state', roomState)

          if (result.newOwnerId) {
            io.to(roomId).emit('toast', { type: 'info', message: '房主已变更' })
          }
        }
      } catch (e: any) {
        socket.emit('toast', { type: 'error', message: e?.message ?? '退出房间失败' })
      }
    })

    socket.on('room:ready', async ({ roomId, ready }) => {
      try {
        await roomService.setReady(roomId, socket.data.userId, ready)
        const roomState = await roomService.getRoomState(roomId)
        io.to(roomId).emit('room:state', roomState)
      } catch {
        socket.emit('toast', { type: 'error', message: '设置准备失败' })
      }
    })

    socket.on('room:config:update', async ({ roomId, roleConfig, timers }) => {
      try {
        await roomService.updateConfig(roomId, socket.data.userId, { roleConfig, timers })
        const roomState = await roomService.getRoomState(roomId)
        io.to(roomId).emit('room:state', roomState)
      } catch (e: any) {
        socket.emit('toast', { type: 'error', message: e?.message ?? '更新配置失败' })
      }
    })

    socket.on('room:bot:add', async ({ roomId }) => {
      try {
        await roomService.addBot(roomId, socket.data.userId)
        const roomState = await roomService.getRoomState(roomId)
        io.to(roomId).emit('room:state', roomState)
      } catch (e: any) {
        socket.emit('toast', { type: 'error', message: e?.message ?? '添加机器人失败' })
      }
    })

    socket.on('room:start', async ({ roomId }) => {
      try {
        const { roomState, gamePublic } = await gameService.startGame(roomId, socket.data.userId)
        io.to(roomId).emit('room:state', roomState)
        io.to(roomId).emit('game:state', gamePublic)

        for (const p of gamePublic.players) {
          if (!p.user) continue
          const priv = await gameService.getGamePrivateState(gamePublic.gameId, p.user.id)
          io.to(`user:${p.user.id}`).emit('game:private', priv)
        }
      } catch (e: any) {
        socket.emit('toast', { type: 'error', message: e?.message ?? '开局失败' })
      }
    })

    socket.on('chat:send', async ({ roomId, text, channel }: { roomId: string; text: string; channel?: 'public' | 'wolf' }) => {
      try {
        const msg = await gameService.appendChat(roomId, socket.data.userId, socket.data.nickname, text, channel)

        if (msg.channel === 'wolf') {
          // Multicast to wolves only
          const g = await gameService.getGamePublicStateByRoom(roomId)
          if (g) {
            // Find all wolves (including self)
            // Note: gamePublic doesn't have roles. We need to iterate players and checking private state is expensive.
            // Better: Get room members, iterate, check private state?
            // Or rely on room service or a helper in gameService?
            // Helper in gameService `getWolfUserIds` would be best, but let's do it inline for now if possible or add helper.
            // Actually, simplest is to iterate all members in room, check their role?
            // Since we have `g.players` (which are seat+user), we can iterate them.
            // But we don't know their role from `g`.
            // We need to load the game runtime to know roles efficiently.
            // `gameService` should return the target userIds.

            // Let's modify appendChat to return targetUserIds?
            // No, `appendChat` currently just returns msg.
            // Let's assume we fetch `gameService.getGamePrivateState` for each user is too slow (N calls).
            // Let's add `gameService.getRoleUserIds(gameId, role)`?
            // Or just iterate sockets in `roomId` room and check logic?
            // Sockets don't know roles.

            // FIX: We need a way to know who to send to.
            // Let's use `gameService.getPrivateCHatRecipients(gameId, channel, senderId)`.
            // Or simpler: just helper `getWolfUserIds`.
            const wolfIds = await gameService.getWolfUserIds(g.gameId)
            for (const uid of wolfIds) {
              io.to(`user:${uid}`).emit('chat:new', msg)
            }
          }
        } else {
          // Public
          io.to(roomId).emit('chat:new', msg)
          const g = await gameService.getGamePublicStateByRoom(roomId)
          if (g) io.to(roomId).emit('game:state', g)
        }
      } catch (e: any) {
        socket.emit('toast', { type: 'error', message: e?.message ?? '发送失败' })
      }
    })

    socket.on('game:action', async ({ roomId, actionType, payload }) => {
      try {
        const updates = await gameService.submitAction(roomId, socket.data.userId, { actionType, payload })
        if (updates.roomState) io.to(roomId).emit('room:state', updates.roomState)
        if (updates.gamePublic) io.to(roomId).emit('game:state', updates.gamePublic)

        // Always send private state to the actor to update highlights
        const actorPriv = await gameService.getGamePrivateState(updates.gamePublic!.gameId, socket.data.userId)
        socket.emit('game:private', actorPriv)

        if (updates.privateUserIds?.length) {
          for (const uid of updates.privateUserIds) {
            if (uid === socket.data.userId) continue // already sent
            const priv = await gameService.getGamePrivateState(updates.gamePublic!.gameId, uid)
            io.to(`user:${uid}`).emit('game:private', priv)
          }
        }
      } catch (e: any) {
        socket.emit('toast', { type: 'error', message: e?.message ?? '操作失败' })
      }
    })
  })

  setInterval(async () => {
    try {
      const ids = await gameService.listActiveGameIds()
      const list = Array.isArray(ids) ? ids : [...ids]
      for (const gameId of list.map((x) => String(x))) {
        const update = await gameService.advanceGameOnTimeout(gameId)
        if (!update) continue
        io.to(update.roomId).emit('game:state', update.gamePublic)
        if (update.roomState) io.to(update.roomId).emit('room:state', update.roomState)
        if (update.privateUserIds?.length) {
          for (const uid of update.privateUserIds) {
            const priv = await gameService.getGamePrivateState(update.gamePublic.gameId, uid)
            io.to(`user:${uid}`).emit('game:private', priv)
          }
        }
      }
    } catch {
      return
    }
  }, 1000)
}
