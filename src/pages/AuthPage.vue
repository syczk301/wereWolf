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
  <div class="min-h-dvh relative overflow-hidden flex flex-col">
    <!-- Background -->
    <div class="fixed inset-0 z-0 pointer-events-none">
      <div class="absolute inset-0 bg-gradient-to-b from-[#0a0f18] via-[#0d1526] to-[#0a0f1a]" />
      <!-- Stars -->
      <div class="absolute inset-0">
        <div
          class="absolute w-1.5 h-1.5 bg-white rounded-full animate-pulse"
          style="top: 8%; left: 15%;"
        />
        <div
          class="absolute w-1 h-1 bg-white/80 rounded-full animate-pulse"
          style="top: 15%; left: 30%; animation-delay: 0.5s;"
        />
        <div
          class="absolute w-1.5 h-1.5 bg-white rounded-full animate-pulse"
          style="top: 6%; left: 55%; animation-delay: 1s;"
        />
        <div
          class="absolute w-1 h-1 bg-white/70 rounded-full animate-pulse"
          style="top: 20%; left: 75%; animation-delay: 1.5s;"
        />
        <div
          class="absolute w-1.5 h-1.5 bg-white/90 rounded-full animate-pulse"
          style="top: 12%; left: 85%; animation-delay: 2s;"
        />
        <div
          class="absolute w-1 h-1 bg-white/80 rounded-full animate-pulse"
          style="top: 25%; left: 45%; animation-delay: 0.8s;"
        />
      </div>
      <!-- Moon glow -->
      <div class="absolute top-[10%] right-[8%] w-20 h-20 opacity-40">
        <div class="absolute -inset-6 rounded-full bg-yellow-100/15 blur-3xl" />
        <div class="absolute inset-0 rounded-full bg-gradient-to-br from-yellow-50 via-yellow-100 to-yellow-200 shadow-[0_0_60px_20px_rgba(255,255,200,0.3)]" />
      </div>
      <!-- Forest -->
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
    </div>

    <!-- Content -->
    <div class="relative z-10 flex-1 flex flex-col items-center justify-center px-5 py-8">
      <!-- Logo -->
      <div class="mb-8 text-center animate-slide-up">
        <div class="mx-auto mb-4 h-16 w-16 rounded-2xl bg-gradient-to-br from-red-600 to-red-800 flex items-center justify-center shadow-lg shadow-red-900/40 border border-red-500/30">
          <svg
            class="w-9 h-9 text-white"
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
        <h1 class="text-3xl font-black tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-red-400 via-orange-300 to-red-400">
          狼人杀
        </h1>
        <p class="mt-1 text-xs text-white/40 tracking-widest uppercase">
          Werewolf Game
        </p>
      </div>

      <!-- Form Card -->
      <div
        class="w-full max-w-sm animate-slide-up"
        style="animation-delay: 0.1s;"
      >
        <div class="rounded-2xl border border-white/10 bg-gradient-to-br from-[#1a233b]/90 to-[#0d1526]/90 backdrop-blur-xl shadow-2xl overflow-hidden">
          <!-- Tab Switch -->
          <div class="flex border-b border-white/10">
            <button
              class="flex-1 py-3.5 text-sm font-medium transition-all duration-200 relative"
              :class="mode === 'login' ? 'text-white bg-white/5' : 'text-white/50 hover:text-white/70'"
              @click="mode = 'login'"
            >
              登录
              <div
                v-if="mode === 'login'"
                class="absolute bottom-0 left-1/4 right-1/4 h-0.5 bg-gradient-to-r from-red-500 to-orange-500 rounded-full"
              />
            </button>
            <button
              class="flex-1 py-3.5 text-sm font-medium transition-all duration-200 relative"
              :class="mode !== 'login' ? 'text-white bg-white/5' : 'text-white/50 hover:text-white/70'"
              @click="mode = session.user?.isGuest ? 'upgrade' : 'register'"
            >
              {{ session.user?.isGuest ? '升级账号' : '注册' }}
              <div
                v-if="mode !== 'login'"
                class="absolute bottom-0 left-1/4 right-1/4 h-0.5 bg-gradient-to-r from-red-500 to-orange-500 rounded-full"
              />
            </button>
          </div>

          <!-- Form -->
          <form
            class="p-5 space-y-4"
            @submit.prevent="onSubmit"
          >
            <div>
              <label
                for="auth-email"
                class="block mb-1.5 text-xs font-medium text-white/50 tracking-wide"
              >邮箱 / 用户名</label>
              <input
                id="auth-email"
                v-model="emailOrUsername"
                class="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white placeholder-white/25 outline-none transition-all duration-200 focus:border-violet-500/50 focus:bg-black/40 focus:ring-2 focus:ring-violet-500/20"
                placeholder="输入邮箱或用户名"
                autocomplete="username"
              >
            </div>

            <div v-if="mode !== 'login'">
              <label
                for="auth-nick"
                class="block mb-1.5 text-xs font-medium text-white/50 tracking-wide"
              >昵称</label>
              <input
                id="auth-nick"
                v-model="nickname"
                class="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white placeholder-white/25 outline-none transition-all duration-200 focus:border-violet-500/50 focus:bg-black/40 focus:ring-2 focus:ring-violet-500/20"
                placeholder="游戏中的昵称"
                autocomplete="nickname"
              >
            </div>

            <div>
              <label
                for="auth-pass"
                class="block mb-1.5 text-xs font-medium text-white/50 tracking-wide"
              >密码</label>
              <input
                id="auth-pass"
                v-model="password"
                type="password"
                class="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white placeholder-white/25 outline-none transition-all duration-200 focus:border-violet-500/50 focus:bg-black/40 focus:ring-2 focus:ring-violet-500/20"
                placeholder="输入密码"
                autocomplete="current-password"
              >
            </div>

            <div
              v-if="error"
              class="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-300"
            >
              {{ error }}
            </div>

            <button
              class="w-full rounded-xl bg-gradient-to-r from-red-600 via-red-500 to-orange-500 px-4 py-3.5 text-sm font-bold text-white shadow-lg shadow-red-900/30 transition-all duration-200 hover:shadow-red-500/40 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
              :disabled="!canSubmit || loading"
              type="submit"
            >
              {{ loading ? '处理中...' : mode === 'login' ? '登录' : mode === 'register' ? '注册并登录' : '绑定账号' }}
            </button>

            <button
              v-if="mode === 'login'"
              class="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3.5 text-sm font-medium text-white/80 transition-all duration-200 hover:bg-white/10 hover:border-white/25 active:scale-[0.98] disabled:opacity-50"
              :disabled="loading"
              type="button"
              @click="onGuest"
            >
              访客快速进入
            </button>
          </form>
        </div>
      </div>

      <!-- Footer -->
      <div
        class="mt-6 text-center text-[11px] text-white/30 animate-slide-up"
        style="animation-delay: 0.2s;"
      >
        继续即表示你同意基础规则与隐私条款
      </div>
    </div>
  </div>
</template>
