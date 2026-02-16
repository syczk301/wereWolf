import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { GamePrivateState, GamePublicState, RoomState } from '../../shared/types'

export const useRoomStore = defineStore('room', () => {
  const roomState = ref<RoomState | null>(null)
  const gamePublic = ref<GamePublicState | null>(null)
  const gamePrivate = ref<GamePrivateState | null>(null)
  const toasts = ref<{ id: string; type: 'info' | 'error'; message: string }[]>([])
  const chat = ref<{ id: string; at: number; sender: { id: string; nickname: string }; text: string }[]>([])

  // Calibrate countdowns with server clock to avoid cross-device drift.
  const serverTimeOffsetMs = ref(0)
  const now = ref(Date.now())
  let timer: any = null

  function getAlignedNow() {
    return Date.now() + serverTimeOffsetMs.value
  }

  const phaseLeftMs = computed(() => {
    if (!gamePublic.value) return 0
    return Math.max(0, gamePublic.value.phaseEndsAt - now.value)
  })

  const secondsLeft = computed(() => Math.ceil(phaseLeftMs.value / 1000))

  const isTimeLow = computed(() => secondsLeft.value <= 5 && secondsLeft.value > 0)

  const totalPhaseSeconds = computed(() => {
    const p = gamePublic.value?.phase
    const config = roomState.value?.timers
    if (!p || !config) return 0
    if (p === 'night') return config.nightSeconds
    if (p === 'day_speech') return config.daySpeechSeconds
    if (p === 'day_vote') return config.dayVoteSeconds
    if (p === 'settlement') return config.settlementSeconds
    return 10
  })

  const timerProgress = computed(() => {
    if (totalPhaseSeconds.value <= 0) return 0
    return (phaseLeftMs.value / (totalPhaseSeconds.value * 1000)) * 100
  })

  function startTimer() {
    if (timer) return
    timer = setInterval(() => {
      now.value = getAlignedNow()
    }, 100)
  }

  function stopTimer() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  function applyRoom(payload: RoomState) {
    roomState.value = payload
  }

  function applyGamePublic(payload: GamePublicState) {
    if (Number.isFinite(payload.serverNow)) {
      serverTimeOffsetMs.value = payload.serverNow - Date.now()
    }
    gamePublic.value = payload
    now.value = getAlignedNow()
    startTimer()
  }

  function applyGamePrivate(payload: GamePrivateState) {
    gamePrivate.value = payload
  }

  function removeToast(id: string) {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }

  function pushToast(type: 'info' | 'error', message: string) {
    const id = `${Date.now()}-${Math.random()}`
    toasts.value = [...toasts.value, { id, type, message }].slice(-3)
    setTimeout(() => removeToast(id), 3000)
  }

  function pushChat(msg: { id: string; at: number; sender: { id: string; nickname: string }; text: string }) {
    if (chat.value.some((m) => m.id === msg.id)) return
    chat.value = [...chat.value, msg].slice(-80)
  }

  function reset() {
    roomState.value = null
    gamePublic.value = null
    gamePrivate.value = null
    toasts.value = []
    chat.value = []
    serverTimeOffsetMs.value = 0
    now.value = Date.now()
  }

  // Auto-start timer on store load
  if (typeof window !== 'undefined') {
    startTimer()
  }

  return {
    roomState,
    gamePublic,
    gamePrivate,
    phaseLeftMs,
    secondsLeft,
    isTimeLow,
    timerProgress,
    now,
    toasts,
    chat,
    applyRoom,
    applyGamePublic,
    applyGamePrivate,
    pushToast,
    removeToast,
    pushChat,
    reset,
  }
})

