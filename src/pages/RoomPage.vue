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

function startGame() {
  if (!socket.value) return
  socket.value.emit('room:start', { roomId: roomId.value })
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

function speak(text: string) {
  if (!window.speechSynthesis) return
  window.speechSynthesis.cancel() // Stop current
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = 'zh-CN'
  utterance.rate = 1.0
  window.speechSynthesis.speak(utterance)
}

watch(() => room.gamePublic?.phase, (newPhase, oldPhase) => {
  if (!newPhase) return
  if (newPhase === 'night') {
    speak('天黑请闭眼')
    setTimeout(() => {
      const active = room.gamePublic?.activeRole
      if (active) speak(`${roleLabels[active] || active}请睁眼`)
    }, 2000)
  } else if (newPhase === 'day_speech') {
    speak('天亮了，请睁眼')
  } else if (newPhase === 'game_over') {
    speak('游戏结束')
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
  <div class="min-h-dvh px-4 pb-24 pt-3">
    <div class="mx-auto max-w-md">
      <div class="sticky top-0 z-10 -mx-4 mb-3 border-b border-white/10 bg-[#0b1020]/95 px-4 py-3 backdrop-blur">
        <div class="flex items-center justify-between">
          <div>
            <div class="text-base font-semibold">房间</div>
            <div class="mt-1 text-xs text-white/60">{{ phaseLabel }} · {{ connected ? '在线' : '离线' }}</div>
          </div>
          <div class="flex items-center gap-2">
            <button class="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80" @click="router.push('/lobby')">
              退出
            </button>
          </div>
        </div>
      </div>

      <!-- New Prominent Timer -->
      <div v-if="room.gamePublic && room.gamePublic.phase !== 'game_over'" class="relative mb-4 overflow-hidden rounded-xl border border-white/10 bg-white/5 p-4 backdrop-blur-sm">
        <div class="relative z-10 flex items-center justify-between">
          <div>
            <div class="text-xs font-medium text-white/50 uppercase tracking-wider">{{ phaseLabel }}</div>
            <div class="mt-0.5 text-2xl font-bold tracking-tight text-white">剩余时间</div>
          </div>
          <div 
            class="flex h-16 w-16 items-center justify-center rounded-full border-2 transition-all duration-300"
            :class="[
              isTimeLow ? 'border-red-500/50 bg-red-500/10 scale-110 animate-pulse' : 'border-violet-500/30 bg-violet-500/10'
            ]"
          >
            <span 
              class="text-2xl font-black tabular-nums"
              :class="isTimeLow ? 'text-red-400' : 'text-violet-400'"
            >
              {{ Math.max(0, secondsLeft) }}
            </span>
          </div>
        </div>
        <!-- Progress Bar -->
        <div class="absolute bottom-0 left-0 h-1 w-full bg-white/5">
          <div 
            class="h-full transition-all duration-1000 ease-linear"
            :style="{ width: `${timerProgress}%` }"
            :class="isTimeLow ? 'bg-red-500' : 'bg-violet-500'"
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
        <div class="rounded-xl border border-white/10 bg-white/5 p-4">
          <div class="mb-2 flex items-center justify-between">
            <div class="text-sm font-medium">玩家（{{ room.roomState.members.filter(m => !!m.user).length }}/{{ room.roomState.maxPlayers }}）</div>
            <div v-if="room.gamePrivate" class="text-xs text-white/60">你的座位：{{ room.gamePrivate.seat }}</div>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <div
              v-for="m in room.roomState.members.filter(m => !!m.user)"
              :key="m.seat"
              class="relative rounded-lg border px-3 py-2 transition-all duration-300"
              :class="[
                m.isAlive ? 'border-white/10 bg-black/20' : 'border-white/5 bg-black/10 opacity-60',
                room.gamePublic?.activeSpeakerSeat === m.seat ? 'ring-2 ring-violet-500 shadow-[0_0_15px_rgba(139,92,246,0.2)]' : ''
              ]"
            >
              <div v-if="room.gamePublic?.sheriffSeat === m.seat" class="absolute -right-1 -top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-yellow-500 text-[10px] font-bold text-black shadow-lg">
                警
              </div>
              <div v-if="room.gamePublic?.activeSpeakerSeat === m.seat" class="absolute -left-1 -top-1 z-10 flex h-4 w-9 items-center justify-center rounded-sm bg-violet-600 text-[9px] font-bold text-white shadow-sm lowercase">
                SPEAKING
              </div>
              <div class="flex items-center justify-between">
                <div class="text-sm font-medium">
                  {{ m.seat }}号 {{ m.user?.nickname }}
                  <span v-if="(m as any).isBot" class="ml-1 text-[10px] text-violet-400">机器人</span>
                </div>
                <div class="text-[11px]" :class="m.isAlive ? 'text-emerald-300/80' : 'text-white/40'">
                  {{ m.isAlive ? '存活' : '出局' }}
                </div>
              </div>
              <div class="mt-1 text-xs text-white/60">{{ m.isReady ? '已准备' : '未准备' }}</div>
            </div>
          </div>
        </div>

        <div v-if="room.roomState.status === 'waiting'" class="mt-3 space-y-3">
          <div v-if="isOwner" class="rounded-xl border border-white/10 bg-white/5 p-4">
            <div class="mb-2 text-sm font-medium">房主配置</div>
            <div class="space-y-3">
              <div>
                <div class="mb-1 text-xs text-white/60">身份配置（总数会自动补足为村民）</div>
                <div class="grid grid-cols-2 gap-2">
                  <div class="rounded-lg border border-white/10 bg-black/20 p-3">
                    <div class="text-xs text-white/60">狼人</div>
                    <input v-model.number="localRoleConfig.werewolf" type="number" min="1" max="5" class="mt-1 w-full rounded-md border border-white/10 bg-black/20 px-2 py-1 text-sm" />
                  </div>
                  <div class="rounded-lg border border-white/10 bg-black/20 p-3">
                    <div class="text-xs text-white/60">预言家</div>
                    <input v-model.number="localRoleConfig.seer" type="number" min="0" max="1" class="mt-1 w-full rounded-md border border-white/10 bg-black/20 px-2 py-1 text-sm" />
                  </div>
                  <div class="rounded-lg border border-white/10 bg-black/20 p-3">
                    <div class="text-xs text-white/60">女巫</div>
                    <input v-model.number="localRoleConfig.witch" type="number" min="0" max="1" class="mt-1 w-full rounded-md border border-white/10 bg-black/20 px-2 py-1 text-sm" />
                  </div>
                  <div class="rounded-lg border border-white/10 bg-black/20 p-3">
                    <div class="text-xs text-white/60">猎人</div>
                    <input v-model.number="localRoleConfig.hunter" type="number" min="0" max="1" class="mt-1 w-full rounded-md border border-white/10 bg-black/20 px-2 py-1 text-sm" />
                  </div>
                  <div class="rounded-lg border border-white/10 bg-black/20 p-3">
                    <div class="text-xs text-white/60">守卫</div>
                    <input v-model.number="localRoleConfig.guard" type="number" min="0" max="1" class="mt-1 w-full rounded-md border border-white/10 bg-black/20 px-2 py-1 text-sm" />
                  </div>
                </div>
              </div>

              <div>
                <div class="mb-1 text-xs text-white/60">计时（秒）</div>
                <div class="grid grid-cols-2 gap-2">
                  <div class="rounded-lg border border-white/10 bg-black/20 p-3">
                    <div class="text-xs text-white/60">夜晚</div>
                    <input v-model.number="localTimers.nightSeconds" type="number" min="10" max="180" class="mt-1 w-full rounded-md border border-white/10 bg-black/20 px-2 py-1 text-sm" />
                  </div>
                  <div class="rounded-lg border border-white/10 bg-black/20 p-3">
                    <div class="text-xs text-white/60">发言</div>
                    <input v-model.number="localTimers.daySpeechSeconds" type="number" min="10" max="300" class="mt-1 w-full rounded-md border border-white/10 bg-black/20 px-2 py-1 text-sm" />
                  </div>
                  <div class="rounded-lg border border-white/10 bg-black/20 p-3">
                    <div class="text-xs text-white/60">投票</div>
                    <input v-model.number="localTimers.dayVoteSeconds" type="number" min="10" max="180" class="mt-1 w-full rounded-md border border-white/10 bg-black/20 px-2 py-1 text-sm" />
                  </div>
                  <div class="rounded-lg border border-white/10 bg-black/20 p-3">
                    <div class="text-xs text-white/60">结算</div>
                    <input v-model.number="localTimers.settlementSeconds" type="number" min="5" max="120" class="mt-1 w-full rounded-md border border-white/10 bg-black/20 px-2 py-1 text-sm" />
                  </div>
                </div>
              </div>

              <button class="w-full rounded-lg border border-violet-500/40 bg-violet-600/20 px-4 py-2.5 text-sm text-white" @click="emitConfig">
                保存配置
              </button>

              <button v-if="room.roomState.members.some(m => !m.user)" class="w-full rounded-lg border border-emerald-500/40 bg-emerald-600/20 px-4 py-2.5 text-sm text-white" @click="addBot">
                添加机器人
              </button>
            </div>
          </div>

          <div class="fixed inset-x-0 bottom-0 border-t border-white/10 bg-[#0b1020]/95 px-4 py-3 backdrop-blur">
            <div class="mx-auto flex max-w-md gap-2">
              <button
                class="flex-1 rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white"
                @click="setReady(true)"
              >
                准备
              </button>
              <button
                v-if="isOwner"
                class="flex-1 rounded-lg bg-violet-600 px-4 py-3 text-sm font-medium text-white"
                @click="startGame"
              >
                开始
              </button>
            </div>
          </div>
        </div>

        <div v-else class="mt-3 space-y-3">
          <div class="rounded-xl border border-white/10 bg-white/5 p-4">
            <div class="mb-2 flex items-center justify-between">
              <div class="text-sm font-medium">我的身份</div>
              <div class="text-xs text-white/60">{{ myRoleLabel }}</div>
            </div>
            <div class="text-xs text-white/70">
              <div v-if="room.gamePrivate?.role === 'werewolf'">夜晚选择击杀目标。</div>
              <div v-else-if="room.gamePrivate?.role === 'seer'">夜晚选择查验目标。</div>
              <div v-else-if="room.gamePrivate?.role === 'witch'">夜晚可选择是否用解药与毒药。</div>
              <div v-else-if="room.gamePrivate?.role === 'guard'">夜晚选择守护目标。</div>
              <div v-else-if="room.gamePrivate?.role === 'hunter'">被淘汰时可开枪带走一人。</div>
              <div v-else-if="room.gamePrivate?.role === 'villager'">你是村民，白天发言并参与投票。</div>
            </div>
          </div>

          <div class="rounded-xl border border-white/10 bg-white/5 p-4">
            <div class="mb-2 text-sm font-medium">系统日志</div>
            <div class="max-h-44 space-y-2 overflow-auto pr-1">
              <div v-for="l in room.gamePublic?.publicLog || []" :key="l.id" class="text-xs text-white/70">
                {{ l.text }}
              </div>
            </div>
          </div>

          <div class="rounded-xl border border-white/10 bg-white/5 p-4">
            <div class="mb-2 text-sm font-medium">私密提示</div>
            <div class="max-h-36 space-y-2 overflow-auto pr-1">
              <div v-for="h in room.gamePrivate?.hints || []" :key="h.id" class="text-xs text-white/70">
                {{ h.text }}
              </div>
            </div>
          </div>

          <div class="rounded-xl border border-white/10 bg-white/5 p-4">
            <div class="mb-2 text-sm font-medium">发言与聊天</div>
            <div class="mb-3 max-h-44 space-y-2 overflow-auto pr-1">
              <div v-for="m in room.chat" :key="m.id" class="text-xs text-white/70">
                <span v-if="(m as any).channel === 'wolf'" class="mr-1 rounded bg-red-900/50 px-1 text-[10px] text-red-300">狼队</span>
                <span class="text-white/90">{{ m.sender.nickname }}：</span>{{ m.text }}
              </div>
            </div>
            <div class="flex flex-col gap-2">
              <div v-if="room.gamePrivate?.role === 'werewolf'" class="flex gap-2">
                <button 
                  class="flex-1 rounded-lg border px-2 py-1 text-xs transition-colors"
                  :class="chatChannel === 'public' ? 'bg-white/10 border-white/20 text-white' : 'border-transparent text-white/50 hover:bg-white/5'"
                  @click="chatChannel = 'public'"
                >
                  公聊
                </button>
                <button 
                  class="flex-1 rounded-lg border px-2 py-1 text-xs transition-colors"
                  :class="chatChannel === 'wolf' ? 'bg-red-500/20 border-red-500/40 text-red-300' : 'border-transparent text-white/50 hover:bg-white/5'"
                  @click="chatChannel = 'wolf'"
                >
                  狼队私聊
                </button>
              </div>
              <div class="flex gap-2">
                <input
                  v-model="chatText"
                  class="flex-1 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-white/25"
                  :placeholder="chatChannel === 'wolf' ? '输入狼队暗号…' : '输入消息…'"
                  @keyup.enter="sendChat"
                />
                <button class="rounded-lg bg-violet-600 px-4 py-2 text-sm text-white" @click="sendChat">发送</button>
              </div>
            </div>
          </div>

          <div class="fixed inset-x-0 bottom-0 border-t border-white/10 bg-[#0b1020]/95 px-4 py-3 backdrop-blur">
            <div class="mx-auto max-w-md">
              <div class="mb-2 flex items-center justify-between">
                <div class="text-xs text-white/60">当前阶段：{{ phaseLabel }}</div>
                <div v-if="room.gamePublic?.phase === 'night' && activeRoleLabel" class="text-xs font-bold text-violet-400 animate-pulse">
                  当前行动：{{ activeRoleLabel }}
                </div>
              </div>

              <div v-if="room.gamePublic?.phase === 'night'" class="grid grid-cols-2 gap-2">
                <button
                  v-for="s in aliveSeats.filter(x => x !== meSeat)"
                  :key="`n-${s}`"
                  class="rounded-lg border px-3 py-3 text-sm transition-all duration-200"
                  :class="[
                    room.gamePrivate?.selectedTargetSeat === s 
                      ? 'border-violet-500 bg-violet-500/30 text-white shadow-[0_0_15px_rgba(139,92,246,0.3)] scale-105' 
                      : room.gamePrivate?.selectedTargetSeat != null
                        ? 'border-white/5 bg-white/5 text-white/20'
                        : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/10'
                  ]"
                  :disabled="room.gamePrivate?.selectedTargetSeat != null || room.gamePrivate?.role !== room.gamePublic?.activeRole"
                  @click="
                    room.gamePrivate?.role === 'werewolf'
                      ? submitAction('night.wolfKill', { targetSeat: s })
                      : room.gamePrivate?.role === 'seer'
                        ? submitAction('night.seerCheck', { targetSeat: s })
                        : room.gamePrivate?.role === 'guard'
                          ? submitAction('night.guardProtect', { targetSeat: s })
                          : room.gamePrivate?.role === 'witch'
                            ? submitAction('night.witch.poison', { targetSeat: s })
                            : null
                  "
                >
                  {{ s }}号
                </button>

                <button
                  v-if="room.gamePrivate?.role === 'witch'"
                  class="col-span-2 rounded-lg border px-4 py-3 text-sm transition-all duration-200"
                  :class="[
                    room.gamePrivate?.witchSaveDecision 
                      ? 'border-emerald-500 bg-emerald-500/30 text-white shadow-[0_0_15px_rgba(16,185,129,0.3)]' 
                      : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/10'
                  ]"
                  :disabled="room.gamePrivate?.witchSaveDecision || room.gamePublic?.activeRole !== 'witch'"
                  @click="submitAction('night.witch.save', { use: true })"
                >
                  使用解药（若有效）
                </button>
                <button
                  v-if="room.gamePrivate?.role === 'witch' && room.gamePublic?.activeRole === 'witch'"
                  class="col-span-2 rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/70"
                  :disabled="room.gamePrivate?.selectedTargetSeat != null"
                  @click="submitAction('night.witch.poison', { targetSeat: null })"
                >
                  不使用毒药
                </button>
                <button
                  v-if="room.gamePrivate?.role === 'guard' && room.gamePublic?.activeRole === 'guard'"
                  class="col-span-2 rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/70"
                  :disabled="room.gamePrivate?.selectedTargetSeat != null"
                  @click="submitAction('night.guardProtect', { targetSeat: 0 })"
                >
                  空守（不动作）
                </button>
              </div>

              <div v-else-if="room.gamePublic?.phase === 'day_vote'" class="grid grid-cols-2 gap-2">
                <button
                  v-for="s in aliveSeats.filter(x => x !== meSeat)"
                  :key="`v-${s}`"
                  class="rounded-lg border px-3 py-3 text-sm transition-all duration-200"
                  :class="[
                    room.gamePrivate?.selectedTargetSeat === s 
                      ? 'border-violet-500 bg-violet-500/30 text-white shadow-[0_0_15px_rgba(139,92,246,0.3)] scale-105' 
                      : room.gamePrivate?.selectedTargetSeat !== undefined
                        ? 'border-white/5 bg-white/5 text-white/20'
                        : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/10'
                  ]"
                  :disabled="room.gamePrivate?.selectedTargetSeat !== undefined"
                  @click="submitAction('day.vote', { targetSeat: s })"
                >
                  投 {{ s }} 号
                </button>
                <button
                  class="col-span-2 rounded-lg border px-4 py-3 text-sm transition-all duration-200"
                  :class="[
                    room.gamePrivate?.selectedTargetSeat === null
                      ? 'border-white/40 bg-white/20 text-white shadow-[0_0_10px_rgba(255,255,255,0.1)]' 
                      : room.gamePrivate?.selectedTargetSeat !== undefined
                        ? 'border-white/5 bg-white/5 text-white/20'
                        : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/10'
                  ]"
                  :disabled="room.gamePrivate?.selectedTargetSeat !== undefined"
                  @click="submitAction('day.vote', { targetSeat: null })"
                >
                  弃票
                </button>
              </div>

              <div v-else-if="room.gamePublic?.phase === 'settlement'" class="grid grid-cols-2 gap-2">
                <template v-if="room.gamePrivate?.actions?.hunterShoot">
                  <button
                    v-for="s in aliveSeats.filter(x => x !== meSeat)"
                    :key="`h-${s}`"
                    class="rounded-lg border border-white/10 bg-white/5 px-3 py-3 text-sm text-white"
                    @click="submitAction('settlement.hunterShoot', { targetSeat: s })"
                  >
                    带走 {{ s }}号
                  </button>
                  <button
                    class="col-span-2 rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white"
                    @click="submitAction('settlement.hunterShoot', { targetSeat: null })"
                  >
                    不开枪
                  </button>
                </template>
                <div v-else class="col-span-2 rounded-lg border border-white/10 bg-white/5 px-3 py-3 text-sm text-white/70">
                  等待结算…
                </div>
              </div>

              <div v-else-if="room.gamePublic?.phase === 'sheriff_election'" class="flex flex-col gap-2">
                <button
                  class="w-full rounded-lg bg-yellow-600 px-4 py-3 text-sm font-semibold text-white shadow-lg active:scale-95"
                  @click="submitAction('sheriff.enroll', {})"
                >
                  我要上警 (竞选警长)
                </button>
                <button
                  class="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/70"
                  @click="submitAction('sheriff.quit', {})"
                >
                  放弃竞选
                </button>
              </div>

              <div v-else-if="room.gamePublic?.phase === 'sheriff_speech' || room.gamePublic?.phase === 'day_speech'" class="flex flex-col items-center justify-center p-4">
                <div v-if="room.gamePublic?.activeSpeakerSeat === meSeat" class="w-full space-y-4">
                  <div class="text-center text-sm font-medium text-violet-400 animate-pulse">正在发言...</div>
                  <button
                    class="w-full rounded-lg bg-violet-600 px-4 py-3 text-sm font-bold text-white shadow-lg active:scale-95"
                    @click="submitAction('game.nextSpeaker', {})"
                  >
                    结束发言
                  </button>
                </div>
                <div v-else class="text-center">
                  <div class="text-sm font-medium text-white/60">正在倾听 {{ room.gamePublic?.activeSpeakerSeat }} 号玩家发言</div>
                </div>
              </div>

              <div v-else-if="room.gamePublic?.phase === 'sheriff_vote'" class="grid grid-cols-2 gap-2">
                <button
                  v-for="s in room.gamePublic?.players?.filter(p => p.isAlive) || []"
                  :key="`sv-${s.seat}`"
                  class="rounded-lg border px-3 py-3 text-sm transition-all duration-200 border-white/10 bg-white/5 text-white/70 hover:bg-white/10"
                  @click="submitAction('sheriff.vote', { targetSeat: s.seat })"
                >
                  投 {{ s.seat }} 号
                </button>
                <button
                  class="col-span-2 rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/70"
                  @click="submitAction('sheriff.vote', { targetSeat: null })"
                >
                  弃权
                </button>
              </div>

              <div v-else class="rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/70">
                该阶段无需操作。
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
