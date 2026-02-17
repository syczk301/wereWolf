<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/utils/api'
import { useSessionStore } from '@/stores/session'
import { useRoomStore } from '@/stores/room'

type RoomSummary = { id: string; name: string; status: string; playerCount: number; maxPlayers: number; roomNumber?: number }

const router = useRouter()
const session = useSessionStore()
const room = useRoomStore()

const rooms = ref<RoomSummary[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const searchQuery = ref('')
const canShowAdmin = ref(false)

const filteredRooms = computed(() => {
  if (!searchQuery.value.trim()) return rooms.value
  const q = searchQuery.value.trim().toLowerCase()
  return rooms.value.filter(r => 
    r.name.toLowerCase().includes(q) || 
    (r.roomNumber && String(r.roomNumber).includes(q))
  )
})

const createName = ref('')
const createMaxPlayers = ref(9)
const activeTab = ref<'rooms' | 'create'>('rooms')

let pollTimer: ReturnType<typeof setInterval> | null = null

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
      name: createName.value || '狼人杀房间',
      maxPlayers: createMaxPlayers.value,
    })
    room.applyRoom(resp.room)
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

function goAdmin() {
  router.push('/admin/users')
}

async function checkAdminAccess() {
  if (!session.token) {
    canShowAdmin.value = false
    return
  }
  try {
    await api.listAdminUsers(session.token, '', 1)
    canShowAdmin.value = true
  } catch {
    canShowAdmin.value = false
  }
}

