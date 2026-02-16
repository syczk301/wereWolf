<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePusher } from '@/composables/usePusher'
import { useVoiceRtc } from '@/composables/useVoiceRtc'
import { useRoomStore } from '@/stores/room'
import { useSessionStore } from '@/stores/session'
import { api } from '@/utils/api'
import type { Channel } from 'pusher-js'
import type { WebRtcSignalEvent } from '../../shared/types'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const room = useRoomStore()
const { connect: connectPusher, subscribeRoom, subscribeUser, unsubscribeRoom, unsubscribeUser } = usePusher()
const voiceRtc = useVoiceRtc()

let roomChannel: Channel | null = null
let userChannel: Channel | null = null

const roomId = computed(() => String(route.params.roomId || ''))
const connected = ref(false)
const joining = ref(false)
const token = computed(() => session.token ?? '')

const chatText = ref('')
const wolfChatText = ref('')
const showIdentityPanel = ref(true)
const showLogPanel = ref(false)

function togglePanel(panel: 'identity' | 'log') {
  if (panel === 'identity') showIdentityPanel.value = !showIdentityPanel.value
  if (panel === 'log') showLogPanel.value = !showLogPanel.value
}

const isOwner = computed(() => {
  if (!room.roomState || !session.user) return false
  return room.roomState.ownerUserId === session.user.id
})

const meReady = computed(() => {
  if (!room.roomState || !session.user) return false
  const me = room.roomState.members?.find((m: any) => m.user?.id === session.user!.id)
  return !!me?.isReady
})

const meSeat = computed(() => room.gamePrivate?.seat ?? null)
const canUseWolfChannel = computed(() => room.gamePrivate?.role === 'werewolf')
const isSpeechPhase = computed(() => ['day_speech', 'sheriff_speech'].includes(room.gamePublic?.phase || ''))

const canSpeakInPublic = computed(() => {
  // Lobby chat remains available before game starts.
  if (!room.roomState?.gameId) return true
  if (!isSpeechPhase.value) return false
  if (room.gamePublic?.activeSpeakerSeat == null) return false
  return room.gamePublic.activeSpeakerSeat === meSeat.value
})

const publicChatLockReason = computed(() => {
  if (!room.roomState?.gameId) return ''
  const phase = room.gamePublic?.phase
  if (phase !== 'day_speech' && phase !== 'sheriff_speech') return '当前不是公开发言阶段'
  if (room.gamePublic?.activeSpeakerSeat !== meSeat.value) return '未轮到你发言'
  return ''
})

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

const activeSpeakerMember = computed(() => {
  const seat = room.gamePublic?.activeSpeakerSeat
  if (seat == null) return null
  return sortedMembers.value.find((m: any) => m.seat === seat) ?? null
})

const activeSpeakerUserId = computed(() => {
  const seat = room.gamePublic?.activeSpeakerSeat
  if (seat == null) return null
  const player = room.gamePublic?.players?.find((p) => p.seat === seat)
  return player?.user?.id ?? null
})

const voiceAudienceUserIds = computed(() => {
  const speakerUserId = activeSpeakerUserId.value
  const ids = (room.gamePublic?.players ?? [])
    .map((p) => p.user?.id)
    .filter((id): id is string => !!id)
  if (!speakerUserId) return ids
  return ids.filter((id) => id !== speakerUserId)
})

const voicePlayersSignature = computed(() => {
  return (room.gamePublic?.players ?? [])
    .map((p) => `${p.seat}:${p.user?.id ?? ''}:${p.isAlive ? 1 : 0}`)
    .join('|')
})

const stagePublicMessages = computed(() => {
  return room.chat
    .filter((m: any) => (m as any).channel !== 'wolf')
    .slice(-3)
})

const stageWolfMessages = computed(() => {
  return room.chat
    .filter((m: any) => (m as any).channel === 'wolf')
    .slice(-4)
})

const canUseVoiceMic = computed(() => {
  if (!room.roomState?.gameId) return false
  if (!isSpeechPhase.value) return false
  const uid = session.user?.id
  if (!uid) return false
  return activeSpeakerUserId.value === uid
})

const voiceMicLockReason = computed(() => {
  if (!room.roomState?.gameId) return '游戏开始后可用语音'
  if (!isSpeechPhase.value) return '仅发言阶段可开麦'
  const uid = session.user?.id
  if (!uid) return '请先登录'
  if (!activeSpeakerUserId.value) return '当前无发言者'
  if (activeSpeakerUserId.value !== uid) return '未轮到你发言'
  return ''
})

const audioNeedsUnlock = computed(() => {
  return !ttsUnlocked.value || !voiceRtc.audioUnlocked.value || voiceRtc.pendingPlayback.value
})

const audioUnlockText = computed(() => {
  if (voiceRtc.pendingPlayback.value) return '检测到音频被拦截，请点击启用声音'
  if (!voiceRtc.audioUnlocked.value) return '实时语音尚未解锁'
  if (!ttsUnlocked.value) return '播报语音尚未解锁'
  return '声音未启用'
})

function buildVoiceContext() {
  const uid = session.user?.id
  if (!uid) return null
  return {
    token: token.value,
    roomId: roomId.value,
    myUserId: uid,
    isSpeechPhase: isSpeechPhase.value,
    activeSpeakerUserId: activeSpeakerUserId.value,
    audienceUserIds: voiceAudienceUserIds.value,
  }
}

async function syncVoiceTurnContext() {
  const ctx = buildVoiceContext()
  if (!ctx || !ctx.token || !ctx.roomId) return
  await voiceRtc.updateTurnContext(ctx)
}

async function toggleVoiceMic() {
  const ctx = buildVoiceContext()
  if (!ctx || !ctx.token || !ctx.roomId) return
  try {
    await voiceRtc.setMicEnabled(!voiceRtc.micEnabled.value, ctx)
  } catch (e: any) {
    room.pushToast('error', e?.message ?? '语音开麦失败')
  }
}

async function retryVoiceConnection() {
  const ctx = buildVoiceContext()
  if (!ctx || !ctx.token || !ctx.roomId) return
  try {
    if (voiceRtc.micEnabled.value) {
      await voiceRtc.setMicEnabled(true, ctx)
      return
    }
    await voiceRtc.updateTurnContext(ctx)
  } catch (e: any) {
    room.pushToast('error', e?.message ?? '语音重试失败')
  }
}

async function unlockVoicePlayback() {
  await voiceRtc.unlockAudioPlayback()
}

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

const mainContentPaddingBottom = computed(() => {
  if (room.roomState?.status === 'waiting') {
    return 'calc(11rem + var(--safe-bottom))'
  }
  if (isSpeechPhase.value) {
    return 'calc(6rem + var(--safe-bottom))'
  }
  if (room.gamePublic?.phase === 'night') {
    return 'calc(21rem + var(--safe-bottom))'
  }
  if (room.gamePublic?.phase && room.gamePublic.phase !== 'game_over') {
    return 'calc(18rem + var(--safe-bottom))'
  }
  return 'calc(7rem + var(--safe-bottom))'
})

const roleConfig = computed(() => (room.roomState?.roleConfig ?? { werewolf: 2, seer: 1, witch: 1, hunter: 0, guard: 0 }) as any)
const timers = computed(() => (room.roomState?.timers ?? { nightSeconds: 45, daySpeechSeconds: 60, dayVoteSeconds: 45, settlementSeconds: 20 }) as any)

const localRoleConfig = ref({ ...roleConfig.value })
const localTimers = ref({ ...timers.value })

function syncLocalConfig() {
  localRoleConfig.value = { ...roleConfig.value }
  localTimers.value = { ...timers.value }
}

function emitConfig() {
  api.wsRoomConfig(token.value, roomId.value, localRoleConfig.value, localTimers.value).then((resp: any) => {
    if (resp.roomState) room.applyRoom(resp.roomState)
  }).catch((e: any) => room.pushToast('error', e?.message ?? '更新配置失败'))
}

function setReady(ready: boolean) {
  api.wsRoomReady(token.value, roomId.value, ready).then((resp: any) => {
    if (resp.roomState) room.applyRoom(resp.roomState)
  }).catch((e: any) => room.pushToast('error', e?.message ?? '设置准备失败'))
}

// 弹窗状态
const showBotConfirm = ref(false)
const neededBots = ref(0)
const addingBots = ref(false)

function startGame() {
  const members = room.roomState?.members || []
  const playerCount = members.filter(m => m.user).length
  const maxPlayers = room.roomState?.maxPlayers || 9
  
  if (playerCount < maxPlayers) {
    neededBots.value = maxPlayers - playerCount
    showBotConfirm.value = true
    return
  }
  
  api.wsRoomStart(token.value, roomId.value).then((resp: any) => {
    if (resp.roomState) room.applyRoom(resp.roomState)
    if (resp.gamePublic) room.applyGamePublic(resp.gamePublic)
    if (resp.gamePrivate) room.applyGamePrivate(resp.gamePrivate)
  }).catch((e: any) => room.pushToast('error', e?.message ?? '开局失败'))
}

async function confirmAddBots() {
  addingBots.value = true
  try {
    const fillResp = await api.wsRoomBotFill(token.value, roomId.value)
    if (fillResp.roomState) room.applyRoom(fillResp.roomState)
    const startResp = await api.wsRoomStart(token.value, roomId.value)
    if (startResp.roomState) room.applyRoom(startResp.roomState)
    if (startResp.gamePublic) room.applyGamePublic(startResp.gamePublic)
    if (startResp.gamePrivate) room.applyGamePrivate(startResp.gamePrivate)
  } catch (e: any) {
    room.pushToast('error', e?.message ?? '操作失败')
  } finally {
    addingBots.value = false
    showBotConfirm.value = false
  }
}

function cancelBotConfirm() {
  showBotConfirm.value = false
  neededBots.value = 0
}

function addBot() {
  api.wsRoomBotAdd(token.value, roomId.value).then((resp: any) => {
    if (resp.roomState) room.applyRoom(resp.roomState)
  }).catch((e: any) => room.pushToast('error', e?.message ?? '添加机器人失败'))
}

function sendChat() {
  if (!canSpeakInPublic.value) {
    room.pushToast('info', publicChatLockReason.value || '未到你的发言回合')
    return
  }
  const text = chatText.value.trim()
  if (!text) return
  chatText.value = ''
  api.wsChatSend(token.value, roomId.value, text, 'public').then((resp: any) => {
    if (resp.msg) room.pushChat(resp.msg)
  }).catch((e: any) => room.pushToast('error', e?.message ?? '发送失败'))
}

function sendWolfChat() {
  if (!canUseWolfChannel.value) {
    room.pushToast('info', '仅狼人可使用狼人频道')
    return
  }
  const text = wolfChatText.value.trim()
  if (!text) return
  wolfChatText.value = ''
  api.wsChatSend(token.value, roomId.value, text, 'wolf').then((resp: any) => {
    if (resp.msg) room.pushChat(resp.msg)
  }).catch((e: any) => room.pushToast('error', e?.message ?? '狼人频道发送失败'))
}

function submitAction(actionType: string, payload: any) {
  api.wsGameAction(token.value, roomId.value, actionType, payload).then((resp: any) => {
    if (resp.roomState) room.applyRoom(resp.roomState)
    if (resp.gamePublic) room.applyGamePublic(resp.gamePublic)
    if (resp.gamePrivate) room.applyGamePrivate(resp.gamePrivate)
  }).catch((e: any) => room.pushToast('error', e?.message ?? '操作失败'))
}

function leaveRoom() {
  api.wsRoomLeave(token.value, roomId.value).catch(() => {})
  router.push('/lobby')
}

function setupPusherListeners() {
  const rid = roomId.value
  const uid = session.user?.id
  if (!rid || !uid) return

  connectPusher()
  roomChannel = subscribeRoom(rid)
  userChannel = subscribeUser(uid)

  roomChannel.bind('room:state', (payload: any) => {
    room.applyRoom(payload)
    syncLocalConfig()
  })
  roomChannel.bind('game:state', (payload: any) => {
    room.applyGamePublic(payload)
  })
  roomChannel.bind('chat:new', (payload: any) => {
    room.pushChat(payload)
  })
  roomChannel.bind('toast', (payload: any) => {
    room.pushToast(payload.type, payload.message)
  })
  roomChannel.bind('room:expired', async () => {
    room.pushToast('info', '房间超时解散')
    room.reset()
    await router.replace('/lobby')
  })
  roomChannel.bind('room:dissolved', async () => {
    room.pushToast('info', '房间已解散')
    room.reset()
    await router.replace('/lobby')
  })

  userChannel.bind('game:private', (payload: any) => {
    room.applyGamePrivate(payload)
  })
  userChannel.bind('chat:new', (payload: any) => {
    room.pushChat(payload)
  })
  userChannel.bind('webrtc:signal', (payload: WebRtcSignalEvent) => {
    if (!payload || payload.roomId !== roomId.value) return
    const fromUserId = String(payload.fromUserId || '')
    if (!fromUserId || !payload.signal) return
    const ctx = buildVoiceContext()
    if (!ctx || !ctx.token || !ctx.roomId) return
    voiceRtc.handleSignal(fromUserId, payload.signal, ctx).catch((e: any) => {
      room.pushToast('error', e?.message ?? '语音信令处理失败')
    })
  })
}

