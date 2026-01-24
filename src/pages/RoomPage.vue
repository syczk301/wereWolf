<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSocket } from '@/composables/useSocket'
import { useRoomStore } from '@/stores/room'
import { useSessionStore } from '@/stores/session'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const room = useRoomStore()
const { connect, socket } = useSocket()

const roomId = computed(() => String(route.params.roomId || ''))
const connected = ref(false)
const joining = ref(false)

const chatText = ref('')
const chatChannel = ref<'public' | 'wolf'>('public')

const isOwner = computed(() => {
  if (!room.roomState || !session.user) return false
  return room.roomState.ownerUserId === session.user.id
})

const meSeat = computed(() => room.gamePrivate?.seat ?? null)

const aliveSeats = computed(() => {
  const players = room.gamePublic?.players ?? []
  return players.filter((p) => p.isAlive).map((p) => p.seat)
})

const sortedMembers = computed(() => {
  return [...(room.roomState?.members || [])].sort((a, b) => a.seat - b.seat)
})

const leftMembers = computed(() => {
  const m = sortedMembers.value
  const half = Math.ceil(m.length / 2)
  return m.slice(0, half)
})

const rightMembers = computed(() => {
  const m = sortedMembers.value
  const half = Math.ceil(m.length / 2)
  return m.slice(half)
})

const phaseLabel = computed(() => {
  const p = room.gamePublic?.phase
  if (!p) return '等待中'
  if (p === 'night') return '夜晚行动'
  if (p === 'day_speech') return '白天发言'
  if (p === 'day_vote') return '白天投票'
  if (p === 'settlement') return '结算阶段'
  if (p === 'sheriff_election') return '警长竞选：本轮报名'
  if (p === 'sheriff_speech') return '警长竞选：发布政见'
  if (p === 'sheriff_vote') return '警长竞选：投票阶段'
  return '游戏结束'
})

const phaseBackground = computed(() => {
  const p = room.gamePublic?.phase
  if (!p) return 'from-[#1a233b] to-[#0b1020]' // Default
  if (p === 'night') return 'from-[#0f172a] via-[#020617] to-[#0f172a]' // Deep Night
  if (p.includes('day') || p.includes('sheriff')) return 'from-[#3b82f6]/20 via-[#0b1020] to-[#0b1020]' // Day (Blue tint)
  if (p === 'settlement') return 'from-[#4c1d95]/30 via-[#0b1020] to-[#0b1020]' // Settlement (Purple tint)
  return 'from-[#1a233b] to-[#0b1020]'
})

// Countdowns and progress are now in the store
const secondsLeft = computed(() => room.secondsLeft)
const timerProgress = computed(() => room.timerProgress)
const isTimeLow = computed(() => room.isTimeLow)

const roleConfig = computed(() => (room.roomState?.roleConfig ?? { werewolf: 2, seer: 1, witch: 1, hunter: 0, guard: 0 }) as any)
const timers = computed(() => (room.roomState?.timers ?? { nightSeconds: 45, daySpeechSeconds: 60, dayVoteSeconds: 45, settlementSeconds: 20 }) as any)

const localRoleConfig = ref({ ...roleConfig.value })
const localTimers = ref({ ...timers.value })

function syncLocalConfig() {
  localRoleConfig.value = { ...roleConfig.value }
  localTimers.value = { ...timers.value }
}

function emitConfig() {
  if (!socket.value) return
  socket.value.emit('room:config:update', { roomId: roomId.value, roleConfig: localRoleConfig.value, timers: localTimers.value })
}

function setReady(ready: boolean) {
  if (!socket.value) return
  socket.value.emit('room:ready', { roomId: roomId.value, ready })
}

// 弹窗状态
const showBotConfirm = ref(false)
const neededBots = ref(0)
const addingBots = ref(false)

function startGame() {
  if (!socket.value) return
  
  // 先检查人数
  const members = room.roomState?.members || []
  const playerCount = members.filter(m => m.user).length
  const maxPlayers = room.roomState?.maxPlayers || 9
  
  if (playerCount < maxPlayers) {
    neededBots.value = maxPlayers - playerCount
    showBotConfirm.value = true
    return
  }
  
  socket.value.emit('room:start', { roomId: roomId.value })
}

function confirmAddBots() {
  if (!socket.value) return
  addingBots.value = true
  
  // 使用后端一键补员，无需前端循环等待
  socket.value.emit('room:bot:fill', { roomId: roomId.value })

  // 给予短暂缓冲等待后端处理并更新状态，然后自动开局
  setTimeout(() => {
    addingBots.value = false
    showBotConfirm.value = false
    socket.value?.emit('room:start', { roomId: roomId.value })
  }, 600)
}

function cancelBotConfirm() {
  showBotConfirm.value = false
  neededBots.value = 0
}

function addBot() {
  if (!socket.value) return
  socket.value.emit('room:bot:add', { roomId: roomId.value })
}

function sendChat() {
  if (!socket.value) return
  const text = chatText.value.trim()
  if (!text) return
  socket.value.emit('chat:send', { roomId: roomId.value, text, channel: chatChannel.value })
  chatText.value = ''
}

function submitAction(actionType: string, payload: any) {
  if (!socket.value) return
  socket.value.emit('game:action', { roomId: roomId.value, actionType, payload })
}

function leaveRoom() {
  if (!socket.value) return
  socket.value.emit('room:leave', { roomId: roomId.value })
  router.push('/lobby')
}

function setupSocketListeners(s: any) {
  s.on('room:state', (payload: any) => {
    room.applyRoom(payload)
    syncLocalConfig()
  })
  s.on('game:state', (payload: any) => {
    room.applyGamePublic(payload)
  })
  s.on('game:private', (payload: any) => {
    room.applyGamePrivate(payload)
  })
  s.on('chat:new', (payload: any) => {
    room.pushChat(payload)
  })
  s.on('toast', (payload: any) => {
    room.pushToast(payload.type, payload.message)
  })
  s.on('room:expired', async () => {
    room.pushToast('info', '房间超时解散')
    room.reset()
    await router.replace('/lobby')
  })
  s.on('room:dissolved', async () => {
    room.pushToast('info', '房间已解散')
    room.reset()
    await router.replace('/lobby')
  })
}

async function join() {
  if (joining.value) return
  // If we already have state matching this room, show as connected
  if (room.roomState && room.roomState.id === roomId.value) {
    connected.value = true
  }
  
  joining.value = true
  try {
    const s = connect()
    
    // 注册事件监听器
    setupSocketListeners(s)
    
    // 立即发送 join，不等待连接
    // socket.io 会自动在连接后发送
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('JOIN_TIMEOUT'))
      }, 5000)
      
      s.emit('room:join', { roomId: roomId.value }, (resp) => {
        clearTimeout(timeout)
        if (resp && 'ok' in resp && resp.ok === true) {
          connected.value = true
          resolve()
        }
        else reject(new Error((resp as any)?.error ?? 'JOIN_FAILED'))
      })
    })
  } catch (e: any) {
    room.pushToast('error', e?.message ?? '加入失败')
    await router.replace('/lobby')
  } finally {
    joining.value = false
  }
}

const roleLabels: Record<string, string> = {
  werewolf: '狼人',
  seer: '预言家',
  witch: '女巫',
  hunter: '猎人',
  guard: '守卫',
  villager: '村民'
}

const myRoleLabel = computed(() => {
  const r = room.gamePrivate?.role
  return r ? (roleLabels[r] || r) : ''
})