onMounted(() => {
  loadRooms()
  checkAdminAccess()
  pollTimer = setInterval(loadRooms, 3000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <div class="min-h-dvh relative overflow-hidden flex flex-col">
    <!-- Background -->
    <div class="fixed inset-0 z-0 pointer-events-none">
      <div class="absolute inset-0 bg-gradient-to-b from-[#151530] via-[#1a1a35] to-[#0d0d1a]" />
      <!-- Moon -->
      <div class="absolute top-[8%] right-[6%] w-20 h-20 opacity-50">
        <div class="absolute -inset-6 rounded-full bg-yellow-100/15 blur-3xl" />
        <div class="absolute inset-0 rounded-full bg-gradient-to-br from-yellow-50 via-yellow-100 to-yellow-200 shadow-[0_0_60px_20px_rgba(255,255,200,0.3)]" />
        <div class="absolute top-4 left-5 w-3 h-3 rounded-full bg-yellow-300/30" />
        <div class="absolute top-8 right-4 w-4 h-4 rounded-full bg-yellow-300/20" />
      </div>
      <!-- Stars -->
      <div class="absolute inset-0">
        <div
          class="absolute w-1.5 h-1.5 bg-white rounded-full animate-pulse"
          style="top: 10%; left: 12%;"
        />
        <div
          class="absolute w-1 h-1 bg-white/80 rounded-full animate-pulse"
          style="top: 5%; left: 35%; animation-delay: 0.4s;"
        />
        <div
          class="absolute w-1.5 h-1.5 bg-white rounded-full animate-pulse"
          style="top: 15%; left: 50%; animation-delay: 0.8s;"
        />
        <div
          class="absolute w-1 h-1 bg-white/70 rounded-full animate-pulse"
          style="top: 8%; left: 70%; animation-delay: 1.2s;"
        />
        <div
          class="absolute w-1 h-1 bg-white/80 rounded-full animate-pulse"
          style="top: 22%; left: 20%; animation-delay: 1.6s;"
        />
        <div
          class="absolute w-1.5 h-1.5 bg-white/90 rounded-full animate-pulse"
          style="top: 18%; left: 88%; animation-delay: 2s;"
        />
      </div>
      <!-- Forest -->
      <div class="absolute bottom-0 left-0 right-0 h-28">
        <svg
          class="w-full h-full"
          viewBox="0 0 1440 120"
          preserveAspectRatio="none"
          fill="#080810"
        >
          <path d="M0,120 L0,80 Q30,60 60,80 L80,50 Q100,30 120,50 L140,70 Q160,50 180,70 L200,40 Q220,20 240,40 L260,60 Q280,40 300,60 L320,45 Q340,25 360,45 L380,75 Q400,55 420,75 L440,35 Q460,15 480,35 L500,65 Q520,45 540,65 L560,50 Q580,30 600,50 L620,80 Q640,60 660,80 L680,55 Q700,35 720,55 L740,70 Q760,50 780,70 L800,40 Q820,20 840,40 L860,75 Q880,55 900,75 L920,50 Q940,30 960,50 L980,65 Q1000,45 1020,65 L1040,80 Q1060,60 1080,80 L1100,45 Q1120,25 1140,45 L1160,70 Q1180,50 1200,70 L1220,55 Q1240,35 1260,55 L1280,75 Q1300,55 1320,75 L1340,60 Q1360,40 1380,60 L1400,80 Q1420,60 1440,80 L1440,120 Z" />
        </svg>
      </div>
      <div class="absolute bottom-24 left-0 right-0 h-16 bg-gradient-to-t from-purple-900/15 to-transparent blur-2xl" />
    </div>

    <!-- Header -->
    <header class="relative z-10 flex items-center justify-between px-4 py-3 pt-safe">
      <div class="flex items-center gap-3">
        <div class="h-10 w-10 rounded-xl bg-gradient-to-br from-red-900/80 to-red-950/80 border border-red-500/30 flex items-center justify-center shadow-lg shadow-red-900/30">
          <svg
            class="w-5 h-5 text-red-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          >
            <path d="M12 3C7 3 3 7.5 3 12c0 3.5 2 6.5 5 8l1-2c-2-1-3.5-3.5-3.5-6C5.5 8.5 8.5 5.5 12 5.5S18.5 8.5 18.5 12c0 2.5-1.5 5-3.5 6l1 2c3-1.5 5-4.5 5-8 0-4.5-4-9-9-9z" />
            <circle
              cx="9"
              cy="11"
              r="1.5"
              fill="currentColor"
            />
            <circle
              cx="15"
              cy="11"
              r="1.5"
              fill="currentColor"
            />
            <path
              d="M9 15c1.5 1.5 4.5 1.5 6 0"
              stroke-linecap="round"
            />
          </svg>
        </div>
        <div>
          <h1 class="text-lg font-black text-transparent bg-clip-text bg-gradient-to-r from-red-400 via-orange-300 to-red-400">
            狼人杀
          </h1>
          <p class="text-[10px] text-white/35 tracking-wider uppercase">
            Werewolf Game
          </p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <div class="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
          <div class="h-6 w-6 rounded-full bg-gradient-to-br from-violet-500 to-violet-700 flex items-center justify-center text-[10px] font-bold text-white">
            {{ session.user?.nickname?.slice(0, 1)?.toUpperCase() || '?' }}
          </div>
          <span class="text-xs text-white/70 max-w-[60px] truncate">{{ session.user?.nickname }}</span>
        </div>
        <button
          v-if="canShowAdmin"
          class="h-10 rounded-xl border border-white/10 bg-white/5 px-3 text-xs text-white/70 transition-all duration-200 hover:bg-white/10 hover:text-white/90"
          aria-label="账号管理"
          @click="goAdmin"
        >
          后台
        </button>
        <button
          class="h-10 w-10 rounded-xl border border-white/10 bg-white/5 flex items-center justify-center text-white/50 transition-all duration-200 hover:bg-white/10 hover:text-white/80"
          aria-label="退出登录"
          @click="onLogout"
        >
          <svg
            class="h-4 w-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
            />
          </svg>
        </button>
      </div>
    </header>

    <!-- Tab Bar -->
    <div class="relative z-10 px-4 mt-1">
      <div class="flex rounded-xl border border-white/10 bg-white/5 backdrop-blur-sm p-1">
        <button
          class="flex-1 rounded-lg py-2.5 text-sm font-medium transition-all duration-200"
          :class="activeTab === 'rooms' ? 'bg-white/10 text-white shadow-sm' : 'text-white/50 hover:text-white/70'"
          @click="activeTab = 'rooms'"
        >
          <span class="flex items-center justify-center gap-1.5">
            <svg
              class="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
            房间列表
          </span>
        </button>
        <button
          class="flex-1 rounded-lg py-2.5 text-sm font-medium transition-all duration-200"
          :class="activeTab === 'create' ? 'bg-white/10 text-white shadow-sm' : 'text-white/50 hover:text-white/70'"
          @click="activeTab = 'create'"
        >
          <span class="flex items-center justify-center gap-1.5">
            <svg
              class="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M12 4v16m8-8H4"
              />
            </svg>
            创建房间
          </span>
        </button>
      </div>
    </div>

    <!-- Main Content -->
    <main class="relative z-10 flex-1 px-4 pt-4 pb-20 overflow-y-auto">
      <!-- Room List Panel -->
      <div v-show="activeTab === 'rooms'">
        <!-- Search -->
        <div class="relative mb-3">
          <input
            v-model="searchQuery"
            class="w-full rounded-xl border border-white/10 bg-white/5 pl-10 pr-4 py-3 text-sm text-white placeholder-white/25 outline-none transition-all duration-200 focus:border-violet-500/50 focus:bg-white/10 focus:ring-2 focus:ring-violet-500/20 backdrop-blur-sm"
            placeholder="搜索房间号或名称..."
          >
          <svg
            class="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </div>

        <!-- Refresh -->
        <div class="flex items-center justify-between mb-3">
          <span class="text-xs text-white/40">{{ filteredRooms.length }} 个房间</span>
          <button
            class="flex items-center gap-1 text-xs text-white/40 hover:text-white/70 transition-colors duration-200 py-1 px-2"
            @click="loadRooms"
          >
            <svg
              class="w-3.5 h-3.5"
              :class="loading ? 'animate-spin' : ''"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            刷新
          </button>
        </div>

        <!-- Empty -->
        <div
          v-if="filteredRooms.length === 0"
          class="text-center py-16"
        >
          <div class="mx-auto mb-4 w-14 h-14 rounded-2xl bg-white/5 flex items-center justify-center">
            <svg
              class="w-7 h-7 text-white/20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="1.5"
                d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
              />
            </svg>
          </div>
          <p class="text-sm text-white/40">
            {{ searchQuery ? '未找到房间' : '暂无房间' }}
          </p>
          <p class="text-xs text-white/20 mt-1">
            创建一个开始游戏吧
          </p>
          <button
            class="mt-4 rounded-xl bg-gradient-to-r from-red-600 to-orange-500 px-6 py-2.5 text-sm font-medium text-white shadow-lg transition-all duration-200 hover:shadow-red-500/30 active:scale-[0.98]"
            @click="activeTab = 'create'"
          >
            创建房间
          </button>
        </div>

        <!-- Room Cards -->
        <div
          v-else
          class="space-y-2"
        >
          <button
            v-for="(r, idx) in filteredRooms"
            :key="r.id"
            class="w-full rounded-xl border border-white/10 bg-white/5 p-4 backdrop-blur-sm transition-all duration-200 hover:bg-white/10 hover:border-white/20 animate-fade-in active:scale-[0.98]"
            :style="{ animationDelay: `${idx * 0.04}s` }"
            @click="onJoin(r.id)"
          >
            <div class="flex items-center gap-3">
              <!-- Room Icon -->
              <div
                class="h-11 w-11 rounded-xl flex items-center justify-center flex-shrink-0"
                :class="r.status === 'waiting' ? 'bg-emerald-500/15 border border-emerald-500/20' : 'bg-amber-500/15 border border-amber-500/20'"
              >
                <svg
                  class="w-5 h-5"
                  :class="r.status === 'waiting' ? 'text-emerald-400' : 'text-amber-400'"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
              </div>
              <!-- Info -->
              <div class="flex-1 text-left min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-semibold text-white/90 truncate">{{ r.name }}</span>
                  <span class="text-[10px] font-mono text-white/25 flex-shrink-0">#{{ r.roomNumber }}</span>
                </div>
                <div class="flex items-center gap-3 mt-0.5">
                  <span class="text-xs text-white/40">{{ r.playerCount }}/{{ r.maxPlayers }} 人</span>
                  <span
                    class="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                    :class="r.status === 'waiting' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'"
                  >
                    {{ r.status === 'waiting' ? '等待中' : '游戏中' }}
                  </span>
                </div>
              </div>
              <!-- Arrow -->
              <svg
                class="w-4 h-4 text-white/20 flex-shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M9 5l7 7-7 7"
                />
              </svg>
            </div>
          </button>
        </div>
      </div>

      <!-- Create Room Panel -->
      <div
        v-show="activeTab === 'create'"
        class="animate-slide-up"
      >
        <div class="rounded-2xl border border-white/10 bg-gradient-to-br from-[#1a233b]/80 to-[#0d1526]/80 backdrop-blur-xl overflow-hidden">
          <div class="px-5 py-3 border-b border-white/10 bg-white/5">
            <span class="text-sm font-bold text-white">新建房间</span>
          </div>
          <div class="p-5 space-y-5">
            <div
              v-if="error"
              class="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-300"
            >
              {{ error }}
            </div>

            <div>
              <label
                for="create-name"
                class="block text-xs font-medium text-white/50 mb-2 tracking-wide"
              >房间名称</label>
              <input
                id="create-name"
                v-model="createName"
                class="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white placeholder-white/25 outline-none transition-all duration-200 focus:border-violet-500/50 focus:bg-black/40 focus:ring-2 focus:ring-violet-500/20"
                placeholder="输入房间名..."
              >
            </div>

            <div>
              <label class="block text-xs font-medium text-white/50 mb-2 tracking-wide">玩家人数</label>
              <div class="grid grid-cols-3 gap-2">
                <button
                  v-for="n in [9, 12, 15]"
                  :key="n"
                  class="rounded-xl border py-3 text-sm font-medium transition-all duration-200"
                  :class="createMaxPlayers === n
                    ? 'border-red-500/50 bg-red-500/15 text-red-300 shadow-lg shadow-red-500/10'
                    : 'border-white/10 bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80'"
                  @click="createMaxPlayers = n"
                >
                  {{ n }}人
                </button>
              </div>
              <div class="flex items-center gap-3 mt-3">
                <input
                  v-model.number="createMaxPlayers"
                  type="number"
                  min="4"
                  max="20"
                  class="w-20 rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-center text-sm text-white outline-none transition-all duration-200 focus:border-violet-500/50 focus:bg-black/40"
                >
                <span class="text-xs text-white/30">自定义 4-20人</span>
              </div>
            </div>

            <button
              class="w-full rounded-xl bg-gradient-to-r from-red-600 via-red-500 to-orange-500 py-3.5 text-sm font-bold text-white shadow-lg shadow-red-900/30 transition-all duration-200 hover:shadow-red-500/40 active:scale-[0.98]"
              @click="onCreateRoom"
            >
              <span class="flex items-center justify-center gap-2">
                <svg
                  class="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M13 10V3L4 14h7v7l9-11h-7z"
                  />
                </svg>
                创建并进入
              </span>
            </button>
          </div>
        </div>

        <!-- Tips -->
        <div class="mt-4 rounded-xl border border-white/10 bg-white/5 p-4">
          <p class="text-[10px] uppercase tracking-widest text-white/30 mb-1.5">
            提示
          </p>
          <p class="text-xs text-white/45 leading-relaxed">
            创建房间后分享房间号给好友，凑齐人数即可开始狼人杀游戏。人数不足时可添加机器人。
          </p>
        </div>
      </div>
    </main>

    <!-- Bottom Navigation -->
    <nav class="fixed bottom-0 left-0 right-0 z-30 border-t border-white/10 bg-[#0a0f1a]/95 backdrop-blur-xl pb-safe">
      <div class="flex">
        <button
          class="flex-1 flex flex-col items-center gap-0.5 py-2.5 transition-colors duration-200"
          :class="'text-white'"
        >
          <svg
            class="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
            />
          </svg>
          <span class="text-[10px] font-medium">大厅</span>
        </button>
        <button
          v-if="canShowAdmin"
          class="flex-1 flex flex-col items-center gap-0.5 py-2.5 text-white/40 transition-colors duration-200 hover:text-white/60"
          @click="router.push('/admin/users')"
        >
          <svg
            class="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M12 14c2.761 0 5-2.239 5-5s-2.239-5-5-5-5 2.239-5 5 2.239 5 5 5z"
            />
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M6 20v-1a6 6 0 0112 0v1"
            />
          </svg>
          <span class="text-[10px] font-medium">后台</span>
        </button>
        <button
          class="flex-1 flex flex-col items-center gap-0.5 py-2.5 text-white/40 transition-colors duration-200 hover:text-white/60"
          @click="router.push('/replays')"
        >
          <svg
            class="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
            />
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <span class="text-[10px] font-medium">回放</span>
        </button>
      </div>
    </nav>
  </div>
</template>

<style scoped>
/* Custom scrollbar for room list */
main::-webkit-scrollbar {
  width: 3px;
}
main::-webkit-scrollbar-track {
  background: transparent;
}
main::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,0.08);
  border-radius: 2px;
}
</style>
