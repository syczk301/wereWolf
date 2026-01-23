<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'

const router = useRouter()
const session = useSessionStore()

const mode = ref<'login' | 'register' | 'upgrade'>('login')
const emailOrUsername = ref('')
const nickname = ref('')
const password = ref('')
const error = ref<string | null>(null)
const loading = ref(false)

const canSubmit = computed(() => {
  if (mode.value === 'login') return emailOrUsername.value.trim() && password.value
  if (mode.value === 'register') return emailOrUsername.value.trim() && nickname.value.trim() && password.value.length >= 6
  return emailOrUsername.value.trim() && password.value.length >= 6
})

async function onSubmit() {
  if (!canSubmit.value) return
  error.value = null
  loading.value = true
  try {
    if (mode.value === 'login') {
      await session.login(emailOrUsername.value.trim(), password.value)
    } else if (mode.value === 'register') {
      await session.register(emailOrUsername.value.trim(), nickname.value.trim(), password.value)
    } else {
      await session.upgradeToAccount(emailOrUsername.value.trim(), password.value, nickname.value.trim() || undefined)
    }
    await router.replace('/lobby')
  } catch (e: any) {
    error.value = e?.message ?? '操作失败'
  } finally {
    loading.value = false
  }
}

async function onGuest() {
  error.value = null
  loading.value = true
  try {
    await session.guestEnter()
    await router.replace('/lobby')
  } catch (e: any) {
    error.value = e?.message ?? '操作失败'
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  if (!session.isInitialized) await session.init()
  if (session.user?.isGuest) mode.value = 'upgrade'
})
</script>

<template>
  <div class="min-h-dvh px-4 py-8">
    <div class="mx-auto max-w-sm">
      <div class="mb-6">
        <div class="text-lg font-semibold">狼人杀</div>
        <div class="mt-1 text-xs text-white/60">手机优先 · 实时房间对局</div>
      </div>

      <div class="rounded-xl border border-white/10 bg-white/5 p-4">
        <div class="mb-4 grid grid-cols-2 gap-2 rounded-lg bg-black/20 p-1">
          <button
            class="rounded-md py-2 text-sm transition"
            :class="mode === 'login' ? 'bg-white/10 text-white' : 'text-white/70 hover:bg-white/5'"
            @click="mode = 'login'"
          >
            登录
          </button>
          <button
            class="rounded-md py-2 text-sm transition"
            :class="mode !== 'login' ? 'bg-white/10 text-white' : 'text-white/70 hover:bg-white/5'"
            @click="mode = session.user?.isGuest ? 'upgrade' : 'register'"
          >
            {{ session.user?.isGuest ? '升级' : '注册' }}
          </button>
        </div>

        <form class="space-y-3" @submit.prevent="onSubmit">
          <div>
            <div class="mb-1 text-xs text-white/70">邮箱/用户名</div>
            <input
              v-model="emailOrUsername"
              class="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-white/25"
              autocomplete="username"
            />
          </div>

          <div v-if="mode !== 'login'">
            <div class="mb-1 text-xs text-white/70">昵称</div>
            <input
              v-model="nickname"
              class="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-white/25"
              autocomplete="nickname"
            />
          </div>

          <div>
            <div class="mb-1 text-xs text-white/70">密码</div>
            <input
              v-model="password"
              type="password"
              class="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-white/25"
              autocomplete="current-password"
            />
          </div>

          <div v-if="error" class="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {{ error }}
          </div>

          <button
            class="mt-2 w-full rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-violet-500 disabled:opacity-50"
            :disabled="!canSubmit || loading"
            type="submit"
          >
            {{
              loading
                ? '处理中…'
                : mode === 'login'
                  ? '登录'
                  : mode === 'register'
                    ? '注册并登录'
                    : '绑定账号'
            }}
          </button>

          <button
            v-if="mode === 'login'"
            class="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white/90 transition hover:bg-white/10 disabled:opacity-50"
            :disabled="loading"
            type="button"
            @click="onGuest"
          >
            访客进入
          </button>
        </form>
      </div>

      <div class="mt-6 text-center text-xs text-white/50">
        继续即表示你同意基础规则与隐私条款（占位）
      </div>
    </div>
  </div>
</template>
