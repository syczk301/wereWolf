/**
 * HTTP endpoints that replace Socket.IO client->server events.
 * All require auth. Each endpoint mirrors a former socket event.
 */
import { Router, type Response } from 'express'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { roomService } from '../services/roomService.js'
import { gameService } from '../services/gameService.js'
import { emitToRoom, emitToUser } from '../utils/pusher.js'

const router = Router()

const webrtcSignalSchema = z.object({
  roomId: z.string().min(1),
  targetUserId: z.string().min(1),
  signal: z.object({
    type: z.enum(['offer', 'answer', 'candidate']),
    sdp: z.any().optional(),
    candidate: z.any().optional(),
  }),
})

/* ---- room:join ---- */
router.post(
  '/room/join',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { roomId } = req.body
    await roomService.joinRoom(roomId, req.user.id, req.user.nickname)
    const roomState = await roomService.getRoomState(roomId)
    // Push to other members in room
    emitToRoom(roomId, 'room:state', roomState).catch(() => {})

    const result: any = { ok: true, roomState }
    if (roomState.gameId) {
      result.gamePublic = await gameService.getGamePublicState(roomState.gameId)
      result.gamePrivate = await gameService.getGamePrivateState(roomState.gameId, req.user.id)
    }
    res.json({ success: true, ...result })
  }),
)

/* ---- room:leave ---- */
router.post(
  '/room/leave',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { roomId } = req.body
    const result = await roomService.leaveRoom(roomId, req.user.id)

    if (result.dissolved) {
      await emitToRoom(roomId, 'room:dissolved', { roomId })
      await emitToRoom(roomId, 'toast', { type: 'info', message: '房间已解散' })
    } else {
      const roomState = await roomService.getRoomState(roomId)
      await emitToRoom(roomId, 'room:state', roomState)
      if (result.newOwnerId) {
        await emitToRoom(roomId, 'toast', { type: 'info', message: '房主已变更' })
      }
    }
    res.json({ success: true })
  }),
)

/* ---- room:ready ---- */
router.post(
  '/room/ready',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { roomId, ready } = req.body
    await roomService.setReady(roomId, req.user.id, ready)
    const roomState = await roomService.getRoomState(roomId)
    emitToRoom(roomId, 'room:state', roomState).catch(() => {})
    res.json({ success: true, roomState })
  }),
)

/* ---- room:config:update ---- */
router.post(
  '/room/config',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { roomId, roleConfig, timers } = req.body
    await roomService.updateConfig(roomId, req.user.id, { roleConfig, timers })
    const roomState = await roomService.getRoomState(roomId)
    emitToRoom(roomId, 'room:state', roomState).catch(() => {})
    res.json({ success: true, roomState })
  }),
)

/* ---- room:bot:add ---- */
router.post(
  '/room/bot/add',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { roomId } = req.body
    await roomService.addBot(roomId, req.user.id)
    const roomState = await roomService.getRoomState(roomId)
    emitToRoom(roomId, 'room:state', roomState).catch(() => {})
    res.json({ success: true, roomState })
  }),
)

/* ---- room:bot:fill ---- */
router.post(
  '/room/bot/fill',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { roomId } = req.body
    await roomService.fillBots(roomId)
    const roomState = await roomService.getRoomState(roomId)
    emitToRoom(roomId, 'room:state', roomState).catch(() => {})
    res.json({ success: true, roomState })
  }),
)

/* ---- room:start ---- */
router.post(
  '/room/start',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { roomId } = req.body
    const { roomState, gamePublic } = await gameService.startGame(roomId, req.user.id)

    // Push to all via Pusher (fire & forget for other players)
    emitToRoom(roomId, 'room:state', roomState).catch(() => {})
    emitToRoom(roomId, 'game:state', gamePublic).catch(() => {})

    for (const p of gamePublic.players) {
      if (!p.user) continue
      const priv = await gameService.getGamePrivateState(gamePublic.gameId, p.user.id)
      emitToUser(p.user.id, 'game:private', priv).catch(() => {})
    }

    // Also return current user's private state in HTTP response
    const myPriv = await gameService.getGamePrivateState(gamePublic.gameId, req.user.id)
    res.json({ success: true, roomState, gamePublic, gamePrivate: myPriv })
  }),
)

/* ---- chat:send ---- */
router.post(
  '/chat/send',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { roomId, text, channel } = req.body
    const trimmed = String(text ?? '').trim().slice(0, 200)
    if (!trimmed) throw new Error('EMPTY')

    const roomState = await roomService.getRoomState(roomId)

    // If game not started, allow lobby chat
    if (!roomState.gameId) {
      const msg = { id: nanoid(10), at: Date.now(), sender: { id: req.user.id, nickname: req.user.nickname }, text: trimmed, channel: 'public' as const }
      emitToRoom(roomId, 'chat:new', msg).catch(() => {})
      res.json({ success: true, msg })
      return
    }

    const msg = await gameService.appendChat(roomId, req.user.id, req.user.nickname, trimmed, channel)

    if (msg.channel === 'wolf') {
      const g = await gameService.getGamePublicStateByRoom(roomId)
      if (g) {
        const wolfIds = await gameService.getWolfUserIds(g.gameId)
        for (const uid of wolfIds) {
          emitToUser(uid, 'chat:new', msg).catch(() => {})
        }
      }
    } else {
      emitToRoom(roomId, 'chat:new', msg).catch(() => {})
      const g = await gameService.getGamePublicStateByRoom(roomId)
      if (g) emitToRoom(roomId, 'game:state', g).catch(() => {})
    }
    res.json({ success: true, msg })
  }),
)