function teardownPusher() {
  const rid = roomId.value
  const uid = session.user?.id
  if (rid) unsubscribeRoom(rid)
  if (uid) unsubscribeUser(uid)
  roomChannel = null
  userChannel = null
}

async function join() {
  if (joining.value) return
  if (room.roomState && room.roomState.id === roomId.value) {
    connected.value = true
  }
  
  joining.value = true
  try {
    setupPusherListeners()

    const resp = await api.wsRoomJoin(token.value, roomId.value)
    connected.value = true

    if (resp.roomState) {
      room.applyRoom(resp.roomState)
      syncLocalConfig()
    }
    if (resp.gamePublic) room.applyGamePublic(resp.gamePublic)
    if (resp.gamePrivate) room.applyGamePrivate(resp.gamePrivate)
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

function isWolfAllySeat(seat: number) {
  if (!canUseWolfChannel.value) return false
  return !!room.gamePrivate?.wolfTeam?.some((w) => w.seat === seat)
}

function isSeatDead(seat: number) {
  const gp = room.gamePublic?.players?.find((p) => p.seat === seat)
  if (!gp) return false
  return !gp.isAlive
}

const isLikelyMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
const ttsUnlocked = ref(!isLikelyMobile)
const queuedSpeechQueue = ref<string[]>([])
const selectedTtsVoice = ref<any>(null)
const hasShownTtsHint = ref(false)
let cueAudioCtx: AudioContext | null = null
let ttsUnlockHandler: (() => void) | null = null
let ttsVisibilityHandler: (() => void) | null = null
let ttsVoicesChangedHandler: (() => void) | null = null
let isSpeechQueueRunning = false

function playCueTone() {
  if (!voiceRtc.audioUnlocked.value) return
  const AudioContextCtor = (window as any).AudioContext || (window as any).webkitAudioContext
  if (!AudioContextCtor) return
  if (!cueAudioCtx) {
    cueAudioCtx = new AudioContextCtor()
  }
  const ctx = cueAudioCtx
  ctx.resume().catch(() => {})
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = 880
  gain.gain.value = 0.025
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start()
  osc.stop(ctx.currentTime + 0.08)
}

function resolveTtsVoice() {
  if (!window.speechSynthesis) return
  const voices = window.speechSynthesis.getVoices()
  if (!voices.length) return
  selectedTtsVoice.value =
    voices.find((v) => /^zh/i.test(v.lang)) ??
    voices.find((v) => /chinese|中文/i.test(v.name)) ??
    voices[0] ??
    null
}

function clearTtsUnlockListeners() {
  if (!ttsUnlockHandler) return
  document.removeEventListener('pointerdown', ttsUnlockHandler)
  document.removeEventListener('touchstart', ttsUnlockHandler)
  document.removeEventListener('click', ttsUnlockHandler)
  document.removeEventListener('keydown', ttsUnlockHandler)
  ttsUnlockHandler = null
}

function buildCloudTtsUrls(text: string) {
  const q = encodeURIComponent(text.slice(0, 80))
  return [
    `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=zh-CN&q=${q}`,
    `https://dict.youdao.com/dictvoice?audio=${q}&type=1`,
  ]
}

async function playCloudNarration(text: string) {
  if (!voiceRtc.audioUnlocked.value) return false
  const urls = buildCloudTtsUrls(text)
  for (const url of urls) {
    try {
      const audio = new Audio(url)
      audio.setAttribute('playsinline', 'true')
      audio.preload = 'auto'
      audio.volume = 1
      await audio.play()
      await new Promise<void>((resolve) => {
        const done = () => resolve()
        audio.onended = done
        audio.onerror = done
        setTimeout(done, 2800)
      })
      return true
    } catch {
      // try next provider
    }
  }
  return false
}

async function speakWithNative(text: string) {
  if (!window.speechSynthesis || !ttsUnlocked.value) return false
  const synth = window.speechSynthesis
  return await new Promise<boolean>((resolve) => {
    let settled = false
    let started = false
    let timeout: any = null
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      resolve(ok)
    }

    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'zh-CN'
    if (selectedTtsVoice.value) utterance.voice = selectedTtsVoice.value
    utterance.rate = 1.0
    utterance.pitch = 1.0
    utterance.volume = 1.0
    utterance.onstart = () => {
      started = true
    }
    utterance.onend = () => done(true)
    utterance.onerror = () => done(false)

    timeout = setTimeout(() => done(started), 2000)
    try {
      synth.resume()
      synth.cancel()
      synth.speak(utterance)
    } catch {
      done(false)
    }
  })
}

async function runSpeechQueue() {
  if (isSpeechQueueRunning) return
  isSpeechQueueRunning = true
  try {
    while (queuedSpeechQueue.value.length) {
      const text = queuedSpeechQueue.value.shift()
      if (!text) continue
      let played = await speakWithNative(text)
      if (!played) {
        played = await playCloudNarration(text)
      }
      if (!played) {
        playCueTone()
      }
      await new Promise((resolve) => setTimeout(resolve, 90))
    }
  } finally {
    isSpeechQueueRunning = false
  }
}

function flushQueuedSpeech() {
  if (!queuedSpeechQueue.value.length) return
  void runSpeechQueue()
}

function unlockTtsByGesture() {
  // Always unlock WebRTC playback first; it should not depend on TTS availability.
  void unlockVoicePlayback()
  if (!window.speechSynthesis) {
    ttsUnlocked.value = true
    clearTtsUnlockListeners()
    flushQueuedSpeech()
    return
  }
  try {
    const synth = window.speechSynthesis
    synth.resume()
    const probe = new SpeechSynthesisUtterance('语音已启用')
    probe.lang = 'zh-CN'
    probe.volume = 0.2
    probe.rate = 1.0
    probe.pitch = 1.0
    synth.cancel()
    synth.speak(probe)
    ttsUnlocked.value = true
    resolveTtsVoice()
    flushQueuedSpeech()
  } catch {
    // Keep listener for next gesture
    return
  }
  if (voiceRtc.audioUnlocked.value && ttsUnlocked.value) {
    clearTtsUnlockListeners()
  }
}

function setupSpeechSupport() {
  if (!ttsUnlocked.value || !voiceRtc.audioUnlocked.value) {
    ttsUnlockHandler = () => unlockTtsByGesture()
    document.addEventListener('pointerdown', ttsUnlockHandler)
    document.addEventListener('touchstart', ttsUnlockHandler)
    document.addEventListener('click', ttsUnlockHandler)
    document.addEventListener('keydown', ttsUnlockHandler)
  }

  if (!window.speechSynthesis) return

  resolveTtsVoice()
  ttsVoicesChangedHandler = () => resolveTtsVoice()
  window.speechSynthesis.addEventListener('voiceschanged', ttsVoicesChangedHandler)

  ttsVisibilityHandler = () => {
    if (document.visibilityState === 'visible') {
      window.speechSynthesis.resume()
    }
  }
  document.addEventListener('visibilitychange', ttsVisibilityHandler)
}

function manualEnableAudio() {
  unlockTtsByGesture()
  setTimeout(() => {
    if (!voiceRtc.audioUnlocked.value || !ttsUnlocked.value) {
      room.pushToast('info', '请再次点击“启用声音”')
      return
    }
    room.pushToast('info', '声音已启用')
    speak('语音播报测试')
  }, 120)
}

function teardownSpeechSupport() {
  clearTtsUnlockListeners()
  if (ttsVisibilityHandler) {
    document.removeEventListener('visibilitychange', ttsVisibilityHandler)
    ttsVisibilityHandler = null
  }
  if (ttsVoicesChangedHandler && window.speechSynthesis) {
    window.speechSynthesis.removeEventListener('voiceschanged', ttsVoicesChangedHandler)
    ttsVoicesChangedHandler = null
  }
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel()
  }
  if (cueAudioCtx) {
    cueAudioCtx.close().catch(() => {})
    cueAudioCtx = null
  }
}

function speak(text: string) {
  if (!text) return
  queuedSpeechQueue.value.push(text)
  if (queuedSpeechQueue.value.length > 16) {
    queuedSpeechQueue.value = queuedSpeechQueue.value.slice(-16)
  }

  if (!voiceRtc.audioUnlocked.value) {
    if (!hasShownTtsHint.value) {
      room.pushToast('info', '请先点击“启用声音”')
      hasShownTtsHint.value = true
    }
    return
  }

  if (!window.speechSynthesis && !voiceRtc.audioUnlocked.value) return
  void runSpeechQueue()
}

