import Pusher from 'pusher-js'
import type { Channel } from 'pusher-js'
import { ref } from 'vue'
import { useSessionStore } from '@/stores/session'

function cleanEnv(value: string | undefined, fallback: string) {
  const normalized = String(value ?? '')
    .replace(/(?:\\r\\n|\\n|\\r)+$/g, '')
    .trim()
  return normalized || fallback
}

const PUSHER_KEY = cleanEnv(import.meta.env.VITE_PUSHER_KEY, 'e588157482ef4b62e466')
const PUSHER_CLUSTER = cleanEnv(import.meta.env.VITE_PUSHER_CLUSTER, 'us3')

let pusher: Pusher | null = null

const isConnected = ref(false)

export function usePusher() {
  const session = useSessionStore()

  function connect(): Pusher {
    if (pusher) return pusher

    pusher = new Pusher(PUSHER_KEY, {
      cluster: PUSHER_CLUSTER,
    })

    pusher.connection.bind('connected', () => {
      isConnected.value = true
    })
    pusher.connection.bind('disconnected', () => {
      isConnected.value = false
    })

    return pusher
  }

  function subscribeRoom(roomId: string): Channel {
    const p = connect()
    return p.subscribe(`room-${roomId}`)
  }

  function subscribeUser(userId: string): Channel {
    const p = connect()
    const safe = userId.replace(/[^a-zA-Z0-9_-]/g, '-')
    return p.subscribe(`user-${safe}`)
  }

  function unsubscribeRoom(roomId: string) {
    pusher?.unsubscribe(`room-${roomId}`)
  }

  function unsubscribeUser(userId: string) {
    const safe = userId.replace(/[^a-zA-Z0-9_-]/g, '-')
    pusher?.unsubscribe(`user-${safe}`)
  }

  function disconnect() {
    pusher?.disconnect()
    pusher = null
    isConnected.value = false
  }

  return {
    isConnected,
    connect,
    disconnect,
    subscribeRoom,
    subscribeUser,
    unsubscribeRoom,
    unsubscribeUser,
  }
}
