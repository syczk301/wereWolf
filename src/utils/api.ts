import type { WebRtcSignalPayload } from '../../shared/types'
const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '')

async function request<T>(path: string, options: RequestInit & { token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as any),
  }
  if (options.token) headers.Authorization = `Bearer ${options.token}`

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  })

  const contentType = res.headers.get('content-type') ?? ''
  let data: any = null
  if (contentType.includes('application/json')) {
    data = await res.json().catch(() => null)
  } else {
    const raw = await res.text().catch(() => '')
    data = (() => {
      try {
        return raw ? JSON.parse(raw) : null
      } catch {
        return null
      }
    })()

    if (!data && !res.ok && res.status >= 500) {
      throw new Error('后端服务不可用，请确认已启动 `npm run dev`')
    }
  }

  if (!res.ok || !data?.success) {
    const msg = data?.error || `HTTP_${res.status}`
    throw new Error(msg)
  }

  return data
}

export const api = {
  async register(input: { emailOrUsername: string; password: string; nickname: string }) {
    const data = await request<any>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return { accessToken: data.accessToken as string, user: data.user as { id: string; nickname: string; isGuest: boolean } }
  },

  async login(input: { emailOrUsername: string; password: string }) {
    const data = await request<any>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return { accessToken: data.accessToken as string, user: data.user as { id: string; nickname: string; isGuest: boolean } }
  },

  async logout(token: string) {
    await request<any>('/api/auth/logout', { method: 'POST', token })
  },

  async guest(tokenNickname?: { nickname?: string }) {
    const data = await request<any>('/api/auth/guest', {
      method: 'POST',
      body: JSON.stringify(tokenNickname ?? {}),
    })
    return { accessToken: data.accessToken as string, user: data.user as { id: string; nickname: string; isGuest: boolean } }
  },

  async upgrade(token: string, input: { emailOrUsername: string; password: string; nickname?: string }) {
    const data = await request<any>('/api/auth/upgrade', {
      method: 'POST',
      token,
      body: JSON.stringify(input),
    })
    return { accessToken: data.accessToken as string, user: data.user as { id: string; nickname: string; isGuest: boolean } }
  },

  async getMe(token: string) {
    const data = await request<any>('/api/auth/me', { method: 'GET', token })
    return { user: data.user as { id: string; nickname: string; isGuest: boolean } }
  },

  async listRooms(token: string) {
    const data = await request<any>('/api/rooms', { method: 'GET', token })
    return { rooms: data.rooms as any[] }
  },

  async createRoom(token: string, input: { name: string; maxPlayers: number }) {
    const data = await request<any>('/api/rooms', { method: 'POST', token, body: JSON.stringify(input) })
    return { room: data.room as any }
  },

  async listReplays(token: string) {
    const data = await request<any>('/api/replays', { method: 'GET', token })
    return { records: data.records as any[] }
  },

  async getReplay(token: string, replayId: string) {
    const data = await request<any>(`/api/replays/${replayId}`, { method: 'GET', token })
    return { detail: data.detail as any }
  },

  // ---- Realtime (replacing Socket.IO) ----
  async wsRoomJoin(token: string, roomId: string) {
    return await request<any>('/api/ws/room/join', { method: 'POST', token, body: JSON.stringify({ roomId }) })
  },
  async wsRoomLeave(token: string, roomId: string) {
    return await request<any>('/api/ws/room/leave', { method: 'POST', token, body: JSON.stringify({ roomId }) })
  },
  async wsRoomReady(token: string, roomId: string, ready: boolean) {
    return await request<any>('/api/ws/room/ready', { method: 'POST', token, body: JSON.stringify({ roomId, ready }) })
  },
  async wsRoomConfig(token: string, roomId: string, roleConfig: any, timers: any) {
    return await request<any>('/api/ws/room/config', { method: 'POST', token, body: JSON.stringify({ roomId, roleConfig, timers }) })
  },
  async wsRoomBotAdd(token: string, roomId: string) {
    return await request<any>('/api/ws/room/bot/add', { method: 'POST', token, body: JSON.stringify({ roomId }) })
  },
  async wsRoomBotFill(token: string, roomId: string) {
    return await request<any>('/api/ws/room/bot/fill', { method: 'POST', token, body: JSON.stringify({ roomId }) })
  },
  async wsRoomStart(token: string, roomId: string) {
    return await request<any>('/api/ws/room/start', { method: 'POST', token, body: JSON.stringify({ roomId }) })
  },
  async wsChatSend(token: string, roomId: string, text: string, channel?: string) {
    return await request<any>('/api/ws/chat/send', { method: 'POST', token, body: JSON.stringify({ roomId, text, channel }) })
  },
  async wsGameAction(token: string, roomId: string, actionType: string, payload: any) {
    return await request<any>('/api/ws/game/action', { method: 'POST', token, body: JSON.stringify({ roomId, actionType, payload }) })
  },
  async wsGamePoll(token: string, roomId: string) {
    return await request<any>('/api/ws/game/poll', { method: 'POST', token, body: JSON.stringify({ roomId }) })
  },
  async wsWebrtcSignal(token: string, roomId: string, targetUserId: string, signal: WebRtcSignalPayload) {
    return await request<any>('/api/ws/webrtc/signal', {
      method: 'POST',
      token,
      body: JSON.stringify({ roomId, targetUserId, signal }),
    })
  },
}