const activeRoleLabel = computed(() => {
  const r = room.gamePublic?.activeRole
  return r ? (roleLabels[r] || r) : ''
})

const witchActionStep = ref<'save' | 'poison'>('save')

watch(() => room.gamePublic?.activeRole, (newRole) => {
  if (newRole === 'witch') {
    witchActionStep.value = 'save'
  }
})

const latestSeerInfo = computed(() => {
  if (!room.gamePrivate?.hints?.length) return null
  // 查找最新的查验信息
  const checkHint = [...room.gamePrivate.hints].reverse().find(h => h.text.includes('查验了'))
  return checkHint ? checkHint.text : null
})

function speak(text: string) {
  if (!window.speechSynthesis) return
  window.speechSynthesis.cancel() // Stop current
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = 'zh-CN'
  utterance.rate = 1.0
  window.speechSynthesis.speak(utterance)
}

// 角色图标映射
function getRoleIcon(role?: string): string {
  const icons: Record<string, string> = {
    werewolf: '🐺',
    seer: '🔮',
    witch: '🧪',
    guard: '🛡',
    hunter: '🏹',
    villager: '🏠'
  }
  return icons[role || ''] || '❓'
}

// 角色样式类映射
function getRoleClass(role?: string): string {
  const classes: Record<string, string> = {
    werewolf: 'role-werewolf',
    seer: 'role-seer',
    witch: 'role-witch',
    guard: 'role-guard',
    hunter: 'role-hunter',
    villager: 'role-villager'
  }
  return classes[role || ''] || 'role-unknown'
}

// 监听阶段变化进行语音播报（大阶段）
watch(() => room.gamePublic?.phase, (newPhase) => {
  if (!newPhase) return
  if (newPhase === 'night') {
    speak('天黑请闭眼')
  } else if (newPhase === 'day_speech') {
    speak('天亮了，请睁眼')
  } else if (newPhase === 'game_over') {
    speak('游戏结束')
  }
})

// 监听具体行动角色变化进行语音播报（夜间子阶段）
watch(() => room.gamePublic?.activeRole, (newRole, oldRole) => {
  if (room.gamePublic?.phase !== 'night' || !newRole || newRole === oldRole) return
  
  const announcementMap: Record<string, string> = {
    werewolf: '狼人请睁眼',
    seer: '预言家请睁眼',
    witch: '女巫请睁眼',
    guard: '守卫请睁眼',
    hunter: '猎人请睁眼'
  }
  
  const text = announcementMap[newRole]
  if (text) {
    // 延迟一点播报，让上一阶段结束的音效先播完，或者营造节奏感
    setTimeout(() => speak(text), 1500)
  }
})

watch(() => room.gamePublic?.activeRole, (newRole, oldRole) => {
  if (room.gamePublic?.phase !== 'night') return
  if (!newRole) return
  if (oldRole) speak(`${roleLabels[oldRole] || oldRole}请闭眼`)
  setTimeout(() => {
    speak(`${roleLabels[newRole] || newRole}请睁眼`)
  }, 1500)
})

watch(() => room.gamePublic?.activeSpeakerSeat, (newSeat) => {
  if (newSeat) {
    speak(`${newSeat}号玩家发言`)
  }
})

watch(() => room.gamePublic?.phase, (newPhase) => {
  if (newPhase === 'sheriff_election') {
    speak('警长竞选开始，请各位玩家选择是否参与竞选')
  } else if (newPhase === 'sheriff_vote') {
    speak('请警下玩家进行投票')
  }
})


const nowTs = ref(Date.now())
let interval: any = null

onMounted(() => {
  room.reset()
  join()
  interval = setInterval(() => {
    nowTs.value = Date.now()
    // Explicitly update room's now if needed, though room should have its own.
    // We'll use local nowTs for UI consistency if store refresh is flaky.
    room.now = nowTs.value 
  }, 1000)
})

onUnmounted(() => {
  room.reset()
  if (interval) clearInterval(interval)
})
</script>

