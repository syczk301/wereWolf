/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string
  readonly VITE_SOCKET_BASE?: string
  readonly VITE_PUSHER_KEY?: string
  readonly VITE_PUSHER_CLUSTER?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