/* ---- game:action ---- */
router.post(
  '/game/action',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { roomId, actionType, payload } = req.body
    const updates = await gameService.submitAction(roomId, req.user.id, { actionType, payload })

    if (updates.roomState) emitToRoom(roomId, 'room:state', updates.roomState).catch(() => {})
    if (updates.gamePublic) emitToRoom(roomId, 'game:state', updates.gamePublic).catch(() => {})

    // Send private state to the actor
    const actorPriv = await gameService.getGamePrivateState(updates.gamePublic!.gameId, req.user.id)
    emitToUser(req.user.id, 'game:private', actorPriv).catch(() => {})

    if (updates.privateUserIds?.length) {
      for (const uid of updates.privateUserIds) {
        if (uid === req.user.id) continue
        const priv = await gameService.getGamePrivateState(updates.gamePublic!.gameId, uid)
        emitToUser(uid, 'game:private', priv).catch(() => {})
      }
    }
    res.json({ success: true, roomState: updates.roomState, gamePublic: updates.gamePublic, gamePrivate: actorPriv })
  }),
)

/* ---- webrtc:signal ---- */
router.post(
  '/webrtc/signal',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const parsed = webrtcSignalSchema.safeParse(req.body)
    if (!parsed.success) {
      res.json({ success: true, ignored: true, reason: 'INVALID_SIGNAL_PAYLOAD' })
      return
    }

    const { roomId, targetUserId, signal } = parsed.data
    const fromUserId = req.user.id
    if (targetUserId === fromUserId) {
      res.json({ success: true, ignored: true, reason: 'TARGET_INVALID' })
      return
    }

    let fromInfo: Awaited<ReturnType<typeof gameService.getVoiceTurnInfo>>
    let targetInfo: Awaited<ReturnType<typeof gameService.getVoiceTurnInfo>>
    try {
      fromInfo = await gameService.getVoiceTurnInfo(roomId, fromUserId)
      targetInfo = await gameService.getVoiceTurnInfo(roomId, targetUserId)
    } catch {
      res.json({ success: true, ignored: true, reason: 'SIGNAL_STALE' })
      return
    }

    if (fromInfo.gameId !== targetInfo.gameId) {
      res.json({ success: true, ignored: true, reason: 'NOT_IN_GAME' })
      return
    }
    if (!fromInfo.isSpeechPhase || !fromInfo.activeSpeakerUserId) {
      res.json({ success: true, ignored: true, reason: 'NOT_SPEECH_PHASE' })
      return
    }

    const speakerId = fromInfo.activeSpeakerUserId
    const fromIsSpeaker = fromUserId === speakerId
    const targetIsSpeaker = targetUserId === speakerId

    if (signal.type === 'offer') {
      if (!fromIsSpeaker || targetIsSpeaker) {
        res.json({ success: true, ignored: true, reason: 'OFFER_FORBIDDEN' })
        return
      }
    } else {
      // answer/candidate: only speaker<->listener pair is allowed
      if ((fromIsSpeaker && targetIsSpeaker) || (!fromIsSpeaker && !targetIsSpeaker)) {
        res.json({ success: true, ignored: true, reason: 'PAIR_FORBIDDEN' })
        return
      }
    }

    await emitToUser(targetUserId, 'webrtc:signal', { roomId, fromUserId, signal }).catch(() => {})
    res.json({ success: true })
  }),
)

/* ---- game:poll ---- */
router.post(
  '/game/poll',
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { roomId } = req.body
    const roomState = await roomService.getRoomState(roomId)
    if (!roomState.gameId) {
      res.json({ success: true, roomState })
      return
    }

    // Try to advance timeout-based phase transitions
    const update = await gameService.advanceGameOnTimeout(roomState.gameId)
    if (update) {
      // Broadcast to other players
      emitToRoom(roomId, 'game:state', update.gamePublic).catch(() => {})
      if (update.roomState) emitToRoom(roomId, 'room:state', update.roomState).catch(() => {})
      if (update.privateUserIds?.length) {
        for (const uid of update.privateUserIds) {
          const priv = await gameService.getGamePrivateState(update.gamePublic.gameId, uid)
          emitToUser(uid, 'game:private', priv).catch(() => {})
        }
      }
    }

    const gamePublic = await gameService.getGamePublicState(roomState.gameId)
    const gamePrivate = await gameService.getGamePrivateState(roomState.gameId, req.user.id)
    res.json({ success: true, roomState, gamePublic, gamePrivate })
  }),
)

export default router