<template>
  <div class="room-page relative min-h-dvh overflow-hidden">
    <!-- ==== 沉浸式背景层 ==== -->
    <div class="fixed inset-0 z-0 pointer-events-none">
      <!-- 动态渐变背景 - 根据游戏阶段变化 -->
      <div 
        class="absolute inset-0 transition-all duration-[3000ms] ease-in-out"
        :class="[
          room.gamePublic?.phase === 'night' 
            ? 'bg-gradient-to-b from-[#030508] via-[#0a1628] to-[#0d1f3c]' 
            : room.gamePublic?.phase?.includes('day') 
              ? 'bg-gradient-to-b from-[#1a2a4a] via-[#0d1628] to-[#0a1020]'
              : 'bg-gradient-to-b from-[#0a0f18] via-[#0d1526] to-[#0a0f1a]'
        ]"
      ></div>
      
      <!-- 月亮/太阳 - 动态变化 - 移至右下角防止遮挡顶部文字 -->
      <div 
        class="moon-sun absolute transition-all duration-[3000ms] ease-in-out pointer-events-none"
        :class="[
          room.gamePublic?.phase === 'night' 
            ? 'right-[5%] bottom-[20%] opacity-20 scale-150 blur-sm' 
            : 'right-[5%] top-[10%] opacity-40 scale-75'
        ]"
      >
        <div 
          class="relative h-28 w-28 rounded-full transition-all duration-[3000ms]"
          :class="[
            room.gamePublic?.phase === 'night'
              ? 'bg-gradient-to-br from-amber-100 via-amber-50 to-amber-200 shadow-[0_0_100px_30px_rgba(251,191,36,0.25)]'
              : 'bg-gradient-to-br from-orange-200 via-yellow-100 to-amber-100 shadow-[0_0_80px_20px_rgba(251,191,36,0.3)]'
          ]"
        >
          <!-- 月球陨石坑 -->
          <div v-if="room.gamePublic?.phase === 'night'" class="absolute inset-0">
            <div class="absolute right-3 top-4 h-5 w-5 rounded-full bg-amber-200/50"></div>
            <div class="absolute right-8 top-10 h-3 w-3 rounded-full bg-amber-200/40"></div>
            <div class="absolute left-4 top-12 h-4 w-4 rounded-full bg-amber-200/30"></div>
            <div class="absolute left-8 bottom-6 h-2.5 w-2.5 rounded-full bg-amber-200/35"></div>
          </div>
        </div>
      </div>
      
      <!-- 星空 - 夜晚增强 -->
      <div class="stars-layer absolute inset-0 overflow-hidden" :class="room.gamePublic?.phase === 'night' ? 'opacity-100' : 'opacity-30'">
        <div class="star star-lg absolute left-[8%] top-[12%]"></div>
        <div class="star star-sm absolute left-[15%] top-[25%]"></div>
        <div class="star star-md absolute left-[22%] top-[8%]"></div>
        <div class="star star-sm absolute left-[35%] top-[18%]"></div>
        <div class="star star-lg absolute left-[45%] top-[5%]"></div>
        <div class="star star-sm absolute left-[55%] top-[22%]"></div>
        <div class="star star-md absolute left-[65%] top-[10%]"></div>
        <div class="star star-sm absolute left-[75%] top-[28%]"></div>
        <div class="star star-lg absolute left-[88%] top-[15%]"></div>
        <div class="star star-sm absolute left-[5%] top-[35%]"></div>
        <div class="star star-md absolute left-[92%] top-[35%]"></div>
        <div class="star star-sm absolute left-[30%] top-[32%]"></div>
        <div class="star star-lg absolute left-[50%] top-[28%]"></div>
        <div class="star star-sm absolute left-[70%] top-[35%]"></div>
      </div>
      
      <!-- 神秘光晕效果 -->
      <div class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-[600px] w-[600px] rounded-full bg-gradient-radial from-violet-600/5 via-transparent to-transparent blur-3xl"></div>
      
      <!-- 底部迷雾 -->
      <div class="absolute bottom-0 left-0 right-0 h-48 bg-gradient-to-t from-[#0a1020]/90 via-[#0a1020]/40 to-transparent"></div>
      
      <!-- 森林剪影 -->
      <div class="absolute bottom-0 left-0 right-0 h-24 opacity-60">
        <svg viewBox="0 0 1440 120" class="absolute bottom-0 h-full w-full" preserveAspectRatio="none">
          <path d="M0,120 L0,80 Q30,60 60,80 L80,50 Q100,30 120,50 L140,70 Q160,50 180,70 L200,40 Q220,20 240,40 L260,60 Q280,40 300,60 L320,45 Q340,25 360,45 L380,75 Q400,55 420,75 L440,35 Q460,15 480,35 L500,65 Q520,45 540,65 L560,50 Q580,30 600,50 L620,80 Q640,60 660,80 L680,55 Q700,35 720,55 L740,70 Q760,50 780,70 L800,40 Q820,20 840,40 L860,75 Q880,55 900,75 L920,50 Q940,30 960,50 L980,65 Q1000,45 1020,65 L1040,80 Q1060,60 1080,80 L1100,45 Q1120,25 1140,45 L1160,70 Q1180,50 1200,70 L1220,55 Q1240,35 1260,55 L1280,75 Q1300,55 1320,75 L1340,60 Q1360,40 1380,60 L1400,80 Q1420,60 1440,80 L1440,120 Z" fill="#05080f"/>
        </svg>
      </div>
      
      <!-- 漂浮粒子 -->
      <div class="particles-layer absolute inset-0 overflow-hidden">
        <div class="particle-float absolute left-[15%] top-[45%] h-2 w-2 rounded-full bg-violet-400/20"></div>
        <div class="particle-float absolute left-[35%] top-[60%] h-1.5 w-1.5 rounded-full bg-blue-400/15"></div>
        <div class="particle-float absolute left-[55%] top-[40%] h-2 w-2 rounded-full bg-amber-400/15"></div>
        <div class="particle-float absolute left-[75%] top-[55%] h-1.5 w-1.5 rounded-full bg-emerald-400/15"></div>
        <div class="particle-float absolute left-[25%] top-[70%] h-1 w-1 rounded-full bg-pink-400/20"></div>
        <div class="particle-float absolute left-[85%] top-[35%] h-1.5 w-1.5 rounded-full bg-cyan-400/15"></div>
      </div>
    </div>

    <!-- ==== 顶部状态栏 ==== -->
    <header class="fixed top-0 left-0 right-0 z-40">
      <div class="relative border-b border-white/10 bg-gradient-to-b from-[#0a0f1a]/95 to-[#0a0f1a]/80 backdrop-blur-xl">
        <!-- 发光边框效果 -->
        <div class="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-violet-500/50 to-transparent"></div>
        
        <div class="mx-auto max-w-lg px-4 py-3">
          <div class="flex items-center justify-between">
            <!-- 左侧: 房间信息 -->
            <div class="flex items-center gap-3">
              <div class="relative">
                <div class="h-10 w-10 rounded-xl bg-gradient-to-br from-red-600 to-orange-500 flex items-center justify-center shadow-lg shadow-red-500/20">
                  <span class="text-xl">🐺</span>
                </div>
                <div class="absolute -bottom-1 -right-1 h-3 w-3 rounded-full border-2 border-[#0a0f1a]" :class="connected ? 'bg-emerald-400' : 'bg-red-400'"></div>
              </div>
              <div>
                <div class="text-sm font-bold text-white">{{ room.roomState?.name || '狼人杀' }}</div>
                <div class="flex items-center gap-1.5 text-xs text-white/50">
                  <span :class="room.gamePublic?.phase === 'night' ? 'text-violet-400' : 'text-amber-400'">{{ phaseLabel }}</span>
                </div>
              </div>
            </div>
            
            <!-- 右侧: 操作按钮 -->
            <button 
              class="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/70 backdrop-blur transition-all hover:bg-white/10 hover:border-white/20"
              @click="leaveRoom"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
              </svg>
              退出
            </button>
          </div>
        </div>
      </div>
    </header>

    <!-- ==== 主内容区 ==== -->
    <main class="relative z-10 pt-20 pb-32">
      <div class="mx-auto max-w-lg px-4">
        
        <!-- 游戏计时器 - 震撼设计 -->
        <div v-if="room.gamePublic && room.gamePublic.phase !== 'game_over'" class="relative mb-6 overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-[#1a233b]/80 to-[#0d1526]/80 backdrop-blur-xl shadow-2xl">
          <!-- 发光边框 -->
          <div class="absolute inset-0 rounded-2xl ring-1 ring-inset" :class="isTimeLow ? 'ring-red-500/30' : 'ring-violet-500/20'"></div>
          
          <div class="relative p-6">
            <div class="flex items-center justify-between">
              <!-- 左侧: 阶段信息 -->
              <div>
                <div class="flex items-center gap-2 text-xs font-medium uppercase tracking-wider">
                  <span class="h-2.5 w-2.5 rounded-full animate-pulse" :class="room.gamePublic?.phase === 'night' ? 'bg-violet-400 shadow-lg shadow-violet-400/50' : 'bg-amber-400 shadow-lg shadow-amber-400/50'"></span>
                  <span class="text-white/60">{{ phaseLabel }}</span>
                </div>
                <div class="mt-2 text-3xl font-bold tracking-tight text-white">
                  {{ room.gamePublic?.phase === 'night' ? '夜幕降临' : room.gamePublic?.phase?.includes('vote') ? '公正投票' : '阳光普照' }}
                </div>
                <div class="mt-1 text-sm text-white/40">
                  {{ room.gamePublic?.phase === 'night' ? '狼人请睁眼...' : '请各位玩家发言' }}
                </div>
              </div>
              
              <!-- 右侧: 倒计时 -->
              <div class="relative">
                <!-- 外圈发光 -->
                <div 
                  class="absolute inset-0 rounded-full blur-xl transition-all duration-300"
                  :class="isTimeLow ? 'bg-red-500/30' : 'bg-violet-500/20'"
                ></div>
                <div 
                  class="relative flex h-24 w-24 items-center justify-center rounded-full border-4 transition-all duration-300"
                  :class="[
                    isTimeLow 
                      ? 'border-red-500/60 bg-gradient-to-br from-red-950/50 to-red-900/30 scale-105' 
                      : 'border-violet-500/40 bg-gradient-to-br from-violet-950/50 to-violet-900/30'
                  ]"
                >
                  <div class="text-center">
                    <span 
                      class="text-4xl font-black tabular-nums"
                      :class="isTimeLow ? 'text-red-400' : 'text-violet-400'"
                    >
                      {{ Math.max(0, secondsLeft) }}
                    </span>
                    <div class="text-[10px] text-white/40 uppercase">秒</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          
          <!-- 底部进度条 -->
          <div class="absolute bottom-0 left-0 right-0 h-1.5 bg-white/5">
            <div 
              class="h-full transition-all duration-1000 ease-linear"
              :style="{ width: `${timerProgress}%` }"
              :class="isTimeLow ? 'bg-gradient-to-r from-red-600 via-red-500 to-orange-500' : 'bg-gradient-to-r from-violet-600 via-violet-500 to-purple-500'"
            ></div>
          </div>
        </div>

      <div v-if="room.toasts.length" class="mb-3 space-y-2">
        <div
          v-for="t in room.toasts"
          :key="t.id"
          class="rounded-lg border px-3 py-2 text-xs"
          :class="t.type === 'error' ? 'border-red-500/30 bg-red-500/10 text-red-200' : 'border-white/10 bg-white/5 text-white/80'"
        >
          {{ t.message }}
        </div>
      </div>

      <div v-if="!room.roomState" class="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-white/70">
        正在进入房间…
      </div>

      <template v-else>
          <!-- ==== 玩家座位区 ==== -->
          <div class="player-arena mb-4">
            <!-- 上排玩家 -->
            <div class="flex justify-center flex-wrap gap-1 mb-2">
              <div
                v-for="m in sortedMembers"
                :key="m.seat"
                class="player-card"
                :class="{
                  'player-card--empty': !m.user,
                  'player-card--dead': m.user && !m.isAlive,
                  'player-card--speaking': room.gamePublic?.activeSpeakerSeat === m.seat,
                  'player-card--me': room.gamePrivate?.seat === m.seat
                }"
              >
                <!-- 发言光效 -->
                <div v-if="room.gamePublic?.activeSpeakerSeat === m.seat" class="speaking-glow"></div>
                
                <!-- 头像区域 -->
                <div class="player-avatar-wrapper">
                  <div class="player-seat-badge">{{ m.seat }}</div>
                  <div class="player-avatar-inner">
                    <span v-if="m.user">{{ m.user.nickname?.slice(0, 1).toUpperCase() }}</span>
                    <span v-else class="text-white/20 text-sm">?</span>
                  </div>
                  <!-- 准备状态 -->
                  <div v-if="m.isReady && room.roomState?.status === 'waiting'" class="ready-badge">
                    <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>
                  </div>
                  <!-- 警长徽章 -->
                  <div v-if="room.gamePublic?.sheriffSeat === m.seat" class="sheriff-badge">警</div>
                  <!-- 死亡标记 -->
                  <div v-if="m.user && !m.isAlive" class="death-mark">
                    <svg class="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12"/></svg>
                  </div>
                </div>
                <!-- 玩家名称 -->
                <div class="player-name">
                  <span v-if="m.user">{{ m.user.nickname }}</span>
                  <span v-else>空位</span>
                </div>
                <div v-if="(m as any).isBot" class="bot-tag">BOT</div>
              </div>
            </div>
          </div>

          <!-- ==== 我的身份卡 ==== -->
          <div class="identity-card mb-4">
            <div class="identity-card-header">
              <div class="flex items-center gap-3">
                <div class="identity-icon" :class="getRoleClass(room.gamePrivate?.role)">
                  {{ getRoleIcon(room.gamePrivate?.role) }}
                </div>
                <div>
                  <div class="text-xs text-white/50 uppercase tracking-wider">我的身份</div>
                  <div class="text-xl font-bold text-white">{{ myRoleLabel }}</div>
                </div>
              </div>
            </div>
            <div class="identity-card-body">
              <p v-if="room.gamePrivate?.role === 'werewolf'" class="text-red-300/80">你是狼人。每晚与同伴商议并选择击杀目标。白天请隐藏身份。</p>
              <p v-else-if="room.gamePrivate?.role === 'seer'" class="text-violet-300/80">你是预言家。每晚可以查验一人的身份（好人/狼人）。</p>
              <p v-else-if="room.gamePrivate?.role === 'witch'" class="text-emerald-300/80">你是女巫。拥有一瓶解药和一瓶毒药，每种可用一次。</p>
              <p v-else-if="room.gamePrivate?.role === 'guard'" class="text-blue-300/80">你是守卫。每晚守护一人免受狼人袭击，不可连续守同一人。</p>
              <p v-else-if="room.gamePrivate?.role === 'hunter'" class="text-orange-300/80">你是猎人。死后可开枪带走一人（被毒死除外）。</p>
              <p v-else-if="room.gamePrivate?.role === 'villager'" class="text-amber-300/80">你是村民。白天根据线索参与讨论和投票。</p>
              <p v-else class="text-white/40">等待游戏开始分配身份...</p>
            </div>
          </div>

          <!-- ==== 游戏日志 ==== -->
          <div class="game-log-card mb-4">
            <div class="game-log-header">
              <span class="text-sm font-medium">局势记录</span>
              <span class="text-xs text-white/40">第 {{ room.gamePublic?.dayNo ?? 0 }} 天</span>
            </div>
            <div class="game-log-body">
              <div v-if="room.gamePublic?.publicLog?.length" class="space-y-1.5">
                <div v-for="log in room.gamePublic.publicLog.slice(-5)" :key="log.id" class="log-entry">
                  <span class="log-time">{{ new Date(log.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</span>
                  <span class="log-text">{{ log.text }}</span>
                </div>
              </div>
              <div v-else class="text-center text-white/30 text-sm py-4">暂无记录</div>
            </div>
          </div>

          <!-- ==== 聊天区域 ==== -->
          <div class="chat-card mb-4">
            <div class="chat-header">
              <span class="text-sm font-medium">发言频道</span>
              <div class="chat-channel-switch">
                <button @click="chatChannel='public'" class="channel-btn" :class="{ 'channel-btn--active': chatChannel === 'public' }">公开</button>
                <button @click="chatChannel='wolf'" class="channel-btn channel-btn--wolf" :class="{ 'channel-btn--active': chatChannel === 'wolf' }">狼队</button>
              </div>
            </div>
            <div class="chat-messages">
              <div v-for="m in room.chat" :key="m.id" class="chat-msg" :class="{ 'chat-msg--wolf': (m as any).channel === 'wolf' }">
                <span class="chat-sender">{{ m.sender.nickname }}:</span>
                <span class="chat-text">{{ m.text }}</span>
              </div>
              <div v-if="!room.chat.length" class="text-center text-white/30 text-sm py-6">暂无消息</div>
            </div>
            <div class="chat-input-area">
              <input 
                v-model="chatText"
                class="chat-input"
                :placeholder="chatChannel === 'wolf' ? '狼队密语...' : '发送消息...'"
                @keyup.enter="sendChat"
              />
              <button class="chat-send-btn" @click="sendChat">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg>
              </button>
            </div>
          </div>


        <div v-if="room.roomState.status === 'waiting'" class="mt-4 space-y-4">
          <!-- 房主配置面板 -->
          <div v-if="isOwner" class="game-card overflow-hidden">
            <div class="game-card-header flex items-center gap-2">
              <span class="text-base">设置</span>
              <span class="text-sm font-bold text-white">房主配置</span>
            </div>
            <div class="space-y-4 p-4">
              <!-- 身份配置 -->
              <div>
                <div class="mb-2 flex items-center gap-2 text-xs">
                  <span class="text-red-400">身份配置</span>
                  <span class="text-white/40">（剩余自动补足为村民）</span>
                </div>
                <div class="grid grid-cols-2 gap-2">
                  <div class="role-config-item">
                    <div class="flex items-center gap-2">
                      <span class="text-lg">🐺</span>
                      <span class="text-xs text-white/80">狼人</span>
                    </div>
                    <input v-model.number="localRoleConfig.werewolf" type="number" min="1" max="5" class="game-input-small" />
                  </div>
                  <div class="role-config-item">
                    <div class="flex items-center gap-2">
                      <span class="text-lg">🔮</span>
                      <span class="text-xs text-white/80">预言家</span>
                    </div>
                    <input v-model.number="localRoleConfig.seer" type="number" min="0" max="1" class="game-input-small" />
                  </div>
                  <div class="role-config-item">
                    <div class="flex items-center gap-2">
                      <span class="text-lg">🧙</span>
                      <span class="text-xs text-white/80">女巫</span>
                    </div>
                    <input v-model.number="localRoleConfig.witch" type="number" min="0" max="1" class="game-input-small" />
                  </div>
                  <div class="role-config-item">
                    <div class="flex items-center gap-2">
                      <span class="text-lg">🏹</span>
                      <span class="text-xs text-white/80">猎人</span>
                    </div>
                    <input v-model.number="localRoleConfig.hunter" type="number" min="0" max="1" class="game-input-small" />
                  </div>
                  <div class="role-config-item">
                    <div class="flex items-center gap-2">
                      <span class="text-lg">🛡</span>
                      <span class="text-xs text-white/80">守卫</span>
                    </div>
                    <input v-model.number="localRoleConfig.guard" type="number" min="0" max="1" class="game-input-small" />
                  </div>
                </div>
              </div>

              <!-- 计时配置 -->
              <div>
                <div class="mb-2 flex items-center gap-2 text-xs">
                  <span class="text-blue-400">计时配置</span>
                  <span class="text-white/40">（秒）</span>
                </div>
                <div class="grid grid-cols-2 gap-2">
                  <div class="role-config-item">
                    <div class="flex items-center gap-2">
                      <span class="text-lg">🌙</span>
                      <span class="text-xs text-white/80">夜晚</span>
                    </div>
                    <input v-model.number="localTimers.nightSeconds" type="number" min="10" max="180" class="game-input-small" />
                  </div>
                  <div class="role-config-item">
                    <div class="flex items-center gap-2">
                      <span class="text-lg">💬</span>
                      <span class="text-xs text-white/80">发言</span>
                    </div>
                    <input v-model.number="localTimers.daySpeechSeconds" type="number" min="10" max="300" class="game-input-small" />
                  </div>
                  <div class="role-config-item">
                    <div class="flex items-center gap-2">
                      <span class="text-lg">🗳</span>
                      <span class="text-xs text-white/80">投票</span>
                    </div>
                    <input v-model.number="localTimers.dayVoteSeconds" type="number" min="10" max="180" class="game-input-small" />
                  </div>
                  <div class="role-config-item">
                    <div class="flex items-center gap-2">
                      <span class="text-lg">⚖</span>
                      <span class="text-xs text-white/80">结算</span>
                    </div>
                    <input v-model.number="localTimers.settlementSeconds" type="number" min="5" max="120" class="game-input-small" />
                  </div>
                </div>
              </div>

              <button class="game-btn-action w-full" @click="emitConfig">
                保存配置
              </button>

              <button v-if="room.roomState.members.some(m => !m.user)" class="w-full rounded-lg border border-emerald-500/30 bg-emerald-600/10 px-4 py-2.5 text-sm text-emerald-300 transition-all hover:bg-emerald-600/20" @click="addBot">
                添加机器人
              </button>
            </div>
          </div>

          <!-- 底部操作栏 - 等待状态 -->
          <div class="bottom-action-bar">
            <div class="mx-auto flex max-w-md gap-3">
              <button
                class="flex-1 rounded-xl border border-white/20 bg-white/5 px-4 py-3.5 text-sm font-medium text-white transition-all duration-300 hover:bg-white/10 hover:border-white/30"
                @click="setReady(true)"
              >
                准备
              </button>
              <button
                v-if="isOwner"
                class="game-btn-primary flex-1"
                @click="startGame"
              >
                开始游戏
              </button>
            </div>
          </div>
        </div>

        <div v-else class="mt-3 space-y-3">
          <div class="fixed inset-x-0 bottom-0 border-t border-white/10 bg-[#0b1020]/95 px-4 py-3 backdrop-blur z-50">
            <div class="mx-auto max-w-md">
              <div class="mb-2 flex items-center justify-between">
                <div class="text-xs text-white/60">当前阶段：{{ phaseLabel }}</div>
                <div v-if="room.gamePublic?.phase === 'night' && activeRoleLabel" class="text-xs font-bold text-violet-400 animate-pulse">
                  当前行动：{{ activeRoleLabel }}
                </div>
              </div>

              <!-- ===== 夜晚行动区 ===== -->
              <div v-if="room.gamePublic?.phase === 'night'">
                <!-- 狼人 -->
                <div v-if="room.gamePrivate?.role === 'werewolf' && room.gamePublic?.activeRole === 'werewolf'" class="grid grid-cols-4 gap-2">
                  <button
                    v-for="s in aliveSeats.filter(x => x !== meSeat)"
                    :key="`w-${s}`"
                    class="rounded-lg border px-2 py-3 text-sm transition-all duration-200"
                    :class="[
                       room.gamePrivate?.selectedTargetSeat === s 
                         ? 'border-red-500 bg-red-500/30 text-white shadow-lg scale-105' 
                         : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/10'
                    ]"
                    @click="submitAction('night.wolfKill', { targetSeat: s })"
                  >
                    {{ s }}号
                  </button>
                </div>

                <!-- 预言家 -->
                <div v-if="room.gamePrivate?.role === 'seer' && room.gamePublic?.activeRole === 'seer'" class="space-y-3">
                   <div v-if="latestSeerInfo" class="rounded-lg border border-violet-500/30 bg-violet-500/20 p-3 text-center text-sm font-bold text-violet-200 shadow-[0_0_15px_rgba(139,92,246,0.2)]">
                     {{ latestSeerInfo }}
                   </div>
                   <div v-if="!room.gamePrivate?.selectedTargetSeat" class="grid grid-cols-4 gap-2">
                      <button
                        v-for="s in aliveSeats.filter(x => x !== meSeat)"
                        :key="`s-${s}`"
                        class="rounded-lg border border-white/10 bg-white/5 px-2 py-3 text-sm text-white/70 hover:bg-white/10"
                        @click="submitAction('night.seerCheck', { targetSeat: s })"
                      >
                        查验 {{ s }}
                      </button>
                   </div>
                   <div v-else class="text-center text-sm text-white/50">
                     已选择目标，请等待...
                   </div>
                </div>

                <!-- 女巫 -->
                <template v-if="room.gamePrivate?.role === 'witch' && room.gamePublic?.activeRole === 'witch'">
                  <!-- 阶段1：解药 -->
                  <div v-if="witchActionStep === 'save'" class="space-y-3">
                     <div v-if="room.gamePrivate.witchInfo?.nightVictimSeat" class="rounded-lg border border-red-500/30 bg-red-500/20 p-3 text-center text-sm font-bold text-red-200">
                        昨晚 {{ room.gamePrivate.witchInfo.nightVictimSeat }} 号倒牌
                     </div>
                     <div v-else class="text-center text-sm text-white/60 py-2">
                        昨晚平安夜（或无法获知）
                     </div>

                     <div class="grid grid-cols-2 gap-3" v-if="room.gamePrivate.witchInfo?.nightVictimSeat && !room.gamePrivate.witchInfo?.saveUsed">
                        <button class="game-btn-action bg-emerald-600/20 text-emerald-400 border-emerald-500/50" @click="submitAction('night.witch.save', { use: true }); witchActionStep = 'poison'">
                          使用解药
                        </button>
                        <button class="game-btn-secondary" @click="submitAction('night.witch.save', { use: false }); witchActionStep = 'poison'">
                          不使用
                        </button>
                     </div>
                     <div v-else class="text-center">
                        <button class="game-btn-secondary w-full" @click="witchActionStep = 'poison'">
                          进入毒药阶段
                        </button>
                     </div>
                  </div>

                  <!-- 阶段2：毒药 -->
                  <div v-else-if="witchActionStep === 'poison'" class="space-y-3">
                     <div class="text-center text-sm text-white/80">是否使用毒药？</div>
                     <div v-if="!room.gamePrivate.witchInfo?.poisonUsed" class="grid grid-cols-4 gap-2">
                        <button
                          v-for="s in aliveSeats.filter(x => x !== meSeat)"
                          :key="`p-${s}`"
                          class="rounded-lg border border-white/10 bg-white/5 px-2 py-3 text-sm text-white/70 hover:bg-violet-500/20 hover:border-violet-500/50"
                          @click="submitAction('night.witch.poison', { targetSeat: s })"
                        >
                          毒 {{ s }}
                        </button>
                     </div>
                     <button class="game-btn-secondary w-full" @click="submitAction('night.witch.poison', { targetSeat: null })">
                       不使用毒药 (结束)
                     </button>
                  </div>
                </template>

                <!-- 守卫 -->
                <div v-if="room.gamePrivate?.role === 'guard' && room.gamePublic?.activeRole === 'guard'" class="grid grid-cols-4 gap-2">
                   <button
                      v-for="s in aliveSeats"
                      :key="`g-${s}`"
                      class="rounded-lg border px-2 py-3 text-sm transition-all duration-200"
                      :class="[
                        room.gamePrivate?.selectedTargetSeat === s 
                          ? 'border-blue-500 bg-blue-500/30 text-white shadow-lg scale-105' 
                          : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/10'
                      ]"
                      :disabled="room.gamePrivate?.selectedTargetSeat != null"
                      @click="submitAction('night.guardProtect', { targetSeat: s })"
                   >
                     守 {{ s }}
                   </button>
                   <button
                     class="col-span-4 game-btn-secondary"
                     :disabled="room.gamePrivate?.selectedTargetSeat != null"
                     @click="submitAction('night.guardProtect', { targetSeat: 0 })"
                   >
                     空守
                   </button>
                </div>
              </div>

              <!-- ===== 白天投票区 ===== -->
              <div v-else-if="room.gamePublic?.phase === 'day_vote'" class="grid grid-cols-4 gap-2">
                <button
                  v-for="s in aliveSeats.filter(x => x !== meSeat)"
                  :key="`v-${s}`"
                  class="rounded-lg border px-2 py-3 text-sm transition-all duration-200"
                  :class="[
                    room.gamePrivate?.selectedTargetSeat === s 
                      ? 'border-violet-500 bg-violet-500/30 text-white shadow-lg scale-105' 
                      : room.gamePrivate?.selectedTargetSeat !== undefined
                        ? 'border-white/5 bg-white/5 text-white/20'
                        : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/10'
                  ]"
                  :disabled="room.gamePrivate?.selectedTargetSeat !== undefined"
                  @click="submitAction('day.vote', { targetSeat: s })"
                >
                  投{{ s }}
                </button>
                <button
                  class="col-span-4 game-btn-secondary"
                  :disabled="room.gamePrivate?.selectedTargetSeat !== undefined"
                  @click="submitAction('day.vote', { targetSeat: null })"
                >
                  弃票
                </button>
              </div>

              <!-- ===== 竞选警长 ===== -->
              <div v-else-if="room.gamePublic?.phase === 'sheriff_election'" class="flex flex-col gap-2">
                <button class="game-btn-primary" @click="submitAction('sheriff.enroll', {})">
                  我要上警
                </button>
                <button class="game-btn-secondary" @click="submitAction('sheriff.quit', {})">
                  放弃
                </button>
              </div>

              <!-- ===== 发言阶段 ===== -->
              <div v-else-if="['sheriff_speech', 'day_speech'].includes(room.gamePublic?.phase || '')" class="flex flex-col items-center justify-center py-2">
                <div v-if="room.gamePublic?.activeSpeakerSeat === meSeat" class="w-full space-y-3">
                  <div class="text-center text-sm font-medium text-violet-400 animate-pulse">正在发言...</div>
                  <button class="game-btn-primary w-full" @click="submitAction('game.nextSpeaker', {})">
                    结束发言
                  </button>
                </div>
                <div v-else class="text-center">
                  <div class="text-sm font-medium text-white/60">正在倾听 {{ room.gamePublic?.activeSpeakerSeat }} 号玩家发言</div>
                </div>
              </div>
              
              <!-- ===== 警长投票 ===== -->
              <div v-else-if="room.gamePublic?.phase === 'sheriff_vote'" class="grid grid-cols-4 gap-2">
                 <button
                    v-for="s in room.gamePublic?.players?.filter(p => p.isAlive) || []"
                    :key="`sv-${s.seat}`"
                    class="rounded-lg border px-2 py-3 text-sm border-white/10 bg-white/5 text-white/70 hover:bg-white/10"
                    @click="submitAction('sheriff.vote', { targetSeat: s.seat })"
                  >
                    投 {{ s.seat }}
                  </button>
                  <button class="col-span-4 game-btn-secondary" @click="submitAction('sheriff.vote', { targetSeat: null })">
                    弃权
                  </button>
              </div>

               <!-- ===== 猎人/结算 ===== -->
              <div v-else-if="room.gamePublic?.phase === 'settlement'" class="grid grid-cols-2 gap-2">
                <template v-if="room.gamePrivate?.actions?.hunterShoot">
                  <div class="col-span-2 text-center text-orange-400 font-bold mb-2">你是猎人，请选择带走目标</div>
                  <button
                    v-for="s in aliveSeats.filter(x => x !== meSeat)"
                    :key="`h-${s}`"
                    class="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-3 text-sm text-red-200"
                    @click="submitAction('settlement.hunterShoot', { targetSeat: s })"
                  >
                    带走 {{ s }}
                  </button>
                  <button class="col-span-2 game-btn-secondary" @click="submitAction('settlement.hunterShoot', { targetSeat: null })">
                    不开枪
                  </button>
                </template>
                <div v-else class="col-span-2 text-center text-white/50 py-2">
                  等待结算…
                </div>
              </div>

              <div v-else class="text-center text-white/40 text-xs py-2">
                (观察阶段)
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
    </main>

    <!-- 机器人确认弹窗 -->
    <div v-if="showBotConfirm" class="fixed inset-0 z-50 flex items-center justify-center">
      <!-- 遮罩 -->
      <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" @click="cancelBotConfirm"></div>
      
      <!-- 弹窗内容 -->
      <div class="relative w-[320px] rounded-2xl border border-white/20 bg-gradient-to-b from-[#1a233b] to-[#0b1020] p-6 shadow-2xl">
        <div class="mb-4 text-center">
          <div class="text-lg font-bold text-white">人数不足</div>
          <div class="mt-2 text-sm text-white/60">
            当前还需要 <span class="text-violet-400 font-bold">{{ neededBots }}</span> 名玩家
          </div>
        </div>
        
        <div class="mb-6 rounded-lg border border-white/10 bg-white/5 p-4 text-center">
          <div class="text-sm text-white/70">是否添加机器人玩家？</div>
        </div>
        
        <div class="flex gap-3">
          <button
            class="flex-1 rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/70 transition-all hover:bg-white/10"
            :disabled="addingBots"
            @click="cancelBotConfirm"
          >
            取消
          </button>
          <button
            class="flex-1 rounded-lg bg-gradient-to-r from-violet-600 to-violet-500 px-4 py-3 text-sm font-bold text-white shadow-lg transition-all hover:shadow-violet-500/30 disabled:opacity-50"
            :disabled="addingBots"
            @click="confirmAddBots"
          >
            {{ addingBots ? '添加中...' : '确认添加' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 游戏风格按钮 */
.game-btn-primary {
  @apply relative overflow-hidden rounded-xl bg-gradient-to-r from-red-600 via-red-500 to-orange-500 
         px-6 py-3 font-bold text-white shadow-lg transition-all duration-300
         hover:shadow-red-500/40 hover:scale-105
         disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100;
}

.game-btn-secondary {
  @apply rounded-xl border border-white/20 bg-white/5 text-white/80 
         backdrop-blur-sm transition-all duration-300
         hover:bg-white/10 hover:border-white/30;
}

.game-btn-action {
  @apply rounded-lg border border-violet-500/30 bg-violet-500/10 px-4 py-2.5
         text-sm font-medium text-violet-300 transition-all duration-300
         hover:bg-violet-500/20 hover:border-violet-500/50 hover:shadow-lg hover:shadow-violet-500/10;
}

/* 游戏风格卡片 */
.game-card {
  @apply rounded-2xl border border-white/10 bg-gradient-to-br from-[#1a233b]/90 to-[#0d1526]/90
         backdrop-blur-lg shadow-xl;
}

.game-card-header {
  @apply border-b border-white/10 bg-white/5 px-4 py-3;
}

/* ===== 星星样式 ===== */
.star {
  position: relative;
  background: white;
  border-radius: 50%;
}

.star::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 200%;
  height: 200%;
  background: radial-gradient(circle, rgba(255,255,255,0.3) 0%, transparent 70%);
  border-radius: 50%;
}

.star-sm { width: 2px; height: 2px; }
.star-md { width: 3px; height: 3px; }
.star-lg { width: 4px; height: 4px; }

.star { animation: starTwinkle 3s ease-in-out infinite; }
.star:nth-child(1) { animation-delay: 0s; }
.star:nth-child(2) { animation-delay: 0.3s; }
.star:nth-child(3) { animation-delay: 0.7s; }
.star:nth-child(4) { animation-delay: 1.1s; }
.star:nth-child(5) { animation-delay: 0.5s; }
.star:nth-child(6) { animation-delay: 1.5s; }
.star:nth-child(7) { animation-delay: 0.9s; }
.star:nth-child(8) { animation-delay: 2s; }
.star:nth-child(9) { animation-delay: 0.2s; }
.star:nth-child(10) { animation-delay: 1.3s; }
.star:nth-child(11) { animation-delay: 0.6s; }
.star:nth-child(12) { animation-delay: 1.8s; }
.star:nth-child(13) { animation-delay: 0.4s; }
.star:nth-child(14) { animation-delay: 1.0s; }

@keyframes starTwinkle {
  0%, 100% { opacity: 0.3; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.5); }
}

/* ===== 粒子浮动动画 ===== */
.particle-float {
  animation: particleFloat 8s ease-in-out infinite;
}

.particle-float:nth-child(1) { animation-delay: 0s; animation-duration: 10s; }
.particle-float:nth-child(2) { animation-delay: 1.5s; animation-duration: 8s; }
.particle-float:nth-child(3) { animation-delay: 3s; animation-duration: 12s; }
.particle-float:nth-child(4) { animation-delay: 0.5s; animation-duration: 9s; }
.particle-float:nth-child(5) { animation-delay: 2s; animation-duration: 11s; }
.particle-float:nth-child(6) { animation-delay: 4s; animation-duration: 7s; }

@keyframes particleFloat {
  0%, 100% { 
    transform: translateY(0) translateX(0) scale(1); 
    opacity: 0.15;
  }
  25% { 
    transform: translateY(-30px) translateX(15px) scale(1.2); 
    opacity: 0.3;
  }
  50% { 
    transform: translateY(-15px) translateX(-10px) scale(1); 
    opacity: 0.2;
  }
  75% { 
    transform: translateY(-40px) translateX(8px) scale(1.1); 
    opacity: 0.25;
  }
}

/* ===== 游戏按钮样式 ===== */
.game-btn-primary {
  @apply relative overflow-hidden rounded-xl bg-gradient-to-r from-red-600 via-red-500 to-orange-500 
         px-6 py-3.5 font-bold text-white shadow-lg transition-all duration-300
         hover:shadow-red-500/40 hover:scale-[1.02] active:scale-[0.98]
         disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100;
}

.game-btn-primary::before {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
  transition: left 0.5s;
}

.game-btn-primary:hover::before {
  left: 100%;
}

.game-btn-secondary {
  @apply rounded-xl border border-white/20 bg-white/5 text-white/80 
         backdrop-blur-sm transition-all duration-300
         hover:bg-white/10 hover:border-white/30 active:scale-[0.98];
}

.game-btn-action {
  @apply rounded-xl border border-violet-500/30 bg-violet-500/10 px-4 py-3
         text-sm font-medium text-violet-300 transition-all duration-300
         hover:bg-violet-500/20 hover:border-violet-500/50 hover:shadow-lg hover:shadow-violet-500/10;
}

/* ===== 游戏卡片样式 ===== */
.game-card {
  @apply rounded-2xl border border-white/10 bg-gradient-to-br from-[#1a233b]/80 to-[#0d1526]/80
         backdrop-blur-xl shadow-2xl;
}

.game-card-header {
  @apply border-b border-white/10 bg-white/5 px-5 py-4;
}

/* ===== 玩家头像样式 ===== */
.player-avatar {
  @apply relative flex items-center justify-center rounded-full border-2 
         transition-all duration-300 backdrop-blur-sm;
}

.player-avatar.alive {
  @apply border-white/20 bg-gradient-to-br from-white/15 to-white/5 shadow-lg;
}

.player-avatar.dead {
  @apply border-white/5 bg-black/40 grayscale opacity-50;
}

.player-avatar.speaking {
  @apply ring-4 ring-violet-500/50 scale-110 z-10 border-violet-400;
  animation: speakingPulse 1.5s ease-in-out infinite;
}

@keyframes speakingPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.4); }
  50% { box-shadow: 0 0 20px 5px rgba(139, 92, 246, 0.2); }
}

