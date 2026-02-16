/**
 * Server-side timers that push state via Pusher.
 * Replaces the setInterval logic formerly in socket.ts.
 */
import { gameService } from './services/gameService.js'
import { roomService } from './services/roomService.js'
import { emitToRoom, emitToUser } from './utils/pusher.js'

let gameTimer: ReturnType<typeof setInterval> | null = null
let expiryTimer: ReturnType<typeof setInterval> | null = null

export function startTimers() {
  // Game timeout advancement — every 1s
  if (!gameTimer) {
    gameTimer = setInterval(async () => {
      try {
        const ids = await gameService.listActiveGameIds()
        const list = Array.isArray(ids) ? ids : [...ids]
        for (const gameId of list.map((x) => String(x))) {
          const update = await gameService.advanceGameOnTimeout(gameId)
          if (!update) continue
          await emitToRoom(update.roomId, 'game:state', update.gamePublic)
          if (update.roomState) await emitToRoom(update.roomId, 'room:state', update.roomState)
          if (update.privateUserIds?.length) {
            for (const uid of update.privateUserIds) {
              const priv = await gameService.getGamePrivateState(update.gamePublic.gameId, uid)
              await emitToUser(uid, 'game:private', priv)
            }
          }
        }
      } catch {
        // ignore
      }
    }, 1000)
  }

  // Room expiry check — every 10s
  if (!expiryTimer) {
    expiryTimer = setInterval(() => {
      roomService.checkAndExpireRooms().catch(() => {})
    }, 10000)
  }
}

export function stopTimers() {
  if (gameTimer) { clearInterval(gameTimer); gameTimer = null }
  if (expiryTimer) { clearInterval(expiryTimer); expiryTimer = null }
}
