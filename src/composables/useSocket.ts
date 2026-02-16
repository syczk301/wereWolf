import { io, type Socket } from 'socket.io-client'
import { ref, type Ref } from 'vue'
import { useSessionStore } from '@/stores/session'

type ClientToServerEvents = {
  'room:join': (payload: { roomId: string }, cb?: (resp: { ok: true } | { ok: false; error: string }) => void) => void
  'room:leave': (payload: { roomId: string }) => void
  'room:ready': (payload: { roomId: string; ready: boolean }) => void
  'room:start': (payload: { roomId: string }) => void
  'room:config:update': (payload: { roomId: string; roleConfig?: any; timers?: any }) => void
  'room:bot:add': (payload: { roomId: string }) => void
  'room:bot:fill': (payload: { roomId: string }) => void
  'chat:send': (payload: { roomId: string; text: string; channel?: 'public' | 'wolf' }) => void
  'game:action': (payload: { roomId: string; actionType: string; payload: any }) => void
}

type ServerToClientEvents = {
  'room:state': (payload: any) => void
  'room:dissolved': (payload: { roomId: string }) => void
  'room:expired': (payload: { roomId: string }) => void
  'game:state': (payload: any) => void
  'game:private': (payload: any) => void
  'chat:new': (payload: any) => void
  'toast': (payload: { type: 'info' | 'error'; message: string }) => void
}

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>

const socketRef = ref<AppSocket | null>(null) as Ref<AppSocket | null>
const isConnected = ref(false)
const SOCKET_BASE = (import.meta.env.VITE_SOCKET_BASE ?? import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '')

export function useSocket() {
  const session = useSessionStore()

  function connect(): AppSocket {
    if (socketRef.value) {
      if (!socketRef.value.connected) {
        socketRef.value.connect()
      }
      return socketRef.value
    }

    if (!session.token) throw new Error('NO_TOKEN')

    const s: AppSocket = io(SOCKET_BASE || '/', {
      transports: ['websocket'],
      auth: { token: session.token },
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 2000,
    })

    s.on('connect', () => {
      isConnected.value = true
    })

    s.on('disconnect', () => {
      isConnected.value = false
    })

    socketRef.value = s
    return s
  }

  function disconnect(): void {
    socketRef.value?.disconnect()
    socketRef.value = null
    isConnected.value = false
  }

  return { socket: socketRef, isConnected, connect, disconnect }
}