/* ===== 底部操作栏 ===== */
.bottom-action-bar {
  @apply fixed bottom-0 left-0 right-0 z-50 border-t border-white/10 
         bg-gradient-to-t from-[#0a0f1a] via-[#0a0f1a]/95 to-[#0a0f1a]/90
         px-4 py-4 backdrop-blur-xl;
}

/* ===== 输入框样式 ===== */
.game-input {
  @apply w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3.5
         text-sm text-white placeholder-white/30 outline-none
         transition-all duration-300
         focus:border-violet-500/50 focus:bg-white/10 focus:ring-2 focus:ring-violet-500/20;
}

.game-input-small {
  @apply w-16 rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 
         text-center text-sm text-white outline-none
         transition-all duration-300
         focus:border-violet-500/50 focus:bg-black/40;
}

/* ===== 角色配置项 ===== */
.role-config-item {
  @apply flex items-center justify-between rounded-xl border border-white/10 
         bg-gradient-to-r from-white/5 to-transparent p-3.5 transition-all duration-300
         hover:border-white/20 hover:from-white/10;
}

/* ===== 聊天消息 ===== */
.chat-message {
  @apply rounded-xl bg-white/5 px-4 py-2.5 text-sm text-white/80;
}

.chat-message.wolf {
  @apply border-l-4 border-red-500 bg-red-500/10 text-red-200;
}

/* ===== 渐变径向背景 ===== */
.bg-gradient-radial {
  background: radial-gradient(circle, var(--tw-gradient-stops));
}

/* ===== 玩家卡片专业样式 ===== */
.player-arena {
  perspective: 1000px;
}

.player-card {
  @apply relative flex flex-col items-center p-2 rounded-xl
         transition-all duration-300 cursor-pointer;
  min-width: 64px;
}

.player-card:hover {
  transform: translateY(-4px);
}

.player-card--empty {
  opacity: 0.4;
}

.player-card--dead {
  filter: grayscale(1);
  opacity: 0.5;
}

.player-card--speaking {
  z-index: 10;
}

.player-card--me {
  @apply ring-2 ring-emerald-500/50 bg-emerald-500/5 rounded-xl;
}

.speaking-glow {
  @apply absolute inset-0 rounded-xl;
  background: radial-gradient(circle, rgba(139, 92, 246, 0.3) 0%, transparent 70%);
  animation: speakingGlow 1.5s ease-in-out infinite;
}

@keyframes speakingGlow {
  0%, 100% { opacity: 0.5; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.1); }
}

