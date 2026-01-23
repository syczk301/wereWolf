<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/utils/api'
import { useSessionStore } from '@/stores/session'
import { useSocket } from '@/composables/useSocket'

type RoomSummary = { id: string; name: string; status: string; playerCount: number; maxPlayers: number }

const router = useRouter()
const session = useSessionStore()
const { connect } = useSocket()

const rooms = ref<RoomSummary[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

const createName = ref('')
const createMaxPlayers = ref(9)

async function loadRooms() {
  if (!session.token) return
  loading.value = true
  error.value = null
  try {
    const resp = await api.listRooms(session.token)
    rooms.value = resp.rooms as any
  } catch (e: any) {
    const msg = e?.message ?? '加载失败'
    if (msg === 'UNAUTHORIZED' || msg === 'HTTP_401') {
      await session.logout()
      await router.replace('/auth')
      return
    }
    error.value = msg
  } finally {
    loading.value = false
  }
}

async function onCreateRoom() {
  if (!session.token) {
    await router.replace('/auth')
    return
  }
  try {
    const resp = await api.createRoom(session.token, {
      name: createName.value,
      maxPlayers: createMaxPlayers.value,
    })
    await router.push(`/room/${resp.room.id}`)
  } catch (e: any) {
    const msg = e?.message ?? '创建失败'
    if (msg === 'UNAUTHORIZED' || msg === 'HTTP_401') {
      await session.logout()
      await router.replace('/auth')
      return
    }
    error.value = msg
  }
}

async function onJoin(roomId: string) {
  await router.push(`/room/${roomId}`)
}

async function onLogout() {
  await session.logout()
  await router.replace('/auth')
}

onMounted(() => {
  // 提前建立 socket 连接，确保进入房间时连接已就绪
  try {
    connect()
  } catch (e) {
    console.error('Socket connection failed:', e)
  }
  
  loadRooms()
  setInterval(loadRooms, 3000)
})
</script>

<template>
  <div class="min-h-dvh px-4 py-4">
    <div class="mx-auto max-w-md">
      <div class="sticky top-0 z-10 -mx-4 mb-3 border-b border-white/10 bg-[#0b1020]/95 px-4 py-3 backdrop-blur">
        <div class="flex items-center justify-between">
          <div>
            <div class="text-base font-semibold">游戏大厅</div>
            <div class="text-xs text-white/60">你好，{{ session.user?.nickname }}</div>
          </div>
          <div class="flex items-center gap-2">
            <button
              v-if="session.user?.isGuest"
              class="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80"
              @click="router.push('/auth')"
            >
              绑定账号
            </button>
            <button
              class="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80"
              @click="router.push('/replays')"
            >
              回放
            </button>
            <button
              class="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80"
              @click="onLogout"
            >
              退出
            </button>
          </div>
        </div>
      </div>

      <div class="rounded-xl border border-white/10 bg-white/5 p-4">
        <div class="mb-3 text-sm font-medium">创建房间</div>
        <div v-if="error" class="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {{ error }}
        </div>
        <div class="space-y-3">
          <div>
            <div class="mb-1 text-xs text-white/70">房间名（可选）</div>
            <input
              v-model="createName"
              class="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-white/25"
              placeholder="例如：周末开黑"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-white/70">最大人数</div>
            <div class="grid grid-cols-3 gap-2">
              <button
                v-for="n in [9, 12, 15]"
                :key="n"
                class="rounded-lg border px-3 py-2 text-sm"
                :class="createMaxPlayers === n ? 'border-violet-500/60 bg-violet-600/20 text-white' : 'border-white/10 bg-white/5 text-white/80'"
                @click="createMaxPlayers = n"
              >
                {{ n }} 人
              </button>
            </div>
            <div class="mt-2 flex items-center gap-2">
              <input
                v-model.number="createMaxPlayers"
                type="number"
                min="4"
                max="20"
                class="w-28 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-white/25"
              />
              <div class="text-xs text-white/60">支持 4–20 人</div>
            </div>
          </div>
          <button
            class="w-full rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-violet-500"
            @click="onCreateRoom"
          >创建并进入</button>
        </div>
      </div>

      <div class="mt-4">
        <div class="mb-2 flex items-center justify-between">
          <div class="text-sm font-medium">房间列表</div>
          <button
            class="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80"
            :disabled="loading"
            @click="loadRooms"
          >
            刷新
          </button>
        </div>

        <div v-if="rooms.length === 0" class="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-white/70">
          暂无房间，创建一个开始吧。
        </div>

        <div v-else class="space-y-2">
          <button
            v-for="r in rooms"
            :key="r.id"
            class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-left transition active:scale-[0.99]"
            @click="onJoin(r.id)"
          >
            <div class="flex items-center justify-between">
              <div class="text-sm font-medium">{{ r.name }}</div>
              <div class="text-xs text-white/60">{{ r.playerCount }}/{{ r.maxPlayers }}</div>
            </div>
            <div class="mt-1 text-xs text-white/60">状态：{{ r.status }}</div>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
