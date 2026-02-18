import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '@/utils/api'

type User = { id: string; nickname: string; isGuest: boolean }

export const useSessionStore = defineStore('session', () => {
  const token = ref<string | null>(null)
  const user = ref<User | null>(null)
  const isInitialized = ref(false)

  const isAuthed = computed(() => !!token.value)

  async function init() {
    const raw = localStorage.getItem('werewolf_token')
    token.value = raw || null
    if (token.value) {
      try {
        const resp = await api.getMe(token.value)
        user.value = resp.user
      } catch {
        token.value = null
        user.value = null
        localStorage.removeItem('werewolf_token')
      }
    }
    isInitialized.value = true
  }

  async function login(emailOrUsername: string, password: string) {
    const resp = await api.login({ emailOrUsername, password })
    token.value = resp.accessToken
    user.value = resp.user
    localStorage.setItem('werewolf_token', resp.accessToken)
  }

  async function register(input: {
    username: string
    email: string
    nickname: string
    password: string
    emailCode: string
  }) {
    const resp = await api.register({
      username: input.username,
      email: input.email,
      nickname: input.nickname,
      password: input.password,
      emailCode: input.emailCode,
      emailOrUsername: input.username,
    })
    token.value = resp.accessToken
    user.value = resp.user
    localStorage.setItem('werewolf_token', resp.accessToken)
  }

  async function logout() {
    if (token.value) {
      try {
        await api.logout(token.value)
      } catch {
        return
      }
    }
    token.value = null
    user.value = null
    localStorage.removeItem('werewolf_token')
  }

  async function guestEnter(nickname?: string) {
    const resp = await api.guest({ nickname })
    token.value = resp.accessToken
    user.value = resp.user
    localStorage.setItem('werewolf_token', resp.accessToken)
  }

  async function upgradeToAccount(input: {
    username: string
    email: string
    password: string
    nickname?: string
    emailCode: string
  }) {
    if (!token.value) throw new Error('NO_TOKEN')
    const resp = await api.upgrade(token.value, {
      username: input.username,
      email: input.email,
      password: input.password,
      nickname: input.nickname,
      emailCode: input.emailCode,
      emailOrUsername: input.username,
    })
    token.value = resp.accessToken
    user.value = resp.user
    localStorage.setItem('werewolf_token', resp.accessToken)
  }

  return {
    token,
    user,
    isAuthed,
    isInitialized,
    init,
    login,
    register,
    logout,
    guestEnter,
    upgradeToAccount,
  }
})
