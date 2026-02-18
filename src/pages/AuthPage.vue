<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { api } from '@/utils/api'

const router = useRouter()
const session = useSessionStore()

const mode = ref<'login' | 'register' | 'upgrade'>('login')
const forgotPassword = ref(false)
const loginAccount = ref('')
const username = ref('')
const email = ref('')
const nickname = ref('')
const password = ref('')
const emailCode = ref('')
const resetEmail = ref('')
const resetEmailCode = ref('')
const newPassword = ref('')
const confirmNewPassword = ref('')
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
const loading = ref(false)
const sendingCode = ref(false)
const resendLeftSeconds = ref(0)

let resendTimer: ReturnType<typeof setInterval> | null = null

function isEmailValue(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

const isEmailCodeValid = computed(() => /^\d{6}$/.test(emailCode.value.trim()))
const isResetEmailCodeValid = computed(() => /^\d{6}$/.test(resetEmailCode.value.trim()))
const otpPurpose = computed<'register' | 'upgrade'>(() => (mode.value === 'upgrade' ? 'upgrade' : 'register'))
const isResetMode = computed(() => mode.value === 'login' && forgotPassword.value)

const canSendCode = computed(() => {
  if (isResetMode.value) {
    return isEmailValue(resetEmail.value) && !sendingCode.value && resendLeftSeconds.value <= 0
  }
  return mode.value !== 'login' && isEmailValue(email.value) && !sendingCode.value && resendLeftSeconds.value <= 0
})

const canSubmit = computed(() => {
  if (isResetMode.value) {
    return (
      isEmailValue(resetEmail.value) &&
      isResetEmailCodeValid.value &&
      newPassword.value.length >= 6 &&
      confirmNewPassword.value.length >= 6 &&
      confirmNewPassword.value === newPassword.value
    )
  }
  if (mode.value === 'login') return !!loginAccount.value.trim() && !!password.value
  if (!username.value.trim() || !isEmailValue(email.value) || password.value.length < 6 || !isEmailCodeValid.value) return false
  if (mode.value === 'register') return !!nickname.value.trim()
  return true
})

function clearResendTimer() {
  if (resendTimer) clearInterval(resendTimer)
  resendTimer = null
}

function startResendTimer(seconds: number) {
  clearResendTimer()
  resendLeftSeconds.value = Math.max(0, Math.floor(seconds))
  if (resendLeftSeconds.value <= 0) return

  resendTimer = setInterval(() => {
    resendLeftSeconds.value = Math.max(0, resendLeftSeconds.value - 1)
    if (resendLeftSeconds.value <= 0) clearResendTimer()
  }, 1000)
}

function toUserError(raw: unknown) {
  const code = String((raw as any)?.message ?? raw ?? '操作失败')
  const map: Record<string, string> = {
    USERNAME_REQUIRED: '请输入用户名',
    EMAIL_REQUIRED: '请输入邮箱',
    EMAIL_CODE_REQUIRED: '请输入邮箱验证码',
    EMAIL_NOT_FOUND: '该邮箱未注册',
    RESET_PASSWORD_FAILED: '密码重置失败，请稍后重试',
    OTP_INVALID_OR_EXPIRED: '验证码错误或已过期',
    OTP_COOLDOWN: '发送过于频繁，请稍后再试',
    OTP_DAILY_LIMIT: '今日发送次数已达上限',
    OTP_TOO_MANY_ATTEMPTS: '验证码尝试次数过多，请重新发送',
    EMAIL_SEND_FAILED: '验证码邮件发送失败，请稍后重试',
    EMAIL_DELIVERY_NOT_CONFIGURED: '邮件服务未配置，请联系管理员',
    INVALID_INPUT: '请输入完整且正确的信息',
  }
  return map[code] || code
}

async function onSendEmailCode() {
  if (!canSendCode.value) return
  error.value = null
  notice.value = null

  sendingCode.value = true
  try {
    const resp = isResetMode.value
      ? await api.sendResetPasswordCode(resetEmail.value.trim())
      : await api.sendRegisterEmailCode(email.value.trim(), otpPurpose.value)
    startResendTimer(resp.resendAfterSeconds || 60)
    notice.value = '验证码已发送，请检查邮箱'
  } catch (e: any) {
    error.value = toUserError(e)
  } finally {
    sendingCode.value = false
  }
}

async function onSubmit() {
  if (!canSubmit.value) return
  error.value = null
  notice.value = null
  loading.value = true
  try {
    if (isResetMode.value) {
      if (newPassword.value !== confirmNewPassword.value) {
        throw new Error('两次输入的密码不一致')
      }
      await api.resetPasswordByEmail({
        email: resetEmail.value.trim(),
        emailCode: resetEmailCode.value.trim(),
        newPassword: newPassword.value,
      })
      loginAccount.value = resetEmail.value.trim()
      password.value = ''
      closeForgotPasswordAfterSuccess()
      notice.value = '密码已重置，请使用新密码登录'
      return
    }

    if (mode.value === 'login') {
      await session.login(loginAccount.value.trim(), password.value)
    } else if (mode.value === 'register') {
      await session.register({
        username: username.value.trim(),
        email: email.value.trim(),
        nickname: nickname.value.trim(),
        password: password.value,
        emailCode: emailCode.value.trim(),
      })
    } else {
      await session.upgradeToAccount({
        username: username.value.trim(),
        email: email.value.trim(),
        password: password.value,
        nickname: nickname.value.trim() || undefined,
        emailCode: emailCode.value.trim(),
      })
    }
    await router.replace('/lobby')
  } catch (e: any) {
    error.value = toUserError(e)
  } finally {
    loading.value = false
  }
}

function openForgotPassword() {
  forgotPassword.value = true
  error.value = null
  notice.value = null
  resetEmail.value = isEmailValue(loginAccount.value) ? loginAccount.value.trim() : ''
  resetEmailCode.value = ''
  newPassword.value = ''
  confirmNewPassword.value = ''
  clearResendTimer()
  resendLeftSeconds.value = 0
}

function resetForgotPasswordFields() {
  resetEmailCode.value = ''
  newPassword.value = ''
  confirmNewPassword.value = ''
  clearResendTimer()
  resendLeftSeconds.value = 0
}

function closeForgotPassword() {
  forgotPassword.value = false
  error.value = null
  notice.value = null
  resetForgotPasswordFields()
}

function closeForgotPasswordAfterSuccess() {
  forgotPassword.value = false
  error.value = null
  resetForgotPasswordFields()
}

async function onGuest() {
  error.value = null
  notice.value = null
  loading.value = true
  try {
    await session.guestEnter()
    await router.replace('/lobby')
  } catch (e: any) {
    error.value = toUserError(e)
  } finally {
    loading.value = false
  }
}

watch(mode, () => {
  error.value = null
  notice.value = null
  emailCode.value = ''
  forgotPassword.value = false
  resetEmail.value = ''
  resetEmailCode.value = ''
  newPassword.value = ''
  confirmNewPassword.value = ''
  clearResendTimer()
  resendLeftSeconds.value = 0
})

onMounted(async () => {
  if (!session.isInitialized) await session.init()
  if (session.user?.isGuest) {
    mode.value = 'upgrade'
    nickname.value = session.user.nickname
  }
})

onUnmounted(() => {
  clearResendTimer()
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
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M7.5 3L6 8C4 9.5 3 11.5 3 14C3 18.4 7 22 12 22C17 22 21 18.4 21 14C21 11.5 20 9.5 18 8L16.5 3L13.5 8.5L12 7.5L10.5 8.5Z" />
            <circle cx="9.5" cy="13" r="1.5" fill="currentColor" stroke="none" />
            <circle cx="14.5" cy="13" r="1.5" fill="currentColor" stroke="none" />
            <path d="M10 17Q12 18 14 17" stroke-width="1.2" />
            <path d="M10.5 17.5L10 20" stroke-width="1.2" />
            <path d="M13.5 17.5L14 20" stroke-width="1.2" />
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
              <template v-if="mode === 'login' && !forgotPassword">
                <label
                  for="auth-account-login"
                  class="block mb-1.5 text-xs font-medium text-white/50 tracking-wide"
                >邮箱 / 用户名</label>
                <input
                  id="auth-account-login"
                  v-model="loginAccount"
                  class="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white placeholder-white/25 outline-none transition-all duration-200 focus:border-violet-500/50 focus:bg-black/40 focus:ring-2 focus:ring-violet-500/20"
                  placeholder="输入邮箱或用户名"
                  autocomplete="username"
                >
              </template>

              <template v-else-if="mode === 'login'">
                <label
                  for="auth-reset-email"
                  class="block mb-1.5 text-xs font-medium text-white/50 tracking-wide"
                >找回邮箱</label>
                <div class="flex items-center gap-2">
                  <input
                    id="auth-reset-email"
                    v-model="resetEmail"
                    class="flex-1 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white placeholder-white/25 outline-none transition-all duration-200 focus:border-violet-500/50 focus:bg-black/40 focus:ring-2 focus:ring-violet-500/20"
                    placeholder="输入注册邮箱"
                    autocomplete="email"
                  >
                  <button
                    class="whitespace-nowrap rounded-xl border border-white/15 bg-white/5 px-3 py-3 text-xs font-medium text-white/80 transition-all duration-200 hover:bg-white/10 hover:border-white/25 disabled:opacity-50 disabled:cursor-not-allowed"
                    :disabled="!canSendCode"
                    type="button"
                    @click="onSendEmailCode"
                  >
                    {{
                      sendingCode
                        ? '发送中...'
                        : resendLeftSeconds > 0
                          ? `${resendLeftSeconds}s后重发`
                          : '发送验证码'
                    }}
                  </button>
                </div>
              </template>

              <template v-else>
                <label
                  for="auth-account-register"
                  class="block mb-1.5 text-xs font-medium text-white/50 tracking-wide"
                >用户名</label>
                <input
                  id="auth-account-register"
                  v-model="username"
                  class="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white placeholder-white/25 outline-none transition-all duration-200 focus:border-violet-500/50 focus:bg-black/40 focus:ring-2 focus:ring-violet-500/20"
                  placeholder="输入用户名"
                  autocomplete="username"
                >
              </template>
            </div>

            <div v-if="mode !== 'login'">
              <label
                for="auth-register-email"
                class="block mb-1.5 text-xs font-medium text-white/50 tracking-wide"
              >邮箱</label>
              <div class="flex items-center gap-2">
                <input
                  id="auth-register-email"
                  v-model="email"
                  class="flex-1 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white placeholder-white/25 outline-none transition-all duration-200 focus:border-violet-500/50 focus:bg-black/40 focus:ring-2 focus:ring-violet-500/20"
                  placeholder="输入邮箱"
                  autocomplete="email"
                >
                <button
                  class="whitespace-nowrap rounded-xl border border-white/15 bg-white/5 px-3 py-3 text-xs font-medium text-white/80 transition-all duration-200 hover:bg-white/10 hover:border-white/25 disabled:opacity-50 disabled:cursor-not-allowed"
                  :disabled="!canSendCode"
                  type="button"
                  @click="onSendEmailCode"
                >
                  {{
                    sendingCode
                      ? '发送中...'
                      : resendLeftSeconds > 0
                        ? `${resendLeftSeconds}s后重发`
                        : '发送验证码'
                  }}
                </button>
              </div>
            </div>

            <div v-if="mode === 'register' || mode === 'upgrade'">
              <label
                for="auth-nick"
                class="block mb-1.5 text-xs font-medium text-white/50 tracking-wide"
              >{{ mode === 'register' ? '昵称' : '昵称（可选）' }}</label>
              <input
                id="auth-nick"
                v-model="nickname"
                class="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white placeholder-white/25 outline-none transition-all duration-200 focus:border-violet-500/50 focus:bg-black/40 focus:ring-2 focus:ring-violet-500/20"
                :placeholder="mode === 'register' ? '游戏中的昵称' : '不填则使用当前昵称'"
                autocomplete="nickname"
              >
            </div>

            <div v-if="mode === 'login' && !forgotPassword">
              <label
                for="auth-login-pass"
                class="block mb-1.5 text-xs font-medium text-white/50 tracking-wide"
              >密码</label>
              <input
                id="auth-login-pass"
                v-model="password"
                type="password"
                class="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white placeholder-white/25 outline-none transition-all duration-200 focus:border-violet-500/50 focus:bg-black/40 focus:ring-2 focus:ring-violet-500/20"
                placeholder="输入密码"
                autocomplete="current-password"
              >
            </div>

            <div v-else-if="mode === 'login'">
              <label
                for="auth-reset-pass"
                class="block mb-1.5 text-xs font-medium text-white/50 tracking-wide"
              >新密码</label>
              <input
                id="auth-reset-pass"
                v-model="newPassword"
                type="password"
                class="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white placeholder-white/25 outline-none transition-all duration-200 focus:border-violet-500/50 focus:bg-black/40 focus:ring-2 focus:ring-violet-500/20"
                placeholder="输入新密码（至少6位）"
                autocomplete="new-password"
              >
            </div>

            <div v-if="mode === 'login' && forgotPassword">
              <label
                for="auth-reset-pass-confirm"
                class="block mb-1.5 text-xs font-medium text-white/50 tracking-wide"
              >确认新密码</label>
              <input
                id="auth-reset-pass-confirm"
                v-model="confirmNewPassword"
                type="password"
                class="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white placeholder-white/25 outline-none transition-all duration-200 focus:border-violet-500/50 focus:bg-black/40 focus:ring-2 focus:ring-violet-500/20"
                placeholder="再次输入新密码"
                autocomplete="new-password"
              >
            </div>

            <div v-else-if="mode !== 'login'">
              <label
                for="auth-register-pass"
                class="block mb-1.5 text-xs font-medium text-white/50 tracking-wide"
              >密码</label>
              <input
                id="auth-register-pass"
                v-model="password"
                type="password"
                class="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white placeholder-white/25 outline-none transition-all duration-200 focus:border-violet-500/50 focus:bg-black/40 focus:ring-2 focus:ring-violet-500/20"
                placeholder="输入密码"
                autocomplete="new-password"
              >
            </div>

            <div v-if="mode !== 'login'">
              <label
                for="auth-email-code"
                class="block mb-1.5 text-xs font-medium text-white/50 tracking-wide"
              >邮箱验证码</label>
              <input
                id="auth-email-code"
                v-model="emailCode"
                class="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white placeholder-white/25 outline-none transition-all duration-200 focus:border-violet-500/50 focus:bg-black/40 focus:ring-2 focus:ring-violet-500/20"
                placeholder="输入6位验证码"
                inputmode="numeric"
                maxlength="6"
              >
              <p class="mt-1 text-[11px] text-white/35">
                {{ mode === 'register' ? '注册前需完成邮箱验证码校验' : '升级账号前需完成邮箱验证码校验' }}
              </p>
            </div>

            <div v-else-if="forgotPassword">
              <label
                for="auth-reset-email-code"
                class="block mb-1.5 text-xs font-medium text-white/50 tracking-wide"
              >邮箱验证码</label>
              <input
                id="auth-reset-email-code"
                v-model="resetEmailCode"
                class="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white placeholder-white/25 outline-none transition-all duration-200 focus:border-violet-500/50 focus:bg-black/40 focus:ring-2 focus:ring-violet-500/20"
                placeholder="输入6位验证码"
                inputmode="numeric"
                maxlength="6"
              >
              <p class="mt-1 text-[11px] text-white/35">
                请输入邮箱验证码以重置密码
              </p>
            </div>

            <div
              v-if="notice"
              class="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-200"
            >
              {{ notice }}
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
              {{ loading ? '处理中...' : isResetMode ? '重置密码' : mode === 'login' ? '登录' : mode === 'register' ? '注册并登录' : '绑定账号' }}
            </button>

            <button
              v-if="mode === 'login' && !forgotPassword"
              class="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3.5 text-sm font-medium text-white/80 transition-all duration-200 hover:bg-white/10 hover:border-white/25 active:scale-[0.98] disabled:opacity-50"
              :disabled="loading"
              type="button"
              @click="onGuest"
            >
              访客快速进入
            </button>

            <button
              v-if="mode === 'login' && !forgotPassword"
              class="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm font-medium text-white/80 transition-all duration-200 hover:bg-white/10 hover:border-white/25 active:scale-[0.98] disabled:opacity-50"
              :disabled="loading"
              type="button"
              @click="openForgotPassword"
            >
              忘记密码？
            </button>

            <button
              v-if="mode === 'login' && forgotPassword"
              class="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm font-medium text-white/80 transition-all duration-200 hover:bg-white/10 hover:border-white/25 active:scale-[0.98] disabled:opacity-50"
              :disabled="loading"
              type="button"
              @click="closeForgotPassword"
            >
              返回登录
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
