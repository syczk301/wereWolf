import Pusher from 'pusher'

let instance: Pusher | null = null

export function getPusher(): Pusher {
  if (!instance) {
    instance = new Pusher({
      appId: process.env.PUSHER_APP_ID!,
      key: process.env.PUSHER_KEY!,
      secret: process.env.PUSHER_SECRET!,
      cluster: process.env.PUSHER_CLUSTER!,
      useTLS: true,
    })
  }
  return instance
}

/**
 * Emit event to a Pusher channel (room or user).
 * Pusher limits each message to 10KB; we chunk if needed.
 */
export async function emit(channel: string, event: string, data: any) {
  const p = getPusher()
  await p.trigger(channel, event, data)
}

/** Emit to everyone in a room */
export async function emitToRoom(roomId: string, event: string, data: any) {
  await emit(`room-${roomId}`, event, data)
}

/** Sanitize userId for Pusher channel name (no colons allowed) */
function sanitizeChannel(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '-')
}

/** Emit to a specific user */
export async function emitToUser(userId: string, event: string, data: any) {
  await emit(`user-${sanitizeChannel(userId)}`, event, data)
}

/** Get the channel name for a user (for client-side subscription) */
export function userChannelName(userId: string): string {
  return `user-${sanitizeChannel(userId)}`
}
