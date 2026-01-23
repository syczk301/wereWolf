import type { Server as SocketIOServer, Socket } from 'socket.io'
import { createAdapter } from '@socket.io/redis-adapter'
import { getRedis } from './db/redis.js'
import { verifyAccessToken } from './services/authService.js'
import { roomService } from './services/roomService.js'
import { gameService } from './services/gameService.js'

type ClientToServerEvents = {
  'room:join': (payload: { roomId: string }, cb?: (resp: { ok: true } | { ok: false; error: string }) => void) => void
  'room:ready': (payload: { roomId: string; ready: boolean }) => void
  'room:start': (payload: { roomId: string }) => void
  'room:config:update': (payload: { roomId: string; roleConfig?: any; timers?: any }) => void
  'room:bot:add': (payload: { roomId: string }) => void
  'chat:send': (payload: { roomId: string; text: string }) => void
  'game:action': (payload: { roomId: string; actionType: string; payload: any }) => void
}

type ServerToClientEvents = {
  'room:state': (payload: any) => void
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

    socket.on('chat:send', async ({ roomId, text }) => {
      try {
        const msg = await gameService.appendChat(roomId, socket.data.userId, socket.data.nickname, text)
        io.to(roomId).emit('chat:new', msg)
        const g = await gameService.getGamePublicStateByRoom(roomId)
        if (g) io.to(roomId).emit('game:state', g)
      } catch {
        socket.emit('toast', { type: 'error', message: '发送失败' })
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
