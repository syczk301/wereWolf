import { io, type Socket } from 'socket.io-client'
import { ref, type Ref } from 'vue'
import { useSessionStore } from '@/stores/session'

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

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>

const socketRef = ref<AppSocket | null>(null) as Ref<AppSocket | null>
const isConnected = ref(false)

export function useSocket() {
  const session = useSessionStore()

  function connect(): AppSocket {
    // 如果已有连接且已连接，直接返回
    if (socketRef.value?.connected) {
      isConnected.value = true
      return socketRef.value
    }

    // 如果有连接但未连接，先断开
    if (socketRef.value) {
      socketRef.value.disconnect()
      socketRef.value = null
    }

    if (!session.token) throw new Error('NO_TOKEN')

    const s: AppSocket = io('/', {
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