.player-avatar-wrapper {
  @apply relative;
}

.player-avatar-inner {
  @apply w-12 h-12 rounded-full flex items-center justify-center
         bg-gradient-to-br from-slate-700 to-slate-900
         border-2 border-white/20 shadow-lg
         text-white font-bold text-lg;
}

.player-card--speaking .player-avatar-inner {
  @apply border-violet-400 shadow-violet-500/30;
  animation: avatarPulse 1.5s ease-in-out infinite;
}

@keyframes avatarPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.4); }
  50% { box-shadow: 0 0 20px 8px rgba(139, 92, 246, 0.2); }
}

.player-seat-badge {
  @apply absolute -top-1 -left-1 w-5 h-5 rounded-full
         bg-gradient-to-br from-blue-500 to-blue-600
         flex items-center justify-center
         text-[10px] font-bold text-white shadow-lg
         border-2 border-[#0a0f1a] z-10;
}

.ready-badge {
  @apply absolute -bottom-1 -right-1 w-5 h-5 rounded-full
         bg-gradient-to-br from-emerald-400 to-emerald-600
         flex items-center justify-center text-white shadow-lg
         border-2 border-[#0a0f1a] z-10;
}

.sheriff-badge {
  @apply absolute -bottom-1 -right-1 w-5 h-5 rounded-full
         bg-gradient-to-br from-amber-400 to-amber-600
         flex items-center justify-center
         text-[10px] font-bold text-black shadow-lg
         border-2 border-[#0a0f1a] z-10;
}

.death-mark {
  @apply absolute inset-0 flex items-center justify-center
         bg-black/50 rounded-full;
}

.player-name {
  @apply mt-1 text-[10px] font-medium text-white/80 truncate max-w-[60px] text-center;
}

.bot-tag {
  @apply text-[8px] text-violet-400/60 font-medium uppercase tracking-wider;
}

/* ===== 身份卡片专业样式 ===== */
.identity-card {
  @apply rounded-2xl overflow-hidden
         border border-white/10
         bg-gradient-to-br from-[#1a233b]/90 to-[#0d1526]/90
         backdrop-blur-xl shadow-2xl;
}

.identity-card-header {
  @apply p-4 border-b border-white/10 bg-white/5;
}

.identity-card-body {
  @apply p-4 text-sm leading-relaxed;
}

.identity-icon {
  @apply w-12 h-12 rounded-xl flex items-center justify-center text-2xl
         shadow-lg transition-all duration-300;
}

.role-werewolf { @apply bg-gradient-to-br from-red-600 to-red-800; }
.role-seer { @apply bg-gradient-to-br from-violet-600 to-violet-800; }
.role-witch { @apply bg-gradient-to-br from-emerald-600 to-emerald-800; }
.role-guard { @apply bg-gradient-to-br from-blue-600 to-blue-800; }
.role-hunter { @apply bg-gradient-to-br from-orange-600 to-orange-800; }
.role-villager { @apply bg-gradient-to-br from-amber-600 to-amber-800; }
.role-unknown { @apply bg-gradient-to-br from-slate-600 to-slate-800; }

/* ===== 游戏日志卡片 ===== */
.game-log-card {
  @apply rounded-2xl overflow-hidden
         border border-white/10
         bg-gradient-to-br from-[#1a233b]/80 to-[#0d1526]/80
         backdrop-blur-xl;
}

.game-log-header {
  @apply flex items-center justify-between p-3 border-b border-white/10 bg-white/5;
}

.game-log-body {
  @apply max-h-32 overflow-y-auto p-3;
}

.log-entry {
  @apply flex items-start gap-2 text-xs;
}

.log-time {
  @apply text-white/30 font-mono;
}

.log-text {
  @apply text-white/60;
}

/* ===== 专业聊天卡片 ===== */
.chat-card {
  @apply rounded-2xl overflow-hidden
         border border-white/10
         bg-gradient-to-br from-[#1a233b]/80 to-[#0d1526]/80
         backdrop-blur-xl flex flex-col;
  height: 220px;
}

.chat-header {
  @apply flex items-center justify-between p-3 border-b border-white/10 bg-white/5;
}

.chat-channel-switch {
  @apply flex gap-1 p-1 rounded-lg bg-black/20;
}

.channel-btn {
  @apply px-3 py-1 rounded-md text-xs font-medium transition-all duration-200;
  color: rgba(255,255,255,0.5);
}

.channel-btn:hover {
  color: rgba(255,255,255,0.8);
}

.channel-btn--active {
  @apply bg-indigo-600 text-white shadow-lg;
  box-shadow: 0 0 10px rgba(99, 102, 241, 0.3);
}

.channel-btn--wolf.channel-btn--active {
  @apply bg-red-600;
  box-shadow: 0 0 10px rgba(239, 68, 68, 0.3);
}

.chat-messages {
  @apply flex-1 overflow-y-auto p-3 space-y-2;
  background: linear-gradient(to bottom, transparent, rgba(0,0,0,0.2));
}

.chat-msg {
  @apply text-xs p-2 rounded-lg bg-white/5;
}

.chat-msg--wolf {
  @apply bg-red-500/10 border-l-2 border-red-500;
}

.chat-sender {
  @apply font-medium text-white/60 mr-1;
}

.chat-msg--wolf .chat-sender {
  @apply text-red-400;
}

.chat-text {
  @apply text-white/80;
}

.chat-msg--wolf .chat-text {
  @apply text-red-200;
}

.chat-input-area {
  @apply flex gap-2 p-3 border-t border-white/10 bg-black/20;
}

.chat-input {
  @apply flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-2
         text-sm text-white placeholder-white/30 outline-none
         transition-all duration-300
         focus:border-violet-500/50 focus:bg-white/10;
}

.chat-send-btn {
  @apply w-10 h-10 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600
         flex items-center justify-center text-white
         transition-all duration-300
         hover:shadow-lg hover:shadow-indigo-500/30 hover:scale-105
         active:scale-95;
}
</style>