// 角色图标映射
function getRoleIcon(role?: string): string {
  const icons: Record<string, string> = {
    werewolf: '狼',
    seer: '预',
    witch: '巫',
    guard: '守',
    hunter: '猎',
    villager: '民'
  }
  return icons[role || ''] || '?'
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

watch(
  [
    token,
    roomId,
    () => session.user?.id,
    () => room.gamePublic?.phase,
    () => room.gamePublic?.activeSpeakerSeat,
    voicePlayersSignature,
  ],
  () => {
    syncVoiceTurnContext().catch(() => {})
  },
  { immediate: true },
)


let pollInterval: any = null

async function pollGameState() {
  if (!token.value || !roomId.value) return
  try {
    const resp = await api.wsGamePoll(token.value, roomId.value)
    if (resp.roomState) room.applyRoom(resp.roomState)
    if (resp.gamePublic) room.applyGamePublic(resp.gamePublic)
    if (resp.gamePrivate) room.applyGamePrivate(resp.gamePrivate)
  } catch {
    // ignore poll errors
  }
}

onMounted(() => {
  room.reset()
  join()
  setupSpeechSupport()
  void syncVoiceTurnContext()
  // Poll game state every 2 seconds to compensate for serverless timer limitations
  pollInterval = setInterval(pollGameState, 2000)
})

onUnmounted(() => {
  teardownSpeechSupport()
  voiceRtc.dispose()
  teardownPusher()
  room.reset()
  if (pollInterval) clearInterval(pollInterval)
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
      />
      
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
          <div
            v-if="room.gamePublic?.phase === 'night'"
            class="absolute inset-0"
          >
            <div class="absolute right-3 top-4 h-5 w-5 rounded-full bg-amber-200/50" />
            <div class="absolute right-8 top-10 h-3 w-3 rounded-full bg-amber-200/40" />
            <div class="absolute left-4 top-12 h-4 w-4 rounded-full bg-amber-200/30" />
            <div class="absolute left-8 bottom-6 h-2.5 w-2.5 rounded-full bg-amber-200/35" />
          </div>
        </div>
      </div>
      
      <!-- 星空 - 夜晚增强 -->
      <div
        class="stars-layer absolute inset-0 overflow-hidden"
        :class="room.gamePublic?.phase === 'night' ? 'opacity-100' : 'opacity-30'"
      >
        <div class="star star-lg absolute left-[8%] top-[12%]" />
        <div class="star star-sm absolute left-[15%] top-[25%]" />
        <div class="star star-md absolute left-[22%] top-[8%]" />
        <div class="star star-sm absolute left-[35%] top-[18%]" />
        <div class="star star-lg absolute left-[45%] top-[5%]" />
        <div class="star star-sm absolute left-[55%] top-[22%]" />
        <div class="star star-md absolute left-[65%] top-[10%]" />
        <div class="star star-sm absolute left-[75%] top-[28%]" />
        <div class="star star-lg absolute left-[88%] top-[15%]" />
        <div class="star star-sm absolute left-[5%] top-[35%]" />
        <div class="star star-md absolute left-[92%] top-[35%]" />
        <div class="star star-sm absolute left-[30%] top-[32%]" />
        <div class="star star-lg absolute left-[50%] top-[28%]" />
        <div class="star star-sm absolute left-[70%] top-[35%]" />
      </div>
      
      <!-- 神秘光晕效果 -->
      <div class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-[600px] w-[600px] rounded-full bg-gradient-radial from-violet-600/5 via-transparent to-transparent blur-3xl" />
      
      <!-- 底部迷雾 -->
      <div class="absolute bottom-0 left-0 right-0 h-48 bg-gradient-to-t from-[#0a1020]/90 via-[#0a1020]/40 to-transparent" />
      
      <!-- 森林剪影 -->
      <div class="absolute bottom-0 left-0 right-0 h-24 opacity-60">
        <svg
          viewBox="0 0 1440 120"
          class="absolute bottom-0 h-full w-full"
          preserveAspectRatio="none"
        >
          <path
            d="M0,120 L0,80 Q30,60 60,80 L80,50 Q100,30 120,50 L140,70 Q160,50 180,70 L200,40 Q220,20 240,40 L260,60 Q280,40 300,60 L320,45 Q340,25 360,45 L380,75 Q400,55 420,75 L440,35 Q460,15 480,35 L500,65 Q520,45 540,65 L560,50 Q580,30 600,50 L620,80 Q640,60 660,80 L680,55 Q700,35 720,55 L740,70 Q760,50 780,70 L800,40 Q820,20 840,40 L860,75 Q880,55 900,75 L920,50 Q940,30 960,50 L980,65 Q1000,45 1020,65 L1040,80 Q1060,60 1080,80 L1100,45 Q1120,25 1140,45 L1160,70 Q1180,50 1200,70 L1220,55 Q1240,35 1260,55 L1280,75 Q1300,55 1320,75 L1340,60 Q1360,40 1380,60 L1400,80 Q1420,60 1440,80 L1440,120 Z"
            fill="#05080f"
          />
        </svg>
      </div>
      
      <!-- 漂浮粒子 -->
      <div class="particles-layer absolute inset-0 overflow-hidden">
        <div class="particle-float absolute left-[15%] top-[45%] h-2 w-2 rounded-full bg-violet-400/20" />
        <div class="particle-float absolute left-[35%] top-[60%] h-1.5 w-1.5 rounded-full bg-blue-400/15" />
        <div class="particle-float absolute left-[55%] top-[40%] h-2 w-2 rounded-full bg-amber-400/15" />
        <div class="particle-float absolute left-[75%] top-[55%] h-1.5 w-1.5 rounded-full bg-emerald-400/15" />
        <div class="particle-float absolute left-[25%] top-[70%] h-1 w-1 rounded-full bg-pink-400/20" />
        <div class="particle-float absolute left-[85%] top-[35%] h-1.5 w-1.5 rounded-full bg-cyan-400/15" />
      </div>
    </div>

    <!-- ==== 顶部状态栏 ==== -->
    <header class="fixed top-2 left-0 right-0 z-40 px-0 md:px-3">
      <div class="room-top-shell mx-auto w-full max-w-none md:max-w-[720px] lg:max-w-[900px]">
        <div class="flex items-center justify-between px-3.5 py-3">
          <div class="flex items-center gap-3 min-w-0">
            <div class="relative flex-shrink-0">
              <div class="h-10 w-10 rounded-xl bg-gradient-to-br from-red-600 to-orange-500 flex items-center justify-center shadow-lg shadow-red-500/20">
                <svg
                  class="w-5 h-5 text-white"
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
              <div
                class="absolute -bottom-1 -right-1 h-3 w-3 rounded-full border-2 border-[#0a0f1a]"
                :class="connected ? 'bg-emerald-400' : 'bg-red-400'"
              />
            </div>
            <div class="min-w-0">
              <div class="truncate text-sm font-semibold text-white">
                {{ room.roomState?.name || '狼人杀房间' }}
              </div>
              <div class="mt-0.5 flex items-center gap-2 text-[11px] text-white/55">
                <span
                  class="inline-flex items-center rounded-md px-1.5 py-0.5 font-medium"
                  :class="room.gamePublic?.phase === 'night' ? 'bg-violet-500/15 text-violet-300' : room.gamePublic?.phase === 'game_over' ? 'bg-red-500/15 text-red-300' : 'bg-amber-500/15 text-amber-300'"
                >
                  {{ phaseLabel }}
                </span>
                <span>第 {{ room.gamePublic?.dayNo ?? 0 }} 天</span>
              </div>
            </div>
          </div>
          <button
            class="h-11 min-w-[74px] rounded-xl border border-white/15 bg-white/5 px-3 text-sm text-white/75 transition-all duration-200 hover:bg-white/10 hover:text-white active:scale-[0.98]"
            @click="leaveRoom"
          >
            退出
          </button>
        </div>
      </div>
    </header>

    <!-- ==== 主内容区 ==== -->
    <main
      class="relative z-10 pt-[84px]"
      :style="{ paddingBottom: mainContentPaddingBottom }"
    >
      <div class="mx-auto w-full max-w-none px-0 md:max-w-[720px] md:px-3 lg:max-w-[900px]">
        <div class="room-hud-shell">
        <!-- 游戏计时器 -->
        <div
          v-if="room.gamePublic && room.gamePublic.phase !== 'game_over'"
          class="hud-timer-panel relative mb-3 overflow-hidden"
        >
          <div
            class="absolute inset-0 rounded-2xl ring-1 ring-inset"
            :class="isTimeLow ? 'ring-red-500/35' : 'ring-violet-500/25'"
          />
          <div class="relative p-4">
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <div class="flex items-center gap-2 text-xs font-medium uppercase tracking-wider">
                  <span
                    class="h-2.5 w-2.5 rounded-full animate-pulse"
                    :class="room.gamePublic?.phase === 'night' ? 'bg-violet-400 shadow-lg shadow-violet-400/50' : 'bg-amber-400 shadow-lg shadow-amber-400/50'"
                  />
                  <span class="text-white/65">{{ phaseLabel }}</span>
                </div>
                <div class="mt-1.5 text-2xl font-extrabold tracking-tight text-white">
                  {{ room.gamePublic?.phase === 'night' ? '夜幕阶段' : room.gamePublic?.phase?.includes('vote') ? '投票阶段' : '白天阶段' }}
                </div>
                <div class="mt-1 text-xs text-white/45">
                  {{ room.gamePublic?.phase === 'night' ? '按角色顺序依次行动' : '观察发言并做出判断' }}
                </div>
              </div>
              <div class="relative flex-shrink-0">
                <div
                  class="absolute inset-0 rounded-full blur-xl transition-all duration-300"
                  :class="isTimeLow ? 'bg-red-500/35' : 'bg-violet-500/25'"
                />
                <div
                  class="relative flex h-[74px] w-[74px] items-center justify-center rounded-full border-[3px] transition-all duration-200"
                  :class="[
                    isTimeLow
                      ? 'border-red-500/70 bg-gradient-to-br from-red-950/55 to-red-900/35'
                      : 'border-violet-500/45 bg-gradient-to-br from-violet-950/55 to-violet-900/35'
                  ]"
                >
                  <div class="text-center">
                    <span
                      class="text-[30px] font-black tabular-nums leading-none"
                      :class="isTimeLow ? 'text-red-300' : 'text-violet-300'"
                    >
                      {{ Math.max(0, secondsLeft) }}
                    </span>
                    <div class="mt-0.5 text-[10px] text-white/40 uppercase">
                      秒
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="absolute bottom-0 left-0 right-0 h-1.5 bg-white/5">
            <div
              class="h-full transition-all duration-1000 ease-linear"
              :style="{ width: `${timerProgress}%` }"
              :class="isTimeLow ? 'bg-gradient-to-r from-red-600 via-red-500 to-orange-500' : 'bg-gradient-to-r from-violet-600 via-violet-500 to-purple-500'"
            />
          </div>
        </div>

        <div
          v-if="audioNeedsUnlock"
          class="audio-unlock-banner mb-3"
        >
          <div class="audio-unlock-text">
            {{ audioUnlockText }}
          </div>
          <button
            class="audio-unlock-btn"
            @click="manualEnableAudio"
          >
            启用声音
          </button>
        </div>

        <div
          v-if="room.roomState"
          class="hud-stats-grid mb-3"
        >
          <div class="hud-stat-item">
            <div class="text-[10px] text-white/45">
              玩家
            </div>
            <div class="mt-0.5 text-sm font-semibold text-white">
              {{ room.roomState.members.filter(m => m.user).length }}/{{ room.roomState.maxPlayers }}
            </div>
          </div>
          <div class="hud-stat-item">
            <div class="text-[10px] text-white/45">
              存活
            </div>
            <div class="mt-0.5 text-sm font-semibold text-white">
              {{ room.gamePublic?.players?.filter(p => p.isAlive).length ?? room.roomState.members.filter(m => m.isAlive).length }}
            </div>
          </div>
          <div class="hud-stat-item">
            <div class="text-[10px] text-white/45">
              连接
            </div>
            <div
              class="mt-0.5 text-sm font-semibold"
              :class="connected ? 'text-emerald-300' : 'text-red-300'"
            >
              {{ connected ? '在线' : '重连中' }}
            </div>
          </div>
        </div>

        <div
          v-if="room.toasts.length"
          class="mb-3 space-y-2"
        >
          <div
            v-for="t in room.toasts"
            :key="t.id"
            class="rounded-lg border px-3 py-2 text-xs"
            :class="t.type === 'error' ? 'border-red-500/30 bg-red-500/10 text-red-200' : 'border-white/10 bg-white/5 text-white/80'"
          >
            {{ t.message }}
          </div>
        </div>

        <div
          v-if="!room.roomState"
          class="hud-inline-panel p-4 text-sm text-white/70"
        >
          正在进入房间…
        </div>

        <template v-else>
          <!-- ==== 玩家座位区 ==== -->
          <section class="hud-players-section mb-4 overflow-hidden">
            <div class="hud-section-head flex items-center justify-between px-3.5 py-2.5">
              <span class="text-sm font-semibold text-white/90">玩家席位</span>
              <span class="text-[11px] text-white/45">点击查看状态</span>
            </div>
            <div class="player-arena p-2.5 sm:p-3">
              <div class="seat-theater">
                <div class="seat-rail seat-rail--left">
                  <div
                    v-for="m in leftMembers"
                    :key="`left-${m.seat}`"
                    class="seat-chip"
                    :class="{
                      'seat-chip--empty': !m.user,
                      'seat-chip--dead': m.user && isSeatDead(m.seat),
                      'seat-chip--speaking': room.gamePublic?.activeSpeakerSeat === m.seat,
                      'seat-chip--me': room.gamePrivate?.seat === m.seat,
                      'seat-chip--wolf': isWolfAllySeat(m.seat)
                    }"
                  >
                    <div class="seat-chip-avatar-wrap">
                      <div
                        v-if="isSpeechPhase && room.gamePublic?.activeSpeakerSeat === m.seat"
                        class="speaker-float-badge"
                      >
                        <span class="speaker-float-dot" />
                        <span>发言</span>
                      </div>
                      <div class="seat-chip-no">
                        {{ m.seat }}
                      </div>
                      <div class="seat-chip-avatar">
                        <span v-if="m.user">{{ m.user.nickname?.slice(0, 1).toUpperCase() }}</span>
                        <span
                          v-else
                          class="text-white/20 text-sm"
                        >?</span>
                      </div>
                      <div
                        v-if="m.isReady && room.roomState?.status === 'waiting'"
                        class="seat-chip-badge seat-chip-badge--ready"
                      >
                        备
                      </div>
                      <div
                        v-if="room.gamePublic?.sheriffSeat === m.seat"
                        class="seat-chip-badge seat-chip-badge--sheriff"
                      >
                        警
                      </div>
                      <div
                        v-if="isWolfAllySeat(m.seat)"
                        class="seat-chip-badge seat-chip-badge--wolf"
                      >
                        狼
                      </div>
                      <div
                        v-if="m.user && isSeatDead(m.seat)"
                        class="seat-chip-dead-overlay"
                      />
                      <div
                        v-if="m.user && isSeatDead(m.seat)"
                        class="seat-chip-dead-tag"
                      >
                        已死亡
                      </div>
                    </div>
                    <div
                      class="seat-chip-name"
                      :class="{ 'seat-chip-name--dead': m.user && isSeatDead(m.seat) }"
                    >
                      {{ m.user ? m.user.nickname : '空位' }}
                    </div>
                    <div
                      v-if="(m as any).isBot"
                      class="seat-chip-bot"
                    >
                      BOT
                    </div>
                  </div>
                </div>

                <div class="seat-stage">
                  <div class="seat-stage-card">
                    <div class="seat-stage-top">
                      <span class="seat-stage-title">发言舞台</span>
                      <span class="seat-stage-phase">{{ phaseLabel }}</span>
                    </div>
                    <div class="seat-stage-avatar-wrap">
                      <div
                        v-if="activeSpeakerMember?.user"
                        class="seat-stage-avatar"
                      >
                        {{ activeSpeakerMember.user.nickname?.slice(0, 1).toUpperCase() }}
                      </div>
                      <div
                        v-else
                        class="seat-stage-avatar seat-stage-avatar--idle"
                      >
                        ?
                      </div>
                    </div>
                    <div class="seat-stage-name">
                      <template v-if="activeSpeakerMember?.user">
                        {{ activeSpeakerMember.seat }}号 {{ activeSpeakerMember.user.nickname }}
                      </template>
                      <template v-else>
                        暂无发言玩家
                      </template>
                    </div>
                    <div class="seat-stage-sub">
                      {{ isSpeechPhase ? '轮流发言中' : '等待发言阶段' }}
                    </div>
                    <div
                      v-if="isSpeechPhase"
                      class="seat-stage-feed"
                    >
                      <template v-if="stagePublicMessages.length">
                        <div
                          v-for="m in stagePublicMessages"
                          :key="`stage-${m.id}`"
                          class="seat-stage-feed-item"
                        >
                          <span class="seat-stage-feed-sender">{{ m.sender.nickname }}:</span>
                          <span class="seat-stage-feed-text">{{ m.text }}</span>
                        </div>
                      </template>
                      <div
                        v-else
                        class="seat-stage-feed-empty"
                      >
                        暂无发言内容
                      </div>
                    </div>
                    <div
                      v-if="room.roomState?.gameId && canUseWolfChannel"
                      class="seat-stage-wolf"
                    >
                      <div class="seat-stage-wolf-head">
                        <span class="seat-stage-wolf-title">狼人频道</span>
                        <span class="seat-stage-wolf-badge">仅狼队可见</span>
                      </div>
                      <div class="seat-stage-wolf-feed">
                        <template v-if="stageWolfMessages.length">
                          <div
                            v-for="m in stageWolfMessages"
                            :key="`wolf-${m.id}`"
                            class="seat-stage-wolf-item"
                          >
                            <span class="seat-stage-wolf-sender">{{ m.sender.nickname }}:</span>
                            <span class="seat-stage-wolf-text">{{ m.text }}</span>
                          </div>
                        </template>
                        <div
                          v-else
                          class="seat-stage-wolf-empty"
                        >
                          暂无狼人消息
                        </div>
                      </div>
                      <div class="seat-stage-wolf-input-wrap">
                        <input
                          v-model="wolfChatText"
                          class="seat-stage-wolf-input"
                          placeholder="发送狼人私聊..."
                          @keyup.enter="sendWolfChat"
                        >
                        <button
                          class="seat-stage-wolf-send"
                          :disabled="!wolfChatText.trim()"
                          @click="sendWolfChat"
                        >
                          发送
                        </button>
                      </div>
                    </div>
                    <div
                      v-if="isSpeechPhase"
                      class="seat-stage-actions"
                    >
                      <button
                        v-if="room.gamePublic?.activeSpeakerSeat === meSeat"
                        class="game-btn-primary seat-stage-btn"
                        @click="submitAction('game.nextSpeaker', {})"
                      >
                        结束发言
                      </button>
                      <div
                        v-else
                        class="seat-stage-listen"
                      >
                        正在倾听 {{ room.gamePublic?.activeSpeakerSeat }} 号玩家发言
                      </div>
                    </div>
                    <div
                      v-if="isSpeechPhase"
                      class="seat-stage-voice"
                    >
                      <div class="seat-stage-voice-head">
                        <span class="seat-stage-voice-title">实时语音</span>
                        <span class="seat-stage-voice-state">{{ voiceRtc.statusText.value }}</span>
                      </div>
                      <div class="seat-stage-voice-row">
                        <button
                          class="seat-stage-voice-btn"
                          :class="{ 'seat-stage-voice-btn--on': voiceRtc.micEnabled.value }"
                          :disabled="!canUseVoiceMic && !voiceRtc.micEnabled.value"
                          @click="toggleVoiceMic"
                        >
                          {{ voiceRtc.micEnabled.value ? '关闭麦克风' : '开启麦克风' }}
                        </button>
                        <button
                          v-if="voiceRtc.pendingPlayback.value && !voiceRtc.audioUnlocked.value"
                          class="seat-stage-voice-aux"
                          @click="unlockVoicePlayback"
                        >
                          解锁收听
                        </button>
                        <button
                          v-else-if="voiceRtc.errorText.value"
                          class="seat-stage-voice-aux"
                          @click="retryVoiceConnection"
                        >
                          重试连接
                        </button>
                      </div>
                      <div class="seat-stage-voice-tip">
                        <template v-if="voiceRtc.errorText.value">
                          {{ voiceRtc.errorText.value }}
                        </template>
                        <template v-else-if="voiceRtc.pendingPlayback.value && !voiceRtc.audioUnlocked.value">
                          点击任意区域或“解锁收听”以播放队友语音
                        </template>
                        <template v-else-if="voiceRtc.connectedPeers.value > 0">
                          已建立 {{ voiceRtc.connectedPeers.value }} 路语音连接
                        </template>
                        <template v-else>
                          {{ canUseVoiceMic || voiceRtc.micEnabled.value ? '语音连接等待中' : voiceMicLockReason }}
                        </template>
                      </div>
                    </div>
                    <div
                      v-if="isSpeechPhase && canSpeakInPublic"
                      class="seat-stage-input-wrap"
                    >
                      <input
                        v-model="chatText"
                        class="seat-stage-input"
                        :disabled="!canSpeakInPublic"
                        :placeholder="canSpeakInPublic ? '在舞台发送发言...' : (publicChatLockReason || '未轮到你发言')"
                        @keyup.enter="sendChat"
                      >
                      <button
                        class="seat-stage-send"
                        :disabled="!canSpeakInPublic || !chatText.trim()"
                        @click="sendChat"
                      >
                        发送
                      </button>
                    </div>
                  </div>
                </div>

                <div class="seat-rail seat-rail--right">
                  <div
                    v-for="m in rightMembers"
                    :key="`right-${m.seat}`"
                    class="seat-chip"
                    :class="{
                      'seat-chip--empty': !m.user,
                      'seat-chip--dead': m.user && isSeatDead(m.seat),
                      'seat-chip--speaking': room.gamePublic?.activeSpeakerSeat === m.seat,
                      'seat-chip--me': room.gamePrivate?.seat === m.seat,
                      'seat-chip--wolf': isWolfAllySeat(m.seat)
                    }"
                  >
                    <div class="seat-chip-avatar-wrap">
                      <div
                        v-if="isSpeechPhase && room.gamePublic?.activeSpeakerSeat === m.seat"
                        class="speaker-float-badge"
                      >
                        <span class="speaker-float-dot" />
                        <span>发言</span>
                      </div>
                      <div class="seat-chip-no">
                        {{ m.seat }}
                      </div>
                      <div class="seat-chip-avatar">
                        <span v-if="m.user">{{ m.user.nickname?.slice(0, 1).toUpperCase() }}</span>
                        <span
                          v-else
                          class="text-white/20 text-sm"
                        >?</span>
                      </div>
                      <div
                        v-if="m.isReady && room.roomState?.status === 'waiting'"
                        class="seat-chip-badge seat-chip-badge--ready"
                      >
                        备
                      </div>
                      <div
                        v-if="room.gamePublic?.sheriffSeat === m.seat"
                        class="seat-chip-badge seat-chip-badge--sheriff"
                      >
                        警
                      </div>
                      <div
                        v-if="isWolfAllySeat(m.seat)"
                        class="seat-chip-badge seat-chip-badge--wolf"
                      >
                        狼
                      </div>
                      <div
                        v-if="m.user && isSeatDead(m.seat)"
                        class="seat-chip-dead-overlay"
                      />
                      <div
                        v-if="m.user && isSeatDead(m.seat)"
                        class="seat-chip-dead-tag"
                      >
                        已死亡
                      </div>
                    </div>
                    <div
                      class="seat-chip-name"
                      :class="{ 'seat-chip-name--dead': m.user && isSeatDead(m.seat) }"
                    >
                      {{ m.user ? m.user.nickname : '空位' }}
                    </div>
                    <div
                      v-if="(m as any).isBot"
                      class="seat-chip-bot"
                    >
                      BOT
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <!-- ==== HUD 分段信息区 ==== -->
          <section class="mb-4">
            <div class="hud-info-panel">
            <!-- 身份卡 -->
            <div class="identity-card hud-info-section">
              <div class="identity-card-header">
                <div class="flex items-center justify-between gap-2">
                  <div class="flex items-center gap-3 min-w-0">
                    <div
                      class="identity-icon"
                      :class="getRoleClass(room.gamePrivate?.role)"
                    >
                      {{ getRoleIcon(room.gamePrivate?.role) }}
                    </div>
                    <div class="min-w-0">
                      <div class="text-xs text-white/55 uppercase tracking-wider">
                        我的身份
                      </div>
                      <div class="truncate text-xl font-bold text-white">
                        {{ myRoleLabel || '未分配' }}
                      </div>
                    </div>
                  </div>
                  <button
                    class="panel-toggle-btn"
                    :aria-expanded="showIdentityPanel ? 'true' : 'false'"
                    @click="togglePanel('identity')"
                  >
                    <svg
                      class="h-4 w-4 transition-transform duration-200"
                      :class="showIdentityPanel ? 'rotate-180' : ''"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M19 9l-7 7-7-7"
                      />
                    </svg>
                  </button>
                </div>
              </div>
              <div
                v-show="showIdentityPanel"
                class="identity-card-body"
              >
                <p
                  v-if="room.gamePrivate?.role === 'werewolf'"
                  class="text-red-300/90"
                >
                  你是狼人。每晚与同伴商议并选择击杀目标。白天请隐藏身份。
                </p>
                <div
                  v-if="room.gamePrivate?.wolfTeam?.length"
                  class="mt-2 rounded-lg border border-red-500/25 bg-red-500/10 p-2.5"
                >
                  <div class="mb-1 text-xs text-red-300/80">
                    狼人同伴
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <span
                      v-for="w in room.gamePrivate.wolfTeam"
                      :key="w.seat"
                      class="rounded px-2 py-1 text-sm"
                      :class="w.isAlive ? 'bg-red-500/20 text-red-200' : 'bg-gray-500/20 text-gray-300 line-through'"
                    >
                      {{ w.seat }}号 {{ w.nickname }}
                    </span>
                  </div>
                </div>
                <p
                  v-else-if="room.gamePrivate?.role === 'seer'"
                  class="text-violet-300/90"
                >
                  你是预言家。每晚可以查验一人的身份（好人/狼人）。
                </p>
                <p
                  v-else-if="room.gamePrivate?.role === 'witch'"
                  class="text-emerald-300/90"
                >
                  你是女巫。拥有一瓶解药和一瓶毒药，每种可用一次。
                </p>
                <p
                  v-else-if="room.gamePrivate?.role === 'guard'"
                  class="text-blue-300/90"
                >
                  你是守卫。每晚守护一人免受狼人袭击，不可连续守同一人。
                </p>
                <p
                  v-else-if="room.gamePrivate?.role === 'hunter'"
                  class="text-orange-300/90"
                >
                  你是猎人。死后可开枪带走一人（被毒死除外）。
                </p>
                <p
                  v-else-if="room.gamePrivate?.role === 'villager'"
                  class="text-amber-300/90"
                >
                  你是村民。白天根据线索参与讨论和投票。
                </p>
                <p
                  v-else
                  class="text-white/55"
                >
                  等待游戏开始分配身份...
                </p>
              </div>
            </div>

            <!-- 局势记录 -->
            <div class="game-log-card hud-info-section">
              <div class="game-log-header">
                <div class="min-w-0">
                  <div class="text-sm font-semibold text-white/90">
                    局势记录
                  </div>
                  <div class="text-xs text-white/55">
                    第 {{ room.gamePublic?.dayNo ?? 0 }} 天 · {{ room.gamePublic?.publicLog?.length ?? 0 }} 条
                  </div>
                </div>
                <button
                  class="panel-toggle-btn"
                  :aria-expanded="showLogPanel ? 'true' : 'false'"
                  @click="togglePanel('log')"
                >
                  <svg
                    class="h-4 w-4 transition-transform duration-200"
                    :class="showLogPanel ? 'rotate-180' : ''"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M19 9l-7 7-7-7"
                    />
                  </svg>
                </button>
              </div>
              <div
                v-show="showLogPanel"
                class="game-log-body"
              >
                <div
                  v-if="room.gamePublic?.publicLog?.length"
                  class="space-y-2"
                >
                  <div
                    v-for="log in room.gamePublic.publicLog.slice(-20)"
                    :key="log.id"
                    class="log-entry"
                  >
                    <span class="log-time">{{ new Date(log.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</span>
                    <span class="log-text">{{ log.text }}</span>
                  </div>
                </div>
                <div
                  v-else
                  class="py-5 text-center text-sm text-white/45"
                >
                  暂无记录
                </div>
              </div>
            </div>

            </div>
          </section>


          <div
            v-if="room.roomState.status === 'waiting'"
            class="mt-4 space-y-4"
          >
            <!-- 房主配置面板 -->
            <div
              v-if="isOwner"
              class="game-card hud-config-panel overflow-hidden"
            >
              <div class="game-card-header hud-section-head flex items-center gap-2">
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
                        <span class="w-6 h-6 rounded-md bg-gradient-to-br from-red-500 to-red-700 flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0">狼</span>
                        <span class="text-xs text-white/80">狼人</span>
                      </div>
                      <input
                        v-model.number="localRoleConfig.werewolf"
                        type="number"
                        min="1"
                        max="5"
                        class="game-input-small"
                      >
                    </div>
                    <div class="role-config-item">
                      <div class="flex items-center gap-2">
                        <span class="w-6 h-6 rounded-md bg-gradient-to-br from-violet-500 to-violet-700 flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0">预</span>
                        <span class="text-xs text-white/80">预言家</span>
                      </div>
                      <input
                        v-model.number="localRoleConfig.seer"
                        type="number"
                        min="0"
                        max="1"
                        class="game-input-small"
                      >
                    </div>
                    <div class="role-config-item">
                      <div class="flex items-center gap-2">
                        <span class="w-6 h-6 rounded-md bg-gradient-to-br from-emerald-500 to-emerald-700 flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0">巫</span>
                        <span class="text-xs text-white/80">女巫</span>
                      </div>
                      <input
                        v-model.number="localRoleConfig.witch"
                        type="number"
                        min="0"
                        max="1"
                        class="game-input-small"
                      >
                    </div>
                    <div class="role-config-item">
                      <div class="flex items-center gap-2">
                        <span class="w-6 h-6 rounded-md bg-gradient-to-br from-orange-500 to-orange-700 flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0">猎</span>
                        <span class="text-xs text-white/80">猎人</span>
                      </div>
                      <input
                        v-model.number="localRoleConfig.hunter"
                        type="number"
                        min="0"
                        max="1"
                        class="game-input-small"
                      >
                    </div>
                    <div class="role-config-item">
                      <div class="flex items-center gap-2">
                        <span class="w-6 h-6 rounded-md bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0">守</span>
                        <span class="text-xs text-white/80">守卫</span>
                      </div>
                      <input
                        v-model.number="localRoleConfig.guard"
                        type="number"
                        min="0"
                        max="1"
                        class="game-input-small"
                      >
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
                        <span class="w-6 h-6 rounded-md bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0">夜</span>
                        <span class="text-xs text-white/80">夜晚</span>
                      </div>
                      <input
                        v-model.number="localTimers.nightSeconds"
                        type="number"
                        min="10"
                        max="180"
                        class="game-input-small"
                      >
                    </div>
                    <div class="role-config-item">
                      <div class="flex items-center gap-2">
                        <span class="w-6 h-6 rounded-md bg-gradient-to-br from-cyan-500 to-cyan-700 flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0">言</span>
                        <span class="text-xs text-white/80">发言</span>
                      </div>
                      <input
                        v-model.number="localTimers.daySpeechSeconds"
                        type="number"
                        min="10"
                        max="300"
                        class="game-input-small"
                      >
                    </div>
                    <div class="role-config-item">
                      <div class="flex items-center gap-2">
                        <span class="w-6 h-6 rounded-md bg-gradient-to-br from-amber-500 to-amber-700 flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0">票</span>
                        <span class="text-xs text-white/80">投票</span>
                      </div>
                      <input
                        v-model.number="localTimers.dayVoteSeconds"
                        type="number"
                        min="10"
                        max="180"
                        class="game-input-small"
                      >
                    </div>
                    <div class="role-config-item">
                      <div class="flex items-center gap-2">
                        <span class="w-6 h-6 rounded-md bg-gradient-to-br from-pink-500 to-pink-700 flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0">算</span>
                        <span class="text-xs text-white/80">结算</span>
                      </div>
                      <input
                        v-model.number="localTimers.settlementSeconds"
                        type="number"
                        min="5"
                        max="120"
                        class="game-input-small"
                      >
                    </div>
                  </div>
                </div>

                <button
                  class="game-btn-action w-full"
                  @click="emitConfig"
                >
                  保存配置
                </button>

                <button
                  v-if="room.roomState.members.some(m => !m.user)"
                  class="w-full rounded-lg border border-emerald-500/30 bg-emerald-600/10 px-4 py-2.5 text-sm text-emerald-300 transition-all hover:bg-emerald-600/20"
                  @click="addBot"
                >
                  添加机器人
                </button>
              </div>
            </div>

            <!-- 底部操作栏 - 等待状态 -->
            <div class="bottom-action-bar">
              <div class="hud-bottom-shell mx-auto w-full max-w-none space-y-2.5 md:max-w-[720px] lg:max-w-[900px]">
                <div class="action-dock-meta">
                  <span class="action-phase-chip">等待开局</span>
                  <span class="text-xs text-white/60">
                    准备人数 {{ room.roomState.members.filter(m => m.isReady).length }}/{{ room.roomState.maxPlayers }}
                  </span>
                </div>
                <div class="bottom-bubble-row">
                  <button
                    class="bottom-bubble-btn"
                    :class="meReady ? 'bottom-bubble-btn--ready' : ''"
                    @click="setReady(!meReady)"
                  >
                    <span class="bottom-bubble-label">{{ meReady ? '取消' : '准备' }}</span>
                  </button>
                  <button
                    v-if="isOwner"
                    class="bottom-bubble-btn bottom-bubble-btn--start"
                    @click="startGame"
                  >
                    <span class="bottom-bubble-label">开局</span>
                  </button>
                  <div
                    v-else
                    class="bottom-bubble-btn bottom-bubble-btn--disabled"
                  >
                    <span class="bottom-bubble-label">等待</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div
            v-else-if="room.gamePublic?.phase !== 'game_over' && !isSpeechPhase"
            class="mt-3 space-y-3"
          >
            <div class="action-dock">
              <div class="action-dock-shell">
                <div class="action-dock-meta">
                  <div class="flex items-center gap-2">
                    <span class="action-phase-chip">{{ phaseLabel }}</span>
                    <span
                      v-if="room.gamePublic?.phase === 'night' && activeRoleLabel"
                      class="action-role-chip"
                    >
                      当前行动：{{ activeRoleLabel }}
                    </span>
                  </div>
                  <span class="action-timer-chip">
                    {{ Math.max(0, secondsLeft) }}s
                  </span>
                </div>
                <div class="action-skill-zone">
                  <!-- ===== 夜晚行动区 ===== -->
                  <div v-if="room.gamePublic?.phase === 'night'">
                    <!-- 狼人 -->
                    <div
                      v-if="room.gamePrivate?.role === 'werewolf' && room.gamePublic?.activeRole === 'werewolf'"
                      class="grid grid-cols-3 gap-2"
                    >
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
                    <div
                      v-if="room.gamePrivate?.role === 'seer' && room.gamePublic?.activeRole === 'seer'"
                      class="space-y-3"
                    >
                      <div
                        v-if="latestSeerInfo"
                        class="rounded-lg border border-violet-500/30 bg-violet-500/20 p-3 text-center text-sm font-bold text-violet-200 shadow-[0_0_15px_rgba(139,92,246,0.2)]"
                      >
                        {{ latestSeerInfo }}
                      </div>
                      <div
                        v-if="!room.gamePrivate?.selectedTargetSeat"
                        class="grid grid-cols-3 gap-2"
                      >
                        <button
                          v-for="s in aliveSeats.filter(x => x !== meSeat)"
                          :key="`s-${s}`"
                          class="rounded-lg border border-white/10 bg-white/5 px-2 py-3 text-sm text-white/70 hover:bg-white/10"
                          @click="submitAction('night.seerCheck', { targetSeat: s })"
                        >
                          查验 {{ s }}
                        </button>
                      </div>
                      <div
                        v-else
                        class="text-center text-sm text-white/50"
                      >
                        已选择目标，请等待...
                      </div>
                    </div>

                    <!-- 女巫 -->
                    <template v-if="room.gamePrivate?.role === 'witch' && room.gamePublic?.activeRole === 'witch'">
                      <!-- 阶段1：解药 -->
                      <div
                        v-if="witchActionStep === 'save'"
                        class="space-y-3"
                      >
                        <div
                          v-if="room.gamePrivate.witchInfo?.nightVictimSeat"
                          class="rounded-lg border border-red-500/30 bg-red-500/20 p-3 text-center text-sm font-bold text-red-200"
                        >
                          昨晚 {{ room.gamePrivate.witchInfo.nightVictimSeat }} 号倒牌
                        </div>
                        <div
                          v-else
                          class="text-center text-sm text-white/60 py-2"
                        >
                          昨晚平安夜（或无法获知）
                        </div>

                        <div
                          v-if="room.gamePrivate.witchInfo?.nightVictimSeat && !room.gamePrivate.witchInfo?.saveUsed"
                          class="grid grid-cols-2 gap-3"
                        >
                          <button
                            class="game-btn-action bg-emerald-600/20 text-emerald-400 border-emerald-500/50"
                            @click="submitAction('night.witch.save', { use: true }); witchActionStep = 'poison'"
                          >
                            使用解药
                          </button>
                          <button
                            class="game-btn-secondary"
                            @click="submitAction('night.witch.save', { use: false }); witchActionStep = 'poison'"
                          >
                            不使用
                          </button>
                        </div>
                        <div
                          v-else
                          class="text-center"
                        >
                          <button
                            class="game-btn-secondary w-full"
                            @click="witchActionStep = 'poison'"
                          >
                            进入毒药阶段
                          </button>
                        </div>
                      </div>

                      <!-- 阶段2：毒药 -->
                      <div
                        v-else-if="witchActionStep === 'poison'"
                        class="space-y-3"
                      >
                        <div class="text-center text-sm text-white/80">
                          是否使用毒药？
                        </div>
                        <div
                          v-if="!room.gamePrivate.witchInfo?.poisonUsed"
                          class="grid grid-cols-3 gap-2"
                        >
                          <button
                            v-for="s in aliveSeats.filter(x => x !== meSeat)"
                            :key="`p-${s}`"
                            class="rounded-lg border border-white/10 bg-white/5 px-2 py-3 text-sm text-white/70 hover:bg-violet-500/20 hover:border-violet-500/50"
                            @click="submitAction('night.witch.poison', { targetSeat: s })"
                          >
                            毒 {{ s }}
                          </button>
                        </div>
                        <button
                          class="game-btn-secondary w-full"
                          @click="submitAction('night.witch.poison', { targetSeat: null })"
                        >
                          不使用毒药 (结束)
                        </button>
                      </div>
                    </template>

                    <!-- 守卫 -->
                    <div
                      v-if="room.gamePrivate?.role === 'guard' && room.gamePublic?.activeRole === 'guard'"
                      class="grid grid-cols-3 gap-2"
                    >
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
                        class="col-span-3 game-btn-secondary"
                        :disabled="room.gamePrivate?.selectedTargetSeat != null"
                        @click="submitAction('night.guardProtect', { targetSeat: 0 })"
                      >
                        空守
                      </button>
                    </div>
                  </div>

                  <!-- ===== 白天投票区 ===== -->
                  <div
                    v-else-if="room.gamePublic?.phase === 'day_vote'"
                    class="grid grid-cols-3 gap-2"
                  >
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
                      class="col-span-3 game-btn-secondary"
                      :disabled="room.gamePrivate?.selectedTargetSeat !== undefined"
                      @click="submitAction('day.vote', { targetSeat: null })"
                    >
                      弃票
                    </button>
                  </div>

                  <!-- ===== 竞选警长 ===== -->
                  <div
                    v-else-if="room.gamePublic?.phase === 'sheriff_election'"
                    class="flex flex-col gap-2"
                  >
                    <button
                      class="game-btn-primary"
                      @click="submitAction('sheriff.enroll', {})"
                    >
                      我要上警
                    </button>
                    <button
                      class="game-btn-secondary"
                      @click="submitAction('sheriff.quit', {})"
                    >
                      放弃
                    </button>
                  </div>

                  <!-- ===== 发言阶段 ===== -->
                  <div
                    v-else-if="['sheriff_speech', 'day_speech'].includes(room.gamePublic?.phase || '')"
                    class="flex flex-col items-center justify-center py-2"
                  >
                    <div class="text-center text-xs text-white/55">
                      发言操作已集成到玩家席位中间舞台
                    </div>
                  </div>
              
                  <!-- ===== 警长投票 ===== -->
                  <div
                    v-else-if="room.gamePublic?.phase === 'sheriff_vote'"
                    class="grid grid-cols-3 gap-2"
                  >
                    <button
                      v-for="s in room.gamePublic?.players?.filter(p => p.isAlive) || []"
                      :key="`sv-${s.seat}`"
                      class="rounded-lg border px-2 py-3 text-sm border-white/10 bg-white/5 text-white/70 hover:bg-white/10"
                      @click="submitAction('sheriff.vote', { targetSeat: s.seat })"
                    >
                      投 {{ s.seat }}
                    </button>
                    <button
                      class="col-span-3 game-btn-secondary"
                      @click="submitAction('sheriff.vote', { targetSeat: null })"
                    >
                      弃权
                    </button>
                  </div>

                  <!-- ===== 猎人/结算 ===== -->
                  <div
                    v-else-if="room.gamePublic?.phase === 'settlement'"
                    class="grid grid-cols-2 gap-2"
                  >
                    <template v-if="room.gamePrivate?.actions?.hunterShoot">
                      <div class="col-span-2 text-center text-orange-400 font-bold mb-2">
                        你是猎人，请选择带走目标
                      </div>
                      <button
                        v-for="s in aliveSeats.filter(x => x !== meSeat)"
                        :key="`h-${s}`"
                        class="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-3 text-sm text-red-200"
                        @click="submitAction('settlement.hunterShoot', { targetSeat: s })"
                      >
                        带走 {{ s }}
                      </button>
                      <button
                        class="col-span-2 game-btn-secondary"
                        @click="submitAction('settlement.hunterShoot', { targetSeat: null })"
                      >
                        不开枪
                      </button>
                    </template>
                    <div
                      v-else
                      class="col-span-2 text-center text-white/50 py-2"
                    >
                      等待结算…
                    </div>
                  </div>

                  <div
                    v-else
                    class="text-center text-white/40 text-xs py-2"
                  >
                    (观察阶段)
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div
            v-else-if="room.gamePublic?.phase === 'game_over'"
            class="mt-3"
          >
            <div class="hud-end-panel p-4 text-center">
              <div class="text-sm font-semibold text-red-200">
                本局已结束
              </div>
              <div class="mt-1 text-xs text-red-200/80">
                可继续查看日志与席位信息，或退出返回大厅
              </div>
              <button
                class="mt-3 h-11 min-w-[120px] rounded-xl border border-white/15 bg-white/10 px-4 text-sm text-white transition-all duration-200 hover:bg-white/15 active:scale-[0.98]"
                @click="leaveRoom"
              >
                返回大厅
              </button>
            </div>
          </div>
        </template>
        </div>
      </div>
    </main>

    <!-- 机器人确认弹窗 -->
    <div
      v-if="showBotConfirm"
      class="fixed inset-0 z-50 flex items-center justify-center"
    >
      <!-- 遮罩 -->
      <div
        class="absolute inset-0 bg-black/60 backdrop-blur-sm"
        @click="cancelBotConfirm"
      />
      
      <!-- 弹窗内容 -->
      <div class="relative w-full max-w-[320px] mx-4 rounded-2xl border border-white/20 bg-gradient-to-b from-[#1a233b] to-[#0b1020] p-5 shadow-2xl">
        <div class="mb-4 text-center">
          <div class="text-lg font-bold text-white">
            人数不足
          </div>
          <div class="mt-2 text-sm text-white/60">
            当前还需要 <span class="text-violet-400 font-bold">{{ neededBots }}</span> 名玩家
          </div>
        </div>
        
        <div class="mb-6 rounded-lg border border-white/10 bg-white/5 p-4 text-center">
          <div class="text-sm text-white/70">
            是否添加机器人玩家？
          </div>
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
/* ===== Stars ===== */
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

/* ===== Particles ===== */
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
  0%, 100% { transform: translateY(0) translateX(0) scale(1); opacity: 0.15; }
  25% { transform: translateY(-30px) translateX(15px) scale(1.2); opacity: 0.3; }
  50% { transform: translateY(-15px) translateX(-10px) scale(1); opacity: 0.2; }
  75% { transform: translateY(-40px) translateX(8px) scale(1.1); opacity: 0.25; }
}

/* ===== Unified HUD ===== */
.room-top-shell {
  @apply rounded-2xl border border-white/10 backdrop-blur-xl;
  background: linear-gradient(135deg, rgba(10, 15, 26, 0.84), rgba(11, 17, 33, 0.76));
  box-shadow: 0 10px 24px rgba(2, 6, 23, 0.4);
}

.room-hud-shell {
  @apply rounded-3xl border border-white/10 p-2.5 sm:p-3 md:p-4;
  background: linear-gradient(160deg, rgba(19, 30, 52, 0.5), rgba(10, 16, 32, 0.52));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 12px 28px rgba(2, 6, 23, 0.3);
}

.hud-timer-panel {
  @apply rounded-2xl border border-white/10;
  background: linear-gradient(145deg, rgba(26, 35, 59, 0.62), rgba(13, 21, 38, 0.6));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
}

.audio-unlock-banner {
  @apply flex items-center justify-between gap-2 rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2;
}

.audio-unlock-text {
  @apply text-xs text-amber-100/90;
}

.audio-unlock-btn {
  @apply min-h-[36px] min-w-[82px] rounded-lg border border-amber-300/40 bg-amber-400/20 px-2.5
         text-xs font-semibold text-amber-100 transition-all duration-200 hover:bg-amber-400/30;
}

.hud-stats-grid {
  @apply grid grid-cols-3 overflow-hidden rounded-xl border border-white/10 bg-black/20;
}

.hud-stat-item {
  @apply px-3 py-2;
}

.hud-stat-item + .hud-stat-item {
  border-left: 1px solid rgba(255, 255, 255, 0.08);
}

.hud-inline-panel {
  @apply rounded-xl border border-white/10 bg-white/5;
}

.hud-players-section {
  @apply rounded-2xl border border-white/10;
  background: linear-gradient(150deg, rgba(22, 34, 58, 0.6), rgba(13, 21, 38, 0.56));
}

.hud-section-head {
  @apply border-b border-white/10 bg-white/5;
}

.hud-info-panel {
  @apply overflow-hidden rounded-2xl border border-white/10;
  background: linear-gradient(155deg, rgba(20, 32, 55, 0.6), rgba(10, 16, 30, 0.54));
}

.hud-info-section + .hud-info-section {
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.hud-info-section--chat {
  min-height: 290px;
}

.hud-config-panel {
  background: linear-gradient(155deg, rgba(24, 37, 64, 0.62), rgba(12, 20, 37, 0.58));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
}

.hud-bottom-shell {
  @apply rounded-2xl border border-white/10 p-2.5 backdrop-blur-xl;
  background: linear-gradient(180deg, rgba(10, 16, 32, 0.9), rgba(8, 13, 25, 0.88));
  box-shadow: 0 -8px 18px rgba(2, 6, 23, 0.34);
}

.hud-end-panel {
  @apply rounded-2xl border border-red-500/25 bg-red-500/10;
}

/* ===== Buttons ===== */
.game-btn-primary {
  @apply relative overflow-hidden rounded-xl bg-gradient-to-r from-red-600 via-red-500 to-orange-500
         px-6 py-3.5 font-bold text-white shadow-lg transition-all duration-200
         hover:shadow-red-500/40 active:scale-[0.98]
         disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100;
}

.game-btn-primary::before {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.15), transparent);
  transition: left 0.5s;
}

.game-btn-primary:hover::before { left: 100%; }

.game-btn-secondary {
  @apply rounded-xl border border-white/20 bg-white/5 px-4 py-3 text-sm text-white/80
         backdrop-blur-sm transition-all duration-200
         hover:bg-white/10 hover:border-white/30 active:scale-[0.98];
}

.game-btn-action {
  @apply rounded-xl border border-violet-500/30 bg-violet-500/10 px-4 py-3
         text-sm font-medium text-violet-300 transition-all duration-200
         hover:bg-violet-500/20 hover:border-violet-500/50;
}

/* ===== Cards ===== */
.game-card {
  @apply rounded-2xl border border-white/10 bg-transparent shadow-none;
}

.game-card-header {
  @apply border-b border-white/10 bg-white/5 px-4 py-3;
}

/* ===== Bottom Action Bar ===== */
.bottom-action-bar {
  @apply fixed bottom-0 left-0 right-0 z-50 border-0 bg-transparent py-0;
  padding-bottom: calc(var(--safe-bottom) + 0.35rem);
  padding-left: var(--safe-left);
  padding-right: var(--safe-right);
  box-shadow: none;
}

.bottom-bubble-row {
  @apply flex items-end justify-center gap-4 py-1;
}

.bottom-bubble-btn {
  @apply flex h-16 w-16 items-center justify-center rounded-full border border-white/20
         bg-gradient-to-b from-[#334155] to-[#1e293b] text-white shadow-lg transition-all duration-200;
}

.bottom-bubble-btn:hover {
  @apply border-white/40;
  transform: translateY(-1px);
}

.bottom-bubble-btn:active {
  transform: scale(0.97);
}

.bottom-bubble-btn--ready {
  @apply border-emerald-300/55 from-emerald-500 to-emerald-700 text-emerald-100;
}

.bottom-bubble-btn--start {
  @apply h-[72px] w-[72px] border-amber-300/60 from-amber-500 to-orange-600 text-amber-50;
}

.bottom-bubble-btn--disabled {
  @apply border-white/10 from-slate-700 to-slate-800 text-white/45;
}

.bottom-bubble-label {
  @apply text-[12px] font-semibold tracking-wide;
}

.action-dock {
  @apply fixed inset-x-0 bottom-0 z-50;
  padding-bottom: calc(var(--safe-bottom) + 0.35rem);
  padding-left: var(--safe-left);
  padding-right: var(--safe-right);
}

.action-dock-shell {
  @apply mx-auto w-full max-w-none rounded-2xl border border-white/10 px-3 py-3 backdrop-blur-xl;
  background: linear-gradient(180deg, rgba(11, 16, 32, 0.9), rgba(8, 13, 25, 0.88));
  box-shadow: 0 -8px 18px rgba(2, 6, 23, 0.34);
}

.action-dock-meta {
  @apply mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white/5 px-2.5 py-2;
}

.action-phase-chip {
  @apply inline-flex items-center rounded-md bg-violet-500/15 px-2 py-1 text-xs font-semibold text-violet-200;
}

.action-role-chip {
  @apply inline-flex items-center rounded-md bg-indigo-500/15 px-2 py-1 text-xs font-semibold text-indigo-200;
}

.action-timer-chip {
  @apply inline-flex items-center rounded-md border border-white/15 bg-black/30 px-2 py-1 text-xs font-semibold text-white/85;
}

.action-skill-zone {
  @apply rounded-xl bg-black/20 p-2.5;
}

.action-skill-zone button {
  min-height: 44px;
}

/* ===== Inputs ===== */
.game-input {
  @apply w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3
         text-sm text-white placeholder-white/30 outline-none
         transition-all duration-200
         focus:border-violet-500/50 focus:bg-white/10 focus:ring-2 focus:ring-violet-500/20;
}

.game-input-small {
  @apply w-16 rounded-lg border border-white/10 bg-black/30 px-2 py-1.5
         text-center text-sm text-white outline-none
         transition-all duration-200
         focus:border-violet-500/50 focus:bg-black/40;
}

/* ===== Role Config ===== */
.role-config-item {
  @apply flex items-center justify-between rounded-xl border border-white/10
         bg-gradient-to-r from-white/5 to-transparent p-3 transition-all duration-200
         hover:border-white/20 hover:from-white/10;
}

/* ===== Radial Gradient ===== */
.bg-gradient-radial {
  background: radial-gradient(circle, var(--tw-gradient-stops));
}

/* ===== Player Arena ===== */
.player-arena {
  perspective: 1000px;
}

.seat-theater {
  @apply grid items-stretch gap-2;
  grid-template-columns: minmax(80px, 92px) minmax(0, 1fr) minmax(80px, 92px);
}

.seat-rail {
  @apply flex min-h-[220px] flex-col gap-2;
}

.seat-chip {
  @apply relative flex flex-col items-center rounded-xl border border-white/10 bg-white/5 px-1.5 py-2;
  transition: border-color 200ms ease, background-color 200ms ease;
  min-height: 84px;
}

.seat-chip--empty {
  opacity: 0.35;
}

.seat-chip--dead {
  @apply border-red-500/70 bg-red-500/20;
}

.seat-chip--dead .seat-chip-avatar {
  @apply border-red-300/70 from-red-900/70 to-red-950/80;
}

.seat-chip--dead .seat-chip-no {
  @apply bg-red-700;
}

.seat-chip--wolf {
  @apply border-red-500/40 bg-red-500/10;
}

.seat-chip--me {
  @apply ring-1 ring-emerald-400/60 bg-emerald-500/10;
}

.seat-chip--speaking {
  @apply border-violet-400/70 bg-violet-500/15;
  box-shadow: 0 0 14px rgba(139, 92, 246, 0.26);
}

.seat-chip-avatar-wrap {
  @apply relative inline-flex items-center justify-center;
}

.seat-chip-no {
  @apply absolute -left-1 -top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full
         border border-[#0a0f1a] bg-blue-600 text-[10px] font-bold text-white;
}

.seat-chip-avatar {
  @apply flex h-10 w-10 items-center justify-center rounded-full border-2 border-white/20
         bg-gradient-to-br from-slate-700 to-slate-900 text-sm font-bold text-white;
}

.seat-chip-badge {
  @apply absolute z-10 flex h-4 min-w-[16px] items-center justify-center rounded-full px-1
         text-[9px] font-bold;
}

.seat-chip-badge--ready {
  @apply -bottom-1 -right-1 border border-[#0a0f1a] bg-emerald-500 text-white;
}

.seat-chip-badge--sheriff {
  @apply -top-1 -right-1 border border-[#0a0f1a] bg-amber-400 text-black;
}

.seat-chip-badge--wolf {
  @apply -bottom-1 -left-1 border border-[#0a0f1a] bg-red-500 text-white;
}

.seat-chip-dead-overlay {
  @apply absolute inset-0 rounded-full bg-black/65;
}

.seat-chip-dead-tag {
  @apply pointer-events-none absolute -bottom-1 left-1/2 z-20 -translate-x-1/2 rounded-full
         border border-red-200/60 bg-red-600 px-1.5 py-[1px] text-[9px] font-bold text-white;
  line-height: 1.1;
  letter-spacing: 0.02em;
  box-shadow: 0 2px 6px rgba(220, 38, 38, 0.35);
}

.seat-chip-name {
  @apply mt-1 w-full truncate text-center text-[10px] font-medium text-white/85;
  line-height: 1.2;
}

.seat-chip-name--dead {
  @apply text-red-200/95;
  text-decoration: line-through;
  text-decoration-color: rgba(248, 113, 113, 0.95);
  text-decoration-thickness: 1.5px;
}

.seat-chip-bot {
  @apply mt-0.5 text-[9px] uppercase tracking-wide text-violet-300/75;
}

.seat-stage {
  @apply flex min-w-0 items-stretch;
}

.seat-stage-card {
  @apply flex w-full min-w-0 flex-col overflow-hidden rounded-2xl border border-white/10 px-3 py-3;
  background: linear-gradient(155deg, rgba(18, 30, 55, 0.66), rgba(11, 18, 35, 0.62));
}

.seat-stage-top {
  @apply mb-2 flex w-full items-center justify-between gap-2;
}

.seat-stage-title {
  @apply text-xs font-semibold text-white/85;
}

.seat-stage-phase {
  @apply rounded-full border border-violet-400/30 bg-violet-500/15 px-2 py-0.5 text-[10px] text-violet-200;
}

.seat-stage-avatar-wrap {
  @apply mb-2 flex items-center justify-center;
}

.seat-stage-avatar {
  @apply flex h-16 w-16 items-center justify-center rounded-full border-2 border-violet-400/55
         bg-gradient-to-br from-violet-600/35 to-indigo-600/35 text-xl font-bold text-white;
  box-shadow: 0 0 24px rgba(139, 92, 246, 0.2);
}

.seat-stage-avatar--idle {
  @apply border-white/25 from-slate-600/20 to-slate-700/20 text-white/50;
  box-shadow: none;
}

.seat-stage-name {
  @apply w-full truncate text-center text-sm font-semibold text-white;
}

.seat-stage-sub {
  @apply mt-1 text-xs text-white/55;
}

.seat-stage-feed {
  @apply mt-2 flex max-h-28 w-full flex-col gap-1 overflow-y-auto rounded-lg border border-white/10 bg-black/20 p-2;
}

.seat-stage-feed-item {
  @apply rounded-md bg-white/5 px-2 py-1 text-[11px] leading-4 text-white/85;
}

.seat-stage-feed-sender {
  @apply mr-1 font-semibold text-violet-200;
}

.seat-stage-feed-text {
  @apply break-all;
}

.seat-stage-feed-empty {
  @apply text-center text-[11px] text-white/45;
}

.seat-stage-wolf {
  @apply mt-2 rounded-lg border border-red-500/20 bg-red-950/20 px-2.5 py-2;
}

.seat-stage-wolf-head {
  @apply flex items-center justify-between gap-2;
}

.seat-stage-wolf-title {
  @apply text-[11px] font-semibold text-red-100/90;
}

.seat-stage-wolf-badge {
  @apply rounded-full border border-red-400/30 bg-red-500/15 px-1.5 py-0.5 text-[10px] text-red-200;
}

.seat-stage-wolf-feed {
  @apply mt-2 flex max-h-24 w-full flex-col gap-1 overflow-y-auto rounded-lg border border-red-500/20 bg-black/25 p-2;
}

.seat-stage-wolf-item {
  @apply rounded-md bg-red-500/10 px-2 py-1 text-[11px] leading-4 text-red-50/90;
}

.seat-stage-wolf-sender {
  @apply mr-1 font-semibold text-red-200;
}

.seat-stage-wolf-text {
  @apply break-all;
}

.seat-stage-wolf-empty {
  @apply text-center text-[11px] text-red-100/45;
}

.seat-stage-wolf-input-wrap {
  @apply mt-2 flex w-full min-w-0 items-stretch gap-2;
}

.seat-stage-wolf-input {
  @apply min-h-[38px] min-w-0 flex-1 rounded-xl border border-red-500/25 bg-red-950/20 px-3 text-sm text-red-50
         placeholder-red-200/40 outline-none transition-all duration-200 focus:border-red-400/45;
  max-width: 100%;
  box-sizing: border-box;
}

.seat-stage-wolf-send {
  @apply min-h-[38px] min-w-[56px] rounded-xl border border-red-400/40 bg-red-500/20 px-3
         text-sm font-semibold text-red-100 transition-all duration-200 hover:bg-red-500/30;
  flex-shrink: 0;
}

.seat-stage-wolf-send:disabled {
  @apply cursor-not-allowed border-white/10 bg-white/5 text-white/35;
}

.seat-stage-actions {
  @apply mt-2 w-full;
}

.seat-stage-btn {
  @apply h-11 w-full px-3 py-0 text-sm;
}

.seat-stage-listen {
  @apply rounded-lg border border-white/10 bg-white/5 px-2.5 py-2 text-center text-xs text-white/70;
}

.seat-stage-voice {
  @apply mt-2 rounded-lg border border-white/10 bg-black/20 px-2.5 py-2;
}

.seat-stage-voice-head {
  @apply flex items-center justify-between gap-2;
}

.seat-stage-voice-title {
  @apply text-[11px] font-semibold text-white/85;
}

.seat-stage-voice-state {
  @apply rounded-full border border-emerald-400/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-200;
}

.seat-stage-voice-row {
  @apply mt-2 flex items-center gap-2;
}

.seat-stage-voice-btn {
  @apply min-h-[40px] flex-1 rounded-xl border border-white/15 bg-white/10 px-3 text-xs font-semibold text-white/85
         transition-all duration-200 hover:bg-white/15;
}

.seat-stage-voice-btn:disabled {
  @apply cursor-not-allowed border-white/10 bg-white/5 text-white/35;
}

.seat-stage-voice-btn--on {
  @apply border-emerald-400/40 bg-emerald-500/20 text-emerald-100;
}

.seat-stage-voice-aux {
  @apply min-h-[40px] min-w-[78px] rounded-xl border border-violet-400/40 bg-violet-500/20 px-2 text-[11px]
         font-semibold text-violet-100 transition-all duration-200 hover:bg-violet-500/30;
}

.seat-stage-voice-tip {
  @apply mt-2 text-[11px] leading-4 text-white/65;
}

.seat-stage-input-wrap {
  @apply mt-2 flex w-full min-w-0 items-stretch gap-2;
}

.seat-stage-input {
  @apply min-h-[44px] min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-3 text-sm text-white
         placeholder-white/35 outline-none transition-all duration-200 focus:border-violet-500/50;
  max-width: 100%;
  box-sizing: border-box;
}

.seat-stage-input:disabled {
  @apply cursor-not-allowed text-white/45;
}

.seat-stage-send {
  @apply min-h-[44px] min-w-[60px] rounded-xl border border-violet-400/40 bg-violet-500/25 px-3
         text-sm font-semibold text-violet-100 transition-all duration-200 hover:bg-violet-500/35;
  flex-shrink: 0;
}

.seat-stage-send:disabled {
  @apply cursor-not-allowed border-white/10 bg-white/5 text-white/35;
}

.player-card {
  @apply relative flex flex-col items-center justify-center rounded-xl
         border border-white/10 bg-white/5 px-1.5 py-2
         transition-all duration-200 cursor-pointer;
  min-height: 94px;
}

.player-card:active {
  transform: scale(0.96);
}

.player-card:hover {
  border-color: rgba(255, 255, 255, 0.22);
  background: rgba(255, 255, 255, 0.08);
}

.player-card--empty {
  opacity: 0.35;
}

.player-card--dead {
  @apply border-red-500/30 bg-red-500/10;
  filter: grayscale(0.75);
}

.player-card--wolf-ally {
  @apply border-red-500/40 bg-red-500/10;
}

.player-card--speaking {
  z-index: 10;
}

.player-card--me {
  @apply ring-2 ring-emerald-500/60 bg-emerald-500/10 rounded-xl;
}

.speaking-glow {
  @apply absolute inset-0 rounded-xl;
  background: radial-gradient(circle, rgba(139, 92, 246, 0.3) 0%, transparent 70%);
  animation: speakingGlow 1.5s ease-in-out infinite;
}

@keyframes speakingGlow {
  0%, 100% { opacity: 0.5; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.05); }
}

.player-avatar-wrapper {
  @apply relative inline-flex items-center justify-center;
}

.speaker-float-badge {
  @apply absolute z-20 inline-flex items-center gap-1 rounded-full border border-violet-300/45
         bg-[#1d1539]/95 px-2 py-1 text-[10px] font-semibold text-violet-100;
  top: 50%;
  left: calc(100% + 4px);
  transform: translateY(-50%);
  line-height: 1;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: 0 4px 12px rgba(109, 40, 217, 0.35);
}

.seat-rail--right .speaker-float-badge {
  left: auto;
  right: calc(100% + 4px);
}

.speaker-float-dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: #a78bfa;
  box-shadow: 0 0 8px rgba(167, 139, 250, 0.85);
  animation: speakerDotPulse 1.2s ease-in-out infinite;
}

@keyframes speakerDotPulse {
  0%, 100% { opacity: 0.55; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.2); }
}

.player-avatar-inner {
  @apply w-10 h-10 rounded-full flex items-center justify-center
         bg-gradient-to-br from-slate-700 to-slate-900
         border-2 border-white/20 shadow-lg
         text-white font-bold text-sm;
}

.player-card--speaking .player-avatar-inner {
  @apply border-violet-400 shadow-violet-500/30;
  animation: avatarPulse 1.5s ease-in-out infinite;
}

@keyframes avatarPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.4); }
  50% { box-shadow: 0 0 15px 5px rgba(139, 92, 246, 0.2); }
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

.wolf-ally-badge {
  @apply absolute -top-1 -right-1 w-5 h-5 rounded-full
         bg-gradient-to-br from-red-500 to-rose-600
         flex items-center justify-center
         text-[10px] font-bold text-white shadow-lg
         border-2 border-[#0a0f1a] z-10;
}

.death-mark {
  @apply absolute inset-0 flex items-center justify-center
         bg-black/65 rounded-full;
}

.player-name {
  @apply mt-1 text-xs font-medium text-white/90 truncate text-center leading-tight;
  max-width: 100%;
}

.dead-label {
  @apply mt-0.5 rounded-full border border-red-400/50 bg-red-500/10 px-2 py-0.5
         text-[10px] font-semibold tracking-wide text-red-200;
}

.bot-tag {
  @apply text-[9px] text-violet-300/70 font-medium uppercase tracking-wider;
}

/* ===== Identity Card ===== */
.identity-card {
  @apply overflow-hidden rounded-none border-0 bg-transparent shadow-none;
}

.identity-card-header {
  @apply px-3.5 py-3 border-b border-white/10 bg-white/5;
}

.identity-card-body {
  @apply p-3.5 text-sm leading-relaxed;
}

.identity-icon {
  @apply w-11 h-11 rounded-xl flex items-center justify-center text-lg font-bold text-white
         shadow-lg transition-all duration-200;
}

.role-werewolf { @apply bg-gradient-to-br from-red-600 to-red-800; }
.role-seer { @apply bg-gradient-to-br from-violet-600 to-violet-800; }
.role-witch { @apply bg-gradient-to-br from-emerald-600 to-emerald-800; }
.role-guard { @apply bg-gradient-to-br from-blue-600 to-blue-800; }
.role-hunter { @apply bg-gradient-to-br from-orange-600 to-orange-800; }
.role-villager { @apply bg-gradient-to-br from-amber-600 to-amber-800; }
.role-unknown { @apply bg-gradient-to-br from-slate-600 to-slate-800; }

/* ===== Game Log ===== */
.game-log-card {
  @apply overflow-hidden rounded-none border-0 bg-transparent shadow-none;
}

.game-log-header {
  @apply flex items-center justify-between px-3.5 py-3 border-b border-white/10 bg-white/5;
}

.game-log-body {
  @apply max-h-52 overflow-y-auto px-3.5 py-3;
}

.log-entry {
  @apply flex items-start gap-2 text-xs;
}

.log-time {
  @apply text-white/50 font-mono flex-shrink-0;
}

.log-text {
  @apply text-white/75;
}

/* ===== Chat ===== */
.chat-card {
  @apply flex flex-col overflow-hidden rounded-none border-0 bg-transparent shadow-none;
  min-height: 250px;
}

.chat-header {
  @apply flex flex-wrap items-center justify-between gap-2 px-3.5 py-3 border-b border-white/10 bg-white/5;
}

.chat-body {
  @apply flex h-full min-h-[195px] flex-col;
}

.chat-channel-switch {
  @apply flex flex-wrap gap-1 p-1 rounded-lg bg-black/25;
  max-width: min(100%, 180px);
}

.channel-btn {
  @apply min-h-[44px] min-w-[58px] px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-200;
  color: rgba(255,255,255,0.5);
  flex: 1 1 auto;
}

.channel-btn:hover {
  color: rgba(255,255,255,0.8);
}

.channel-btn--active {
  @apply bg-indigo-600 text-white;
  box-shadow: 0 0 8px rgba(99, 102, 241, 0.3);
}

.channel-btn--wolf.channel-btn--active {
  @apply bg-red-600;
  box-shadow: 0 0 8px rgba(239, 68, 68, 0.3);
}

.chat-messages {
  @apply flex-1 overflow-y-auto px-3.5 py-3 space-y-1.5;
  background: linear-gradient(to bottom, transparent, rgba(0,0,0,0.15));
}

.chat-msg {
  @apply text-xs p-2.5 rounded-lg bg-white/5;
}

.chat-msg--wolf {
  @apply bg-red-500/10 border-l-2 border-red-500;
}

.chat-sender {
  @apply font-medium text-white/75 mr-1;
}

.chat-msg--wolf .chat-sender {
  @apply text-red-400;
}

.chat-text {
  @apply text-white/90;
}

.chat-msg--wolf .chat-text {
  @apply text-red-200;
}

.chat-input-area {
  @apply flex gap-2 px-3.5 py-3 border-t border-white/10 bg-black/20;
}

.chat-input {
  @apply flex-1 rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5
         text-sm text-white placeholder-white/30 outline-none
         transition-all duration-200
         focus:border-violet-500/50 focus:bg-white/10;
  min-height: 44px;
  min-width: 0;
}

.chat-input:disabled {
  @apply cursor-not-allowed border-white/10 bg-white/5 text-white/35;
}

.panel-toggle-btn {
  @apply inline-flex h-11 w-11 items-center justify-center rounded-lg border border-white/15 bg-white/5
         text-white/75 transition-all duration-200 hover:bg-white/10 hover:text-white active:scale-95;
}

.chat-send-btn {
  @apply w-11 h-11 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600
         flex items-center justify-center text-white flex-shrink-0
         transition-all duration-200
         hover:shadow-lg hover:shadow-indigo-500/30
         active:scale-95;
}

.chat-send-btn:disabled {
  @apply cursor-not-allowed opacity-45 hover:shadow-none active:scale-100;
}

@media (min-width: 768px) {
  .bottom-action-bar {
    padding-left: calc(var(--safe-left) + 0.75rem);
    padding-right: calc(var(--safe-right) + 0.75rem);
  }

  .action-dock {
    padding-left: calc(var(--safe-left) + 0.75rem);
    padding-right: calc(var(--safe-right) + 0.75rem);
  }

  .seat-theater {
    grid-template-columns: minmax(90px, 108px) minmax(0, 1fr) minmax(90px, 108px);
    gap: 0.75rem;
  }

  .seat-stage-avatar {
    width: 72px;
    height: 72px;
  }

  .room-hud-shell {
    padding: 1rem 1.1rem;
  }

  .action-dock-shell {
    max-width: 720px;
  }
}

@media (min-width: 1024px) {
  .room-hud-shell {
    padding: 1.1rem 1.2rem;
  }

  .action-dock-shell {
    max-width: 900px;
  }
}

@media (max-width: 640px) {
  .moon-sun {
    display: none;
  }

  .room-hud-shell {
    padding: 0.5rem;
  }

  .audio-unlock-banner {
    gap: 0.3rem;
    padding: 0.35rem 0.42rem;
  }

  .audio-unlock-text {
    font-size: 10px;
    line-height: 1.2;
  }

  .audio-unlock-btn {
    min-height: 32px;
    min-width: 64px;
    border-radius: 0.55rem;
    padding: 0 0.42rem;
    font-size: 10px;
  }

  .hud-players-section {
    border-color: rgba(255, 255, 255, 0.05);
  }

  .seat-theater {
    grid-template-columns: minmax(56px, 64px) minmax(0, 1fr) minmax(56px, 64px);
    gap: 0.28rem;
  }

  .seat-rail {
    gap: 0.3rem;
  }

  .seat-chip {
    min-height: 68px;
    padding: 0.28rem 0.14rem 0.34rem;
    border-radius: 0.65rem;
    border-width: 0;
    background: rgba(255, 255, 255, 0.03);
  }

  .seat-chip--speaking {
    border-width: 1px;
  }

  .seat-chip-avatar {
    width: 28px;
    height: 28px;
    font-size: 0.7rem;
    border-width: 1px;
  }

  .seat-chip-name {
    margin-top: 0.25rem;
    font-size: 9px;
  }

  .seat-chip-dead-tag {
    bottom: -2px;
    padding: 0.08rem 0.26rem;
    font-size: 7px;
  }

  .seat-chip-bot {
    display: none;
  }

  .speaker-float-badge {
    top: -1px;
    left: 50%;
    right: auto;
    transform: translate(-50%, -100%);
    padding: 0.12rem 0.32rem;
    font-size: 8px;
  }

  .seat-rail--right .speaker-float-badge {
    right: auto;
    left: 50%;
  }

  .seat-stage-card {
    border-radius: 0.9rem;
    padding: 0.46rem 0.42rem;
  }

  .seat-stage-top {
    margin-bottom: 0.25rem;
  }

  .seat-stage-title {
    font-size: 10px;
  }

  .seat-stage-phase {
    font-size: 9px;
    padding: 0.12rem 0.45rem;
  }

  .seat-stage-avatar {
    width: 40px;
    height: 40px;
    font-size: 0.85rem;
  }

  .seat-stage-name {
    font-size: 0.76rem;
  }

  .seat-stage-sub {
    margin-top: 0.15rem;
    font-size: 10px;
  }

  .seat-stage-feed {
    margin-top: 0.25rem;
    max-height: 56px;
    padding: 0.24rem;
  }

  .seat-stage-feed-item {
    font-size: 9px;
    line-height: 1.15;
    padding: 0.14rem 0.28rem;
  }

  .seat-stage-wolf {
    margin-top: 0.22rem;
    padding: 0.24rem 0.3rem;
  }

  .seat-stage-wolf-title {
    font-size: 9px;
  }

  .seat-stage-wolf-badge {
    font-size: 8px;
    padding: 0.1rem 0.34rem;
  }

  .seat-stage-wolf-feed {
    margin-top: 0.18rem;
    max-height: 52px;
    padding: 0.2rem;
  }

  .seat-stage-wolf-item {
    font-size: 9px;
    line-height: 1.15;
    padding: 0.14rem 0.28rem;
  }

  .seat-stage-wolf-input-wrap {
    margin-top: 0.18rem;
    gap: 0.24rem;
    min-width: 0;
  }

  .seat-stage-wolf-input {
    min-height: 34px;
    min-width: 0;
    border-radius: 0.6rem;
    padding: 0 0.42rem;
    font-size: 11px;
  }

  .seat-stage-wolf-send {
    min-height: 34px;
    min-width: 40px;
    border-radius: 0.6rem;
    padding: 0 0.34rem;
    font-size: 10px;
  }

  .seat-stage-actions {
    margin-top: 0.22rem;
  }

  .seat-stage-voice {
    margin-top: 0.22rem;
    padding: 0.24rem 0.3rem;
  }

  .seat-stage-voice-title {
    font-size: 9px;
  }

  .seat-stage-voice-state {
    font-size: 8px;
    padding: 0.1rem 0.34rem;
  }

  .seat-stage-voice-row {
    margin-top: 0.18rem;
    gap: 0.24rem;
  }

  .seat-stage-voice-btn {
    min-height: 34px;
    border-radius: 0.6rem;
    padding: 0 0.42rem;
    font-size: 11px;
  }

  .seat-stage-voice-aux {
    min-height: 34px;
    min-width: 56px;
    border-radius: 0.6rem;
    padding: 0 0.42rem;
    font-size: 10px;
  }

  .seat-stage-voice-tip {
    margin-top: 0.18rem;
    font-size: 9px;
    line-height: 1.2;
  }

  .seat-stage-listen {
    padding: 0.25rem 0.3rem;
    font-size: 9px;
  }

  .seat-stage-input-wrap {
    margin-top: 0.22rem;
    gap: 0.24rem;
    min-width: 0;
  }

  .seat-stage-input {
    min-height: 34px;
    min-width: 0;
    border-radius: 0.6rem;
    padding: 0 0.42rem;
    font-size: 11px;
  }

  .seat-stage-send {
    min-height: 34px;
    min-width: 40px;
    border-radius: 0.6rem;
    padding: 0 0.34rem;
    font-size: 10px;
  }
}

@media (max-width: 420px) {
  .bottom-bubble-row {
    gap: 0.65rem;
  }

  .bottom-bubble-btn {
    width: 56px;
    height: 56px;
  }

  .bottom-bubble-btn--start {
    width: 62px;
    height: 62px;
  }

  .bottom-bubble-label {
    font-size: 11px;
  }

  .seat-theater {
    grid-template-columns: minmax(68px, 78px) minmax(0, 1fr) minmax(68px, 78px);
    gap: 0.4rem;
  }

  .seat-chip {
    padding: 0.38rem 0.2rem 0.45rem;
  }

  .seat-chip-avatar {
    width: 34px;
    height: 34px;
    font-size: 0.8rem;
  }

  .seat-chip-no {
    width: 16px;
    height: 16px;
    font-size: 9px;
  }

  .seat-stage-avatar {
    width: 52px;
    height: 52px;
    font-size: 1rem;
  }

  .speaker-float-badge {
    padding: 0.22rem 0.38rem;
    font-size: 9px;
  }

  .seat-stage-feed {
    max-height: 88px;
  }

  .room-hud-shell {
    border-radius: 1.25rem;
    padding: 0.55rem;
  }

  .hud-info-section--chat {
    min-height: 260px;
  }

  .chat-header {
    padding-left: 0.75rem;
    padding-right: 0.75rem;
  }

  .chat-input-area {
    padding-left: 0.75rem;
    padding-right: 0.75rem;
  }
}
</style>
