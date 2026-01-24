<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/utils/api'
import { useSessionStore } from '@/stores/session'
import { useSocket } from '@/composables/useSocket'
import { useRoomStore } from '@/stores/room'

type RoomSummary = { id: string; name: string; status: string; playerCount: number; maxPlayers: number; roomNumber?: number }

const router = useRouter()
const session = useSessionStore()
const { connect } = useSocket()
const room = useRoomStore()

const rooms = ref<RoomSummary[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const searchQuery = ref('')
const showCreateModal = ref(false)

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

onMounted(() => {
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
  <div class="min-h-dvh relative overflow-hidden">
    <!-- Immersive Background -->
    <div class="fixed inset-0 z-0 pointer-events-none">
      <!-- Night sky gradient -->
      <div class="absolute inset-0 bg-gradient-to-b from-[#151530] via-[#1a1a35] to-[#0d0d1a]"></div>
      
      <!-- Moon with glow -->
      <!-- Moon with glow - Moved to bottom right to avoid blocking user info -->
      <div class="absolute bottom-8 right-[5%] w-28 h-28 opacity-60">
        <div class="relative w-full h-full">
          <!-- Moon glow -->
          <div class="absolute -inset-8 rounded-full bg-yellow-100/20 blur-3xl"></div>
          <!-- Moon body -->
          <div class="absolute inset-0 rounded-full bg-gradient-to-br from-yellow-50 via-yellow-100 to-yellow-200 shadow-[0_0_80px_30px_rgba(255,255,200,0.4)]"></div>
          <!-- Moon texture -->
          <div class="absolute top-5 left-7 w-4 h-4 rounded-full bg-yellow-300/30"></div>
          <div class="absolute top-10 right-6 w-5 h-5 rounded-full bg-yellow-300/20"></div>
          <div class="absolute bottom-6 left-10 w-3 h-3 rounded-full bg-yellow-300/25"></div>
        </div>
      </div>

      <!-- Stars scattered -->
      <div class="absolute inset-0">
        <div class="absolute w-1.5 h-1.5 bg-white rounded-full animate-pulse" style="top: 8%; left: 15%;"></div>
        <div class="absolute w-1 h-1 bg-white/80 rounded-full animate-pulse" style="top: 12%; left: 25%; animation-delay: 0.3s;"></div>
        <div class="absolute w-1.5 h-1.5 bg-white rounded-full animate-pulse" style="top: 5%; left: 40%; animation-delay: 0.6s;"></div>
        <div class="absolute w-1 h-1 bg-white/70 rounded-full animate-pulse" style="top: 18%; left: 50%; animation-delay: 0.9s;"></div>
        <div class="absolute w-1.5 h-1.5 bg-white/90 rounded-full animate-pulse" style="top: 10%; left: 65%; animation-delay: 1.2s;"></div>
        <div class="absolute w-1 h-1 bg-white rounded-full animate-pulse" style="top: 22%; left: 75%; animation-delay: 1.5s;"></div>
        <div class="absolute w-1.5 h-1.5 bg-white/80 rounded-full animate-pulse" style="top: 15%; left: 85%; animation-delay: 1.8s;"></div>
        <div class="absolute w-1 h-1 bg-white/90 rounded-full animate-pulse" style="top: 25%; left: 10%; animation-delay: 2.1s;"></div>
        <div class="absolute w-1.5 h-1.5 bg-white rounded-full animate-pulse" style="top: 6%; left: 55%; animation-delay: 2.4s;"></div>
        <div class="absolute w-1 h-1 bg-white/70 rounded-full animate-pulse" style="top: 20%; left: 35%; animation-delay: 2.7s;"></div>
      </div>
      
      <!-- Forest silhouette at bottom -->
      <div class="absolute bottom-0 left-0 right-0 h-40">
        <svg class="w-full h-full" viewBox="0 0 1440 160" preserveAspectRatio="none" fill="#080810">
          <path d="M0,160 L0,100 
            Q20,80 40,95 Q60,60 80,85 Q100,50 120,75 Q140,40 160,70 Q180,30 200,60 
            Q220,45 240,70 Q260,25 280,55 Q300,40 320,65 Q340,20 360,50 Q380,35 400,60 
            Q420,15 440,45 Q460,30 480,55 Q500,10 520,40 Q540,25 560,50 Q580,5 600,35 
            Q620,20 640,45 Q660,0 680,30 Q700,15 720,40 Q740,5 760,35 Q780,20 800,45 
            Q820,10 840,40 Q860,25 880,50 Q900,15 920,45 Q940,30 960,55 Q980,20 1000,50 
            Q1020,35 1040,60 Q1060,25 1080,55 Q1100,40 1120,65 Q1140,30 1160,60 Q1180,45 1200,70 
            Q1220,35 1240,65 Q1260,50 1280,75 Q1300,40 1320,70 Q1340,55 1360,80 Q1380,65 1400,85 
            Q1420,75 1440,100 L1440,160 Z"/>
        </svg>
      </div>

      <!-- Subtle fog near forest -->
      <div class="absolute bottom-32 left-0 right-0 h-24 bg-gradient-to-t from-purple-900/20 to-transparent blur-2xl"></div>
      
      <!-- Floating particles -->
      <div class="absolute bottom-40 left-[10%] w-2 h-2 bg-white/20 rounded-full animate-bounce" style="animation-duration: 4s;"></div>
      <div class="absolute bottom-60 left-[30%] w-1.5 h-1.5 bg-white/15 rounded-full animate-bounce" style="animation-duration: 5s; animation-delay: 1s;"></div>
      <div class="absolute bottom-50 right-[20%] w-2 h-2 bg-white/20 rounded-full animate-bounce" style="animation-duration: 4.5s; animation-delay: 2s;"></div>
    </div>

    <!-- Main Content -->
    <div class="relative z-10 min-h-dvh flex flex-col">
      <!-- Top Bar -->
      <header class="flex items-center justify-between px-6 py-4">
        <div class="flex items-center gap-4">
          <!-- Wolf Icon -->
          <div class="relative">
            <div class="w-14 h-14 rounded-xl bg-gradient-to-br from-red-900/80 to-red-950/80 border border-red-500/30 flex items-center justify-center shadow-lg shadow-red-900/30">
              <svg class="w-8 h-8 text-red-400" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" opacity="0"/>
                <path d="M18.6 4.8c-.4-.4-1.3.2-2 1-.7.8-1.2 1.7-1.7 2.5-.2-.8-.5-1.6-.9-2.3-.4-.8-1.3-1.4-2-1-.7.4-.5 1.5-.1 2.4.4.9.9 1.8 1.3 2.6-1.1-.4-2.2-.6-3.2-.6s-2.1.2-3.2.6c.4-.8.9-1.7 1.3-2.6.4-.9.6-2-.1-2.4-.7-.4-1.6.2-2 1-.4.7-.7 1.5-.9 2.3-.5-.8-1-1.7-1.7-2.5-.7-.8-1.6-1.4-2-1-.4.4-.1 1.4.5 2.2.6.8 1.4 1.5 2.1 2.2-.9.2-1.7.6-2.4 1.1-.8.5-1.3 1.4-.9 2 .4.6 1.4.5 2.2.1.8-.4 1.6-.9 2.3-1.3-.3 1-.5 2.1-.5 3.2 0 1.1.2 2.2.5 3.2-.7-.4-1.5-.9-2.3-1.3-.8-.4-1.8-.5-2.2.1-.4.6.1 1.5.9 2 .7.5 1.5.9 2.4 1.1-.7.7-1.5 1.4-2.1 2.2-.6.8-.9 1.8-.5 2.2.4.4 1.3-.2 2-1 .7-.8 1.2-1.7 1.7-2.5.2.8.5 1.6.9 2.3.4.8 1.3 1.4 2 1 .7-.4.5-1.5.1-2.4-.4-.9-.9-1.8-1.3-2.6 1.1.4 2.2.6 3.2.6s2.1-.2 3.2-.6c-.4.8-.9 1.7-1.3 2.6-.4.9-.6 2 .1 2.4.7.4 1.6-.2 2-1 .4-.7.7-1.5.9-2.3.5.8 1 1.7 1.7 2.5.7.8 1.6 1.4 2 1 .4-.4.1-1.4-.5-2.2-.6-.8-1.4-1.5-2.1-2.2.9-.2 1.7-.6 2.4-1.1.8-.5 1.3-1.4.9-2-.4-.6-1.4-.5-2.2-.1-.8.4-1.6.9-2.3 1.3.3-1 .5-2.1.5-3.2 0-1.1-.2-2.2-.5-3.2.7.4 1.5.9 2.3 1.3.8.4 1.8.5 2.2-.1.4-.6-.1-1.5-.9-2-.7-.5-1.5-.9-2.4-1.1.7-.7 1.5-1.4 2.1-2.2.6-.8.9-1.8.5-2.2zM12 16c-2.2 0-4-1.8-4-4s1.8-4 4-4 4 1.8 4 4-1.8 4-4 4z"/>
              </svg>
            </div>
            <div class="absolute -bottom-1 -right-1 w-4 h-4 bg-emerald-500 rounded-full border-2 border-[#0a0a12] animate-pulse"></div>
          </div>
          <div>
            <h1 class="text-2xl font-black tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-red-400 via-orange-300 to-red-400 drop-shadow-lg">
              狼人杀
            </h1>
            <p class="text-xs text-white/40 tracking-widest uppercase">Werewolf Game</p>
          </div>
        </div>

        <!-- User Info & Actions -->
        <div class="flex items-center gap-3">
          <div class="text-right mr-2">
            <p class="text-sm font-semibold text-white/90">{{ session.user?.nickname }}</p>
            <p class="text-[10px] text-emerald-400">在线</p>
          </div>
          <button
            class="game-btn game-btn-secondary"
            @click="router.push('/replays')"
          >
            回放
          </button>
          <button
            class="game-btn game-btn-danger"
            @click="onLogout"
          >
            退出
          </button>
        </div>
      </header>

      <!-- Main Area -->
      <div class="flex-1 flex items-start justify-center gap-8 px-6 py-8">
        <!-- Left Panel: Create Room -->
        <div class="w-80 flex-shrink-0">
          <div class="game-panel">
            <div class="game-panel-header">
              <span class="text-red-400">+</span> 创建房间
            </div>
            <div class="p-5 space-y-4">
              <div v-if="error" class="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                {{ error }}
              </div>

              <div>
                <label class="game-label">房间名称</label>
                <input
                  v-model="createName"
                  class="game-input"
                  placeholder="输入房间名..."
                />
              </div>

              <div>
                <label class="game-label">玩家人数</label>
                <div class="grid grid-cols-3 gap-2 mt-2">
                  <button
                    v-for="n in [9, 12, 15]"
                    :key="n"
                    class="game-option"
                    :class="{ active: createMaxPlayers === n }"
                    @click="createMaxPlayers = n"
                  >
                    {{ n }}人
                  </button>
                </div>
                <div class="flex items-center gap-2 mt-3">
                  <input
                    v-model.number="createMaxPlayers"
                    type="number"
                    min="4"
                    max="20"
                    class="game-input w-20 text-center"
                  />
                  <span class="text-xs text-white/30">4-20人</span>
                </div>
              </div>

              <button class="game-btn game-btn-primary w-full py-3" @click="onCreateRoom">
                <span class="flex items-center justify-center gap-2">
                  <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>
                  </svg>
                  开始游戏
                </span>
              </button>
            </div>
          </div>

          <!-- Quick Tips -->
          <div class="mt-4 p-4 rounded-lg bg-white/5 border border-white/10">
            <p class="text-[10px] uppercase tracking-widest text-white/30 mb-2">游戏提示</p>
            <p class="text-xs text-white/50 leading-relaxed">
              创建房间后分享房间号给好友，凑齐人数即可开始狼人杀游戏。
            </p>
          </div>
        </div>

        <!-- Right Panel: Room List -->
        <div class="flex-1 max-w-xl">
          <div class="game-panel">
            <div class="game-panel-header flex items-center justify-between">
              <span><span class="text-yellow-400">*</span> 房间列表</span>
              <button
                class="flex items-center gap-1 text-xs text-white/50 hover:text-white/80 transition-colors"
                @click="loadRooms"
              >
                <svg 
                  class="w-4 h-4" 
                  :class="loading ? 'animate-spin' : ''"
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                </svg>
                刷新
              </button>
            </div>

            <!-- Search -->
            <div class="px-5 pt-4">
              <div class="relative">
                <input
                  v-model="searchQuery"
                  class="game-input pl-10"
                  placeholder="搜索房间号或名称..."
                />
                <svg class="absolute left-3 top-2.5 w-4 h-4 text-white/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
                </svg>
              </div>
            </div>

            <!-- Room List -->
            <div class="p-5 max-h-[400px] overflow-y-auto custom-scrollbar">
              <div v-if="filteredRooms.length === 0" class="text-center py-12">
                <div class="w-16 h-16 mx-auto mb-4 rounded-full bg-white/5 flex items-center justify-center">
                  <svg class="w-8 h-8 text-white/20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/>
                  </svg>
                </div>
                <p class="text-sm text-white/40">{{ searchQuery ? '未找到房间' : '暂无房间' }}</p>
                <p class="text-xs text-white/20 mt-1">创建一个开始游戏吧</p>
              </div>

              <div v-else class="space-y-2">
                <button
                  v-for="(r, idx) in filteredRooms"
                  :key="r.id"
                  class="room-card animate-fade-in"
                  :style="{ animationDelay: `${idx * 0.05}s` }"
                  @click="onJoin(r.id)"
                >
                  <div class="flex items-center gap-4">
                    <!-- Room Icon -->
                    <div class="w-12 h-12 rounded-lg flex items-center justify-center"
                      :class="r.status === 'waiting' ? 'bg-emerald-500/20' : 'bg-amber-500/20'">
                      <svg class="w-6 h-6" :class="r.status === 'waiting' ? 'text-emerald-400' : 'text-amber-400'" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"/>
                      </svg>
                    </div>

                    <!-- Room Info -->
                    <div class="flex-1 text-left">
                      <div class="flex items-center gap-2">
                        <span class="font-semibold text-white/90">{{ r.name }}</span>
                        <span class="text-xs font-mono text-white/30">#{{ r.roomNumber }}</span>
                      </div>
                      <div class="flex items-center gap-3 mt-1">
                        <span class="text-xs text-white/40">
                          <span class="text-white/60 font-medium">{{ r.playerCount }}</span>/{{ r.maxPlayers }} 玩家
                        </span>
                      </div>
                    </div>

                    <!-- Status -->
                    <div 
                      class="px-3 py-1.5 rounded-lg text-xs font-semibold"
                      :class="r.status === 'waiting' 
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' 
                        : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'"
                    >
                      {{ r.status === 'waiting' ? '等待中' : '游戏中' }}
                    </div>

                    <!-- Arrow -->
                    <svg class="w-5 h-5 text-white/20 group-hover:text-white/50 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
                    </svg>
                  </div>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <footer class="px-6 py-4 text-center">
        <p class="text-[10px] text-white/20 tracking-widest uppercase">Werewolf Game v1.0</p>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* Game Panel */
.game-panel {
  @apply bg-gradient-to-b from-[#1a1a2e]/90 to-[#0d0d1a]/90 rounded-xl border border-white/10 backdrop-blur-sm overflow-hidden;
  box-shadow: 0 0 40px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05);
}

.game-panel-header {
  @apply px-5 py-3 text-sm font-bold tracking-wide border-b border-white/10 bg-white/5;
  text-shadow: 0 0 20px rgba(255,255,255,0.3);
}

/* Game Inputs */
.game-label {
  @apply block text-xs font-medium text-white/50 mb-1.5 tracking-wide uppercase;
}

.game-input {
  @apply w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white placeholder-white/20 outline-none transition-all duration-300;
  @apply focus:border-red-500/50 focus:bg-black/50 focus:ring-2 focus:ring-red-500/20;
}

/* Game Options */
.game-option {
  @apply rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-white/60 transition-all duration-200;
  @apply hover:bg-white/10 hover:text-white/80;
}

.game-option.active {
  @apply border-red-500/50 bg-red-500/20 text-red-300;
  box-shadow: 0 0 20px rgba(239, 68, 68, 0.2);
}

/* Game Buttons */
.game-btn {
  @apply px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-200 border;
  @apply active:scale-95;
}

.game-btn-primary {
  @apply bg-gradient-to-r from-red-600 to-red-700 border-red-500/50 text-white;
  @apply hover:from-red-500 hover:to-red-600;
  box-shadow: 0 0 20px rgba(239, 68, 68, 0.3), inset 0 1px 0 rgba(255,255,255,0.1);
}

.game-btn-secondary {
  @apply bg-white/5 border-white/10 text-white/70;
  @apply hover:bg-white/10 hover:text-white;
}

.game-btn-danger {
  @apply bg-white/5 border-white/10 text-white/70;
  @apply hover:bg-red-500/20 hover:border-red-500/30 hover:text-red-400;
}

/* Room Card */
.room-card {
  @apply w-full p-4 rounded-lg bg-white/5 border border-white/10 transition-all duration-200;
  @apply hover:bg-white/10 hover:border-white/20 hover:scale-[1.01];
}

/* Stars */
.star {
  @apply absolute w-1 h-1 bg-white rounded-full opacity-60;
  animation: twinkle 2s ease-in-out infinite;
}

@keyframes twinkle {
  0%, 100% { opacity: 0.3; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.2); }
}

/* Particles */
.particle {
  @apply absolute w-1 h-1 bg-white/50 rounded-full;
  animation: float linear infinite;
}

@keyframes float {
  0% { transform: translateY(0) translateX(0); opacity: 0; }
  10% { opacity: 0.5; }
  90% { opacity: 0.5; }
  100% { transform: translateY(-100vh) translateX(20px); opacity: 0; }
}

/* Custom Scrollbar */
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}

.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}

.custom-scrollbar::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,0.1);
  border-radius: 2px;
}

.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: rgba(255,255,255,0.2);
}
</style>
