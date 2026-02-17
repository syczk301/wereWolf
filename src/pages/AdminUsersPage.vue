<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { api, type AdminManagedUser } from '@/utils/api'

const router = useRouter()
const session = useSessionStore()

const users = ref<AdminManagedUser[]>([])
const query = ref('')
const loading = ref(false)
const error = ref<string | null>(null)
const savingUserId = ref<string | null>(null)
const deletingUserId = ref<string | null>(null)

const editUserId = ref<string | null>(null)
const editNickname = ref('')
const editPassword = ref('')

const isForbidden = computed(() => error.value === 'FORBIDDEN' || error.value === 'HTTP_403')

function formatDateTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString('zh-CN', { hour12: false })
}

function beginEdit(user: AdminManagedUser) {
  editUserId.value = user.id
  editNickname.value = user.nickname
  editPassword.value = ''
}

function cancelEdit() {
  editUserId.value = null
  editNickname.value = ''
  editPassword.value = ''
}

async function ensureAuthed() {
  if (!session.isInitialized) await session.init()
  if (session.token) return true
  await router.replace('/auth')
  return false
}

async function loadUsers() {
  if (!(await ensureAuthed())) return
  if (!session.token) return

  loading.value = true
  error.value = null
  try {
    const resp = await api.listAdminUsers(session.token, query.value, 200)
    users.value = resp.users
  } catch (e: any) {
    const message = String(e?.message ?? 'LOAD_FAILED')
    if (message === 'UNAUTHORIZED' || message === 'HTTP_401') {
      await session.logout()
      await router.replace('/auth')
      return
    }
    error.value = message
  } finally {
    loading.value = false
  }
}

async function saveUser(user: AdminManagedUser) {
  if (!session.token) return
  const nickname = editNickname.value.trim()
  const password = editPassword.value

  const patch: { nickname?: string; password?: string } = {}
  if (nickname && nickname !== user.nickname) patch.nickname = nickname
  if (password) patch.password = password
  if (!patch.nickname && !patch.password) {
    cancelEdit()
    return
  }

  savingUserId.value = user.id
  error.value = null
  try {
    const resp = await api.updateAdminUser(session.token, user.id, patch)
    users.value = users.value.map((item) => (item.id === user.id ? resp.user : item))
    cancelEdit()
  } catch (e: any) {
    const message = String(e?.message ?? 'UPDATE_FAILED')
    if (message === 'UNAUTHORIZED' || message === 'HTTP_401') {
      await session.logout()
      await router.replace('/auth')
      return
    }
    error.value = message
  } finally {
    savingUserId.value = null
  }
}

async function deleteUser(user: AdminManagedUser) {
  if (!session.token) return
  if (user.id === session.user?.id) return

  const confirmed = window.confirm(`确认删除账号 "${user.emailOrUsername}" 吗？`)
  if (!confirmed) return

  deletingUserId.value = user.id
  error.value = null
  try {
    await api.deleteAdminUser(session.token, user.id)
    users.value = users.value.filter((item) => item.id !== user.id)
    if (editUserId.value === user.id) cancelEdit()
  } catch (e: any) {
    const message = String(e?.message ?? 'DELETE_FAILED')
    if (message === 'UNAUTHORIZED' || message === 'HTTP_401') {
      await session.logout()
      await router.replace('/auth')
      return
    }
    error.value = message
  } finally {
    deletingUserId.value = null
  }
}

onMounted(() => {
  loadUsers()
})
</script>

<template>
  <div class="min-h-dvh relative overflow-hidden">
    <div class="fixed inset-0 z-0 pointer-events-none bg-gradient-to-b from-[#0b1324] via-[#0f1a30] to-[#0b111d]" />

    <header class="relative z-10 px-4 py-4 flex items-center justify-between border-b border-white/10 bg-black/20 backdrop-blur-xl">
      <div>
        <p class="text-[11px] uppercase tracking-widest text-white/35">
          Admin Console
        </p>
        <h1 class="text-lg font-bold text-white/90">
          账号管理
        </h1>
      </div>
      <button
        class="rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10"
        @click="router.push('/lobby')"
      >
        返回大厅
      </button>
    </header>

    <main class="relative z-10 p-4 max-w-5xl mx-auto">
      <div class="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-xl p-4 mb-4">
        <div class="flex flex-col md:flex-row gap-2">
          <input
            v-model="query"
            class="flex-1 rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white placeholder-white/30 outline-none focus:border-cyan-500/60"
            placeholder="搜索 ID / 账号 / 昵称"
            @keyup.enter="loadUsers"
          >
          <button
            class="rounded-xl border border-cyan-500/40 bg-cyan-500/15 px-4 py-2.5 text-sm text-cyan-100 hover:bg-cyan-500/25"
            @click="loadUsers"
          >
            查询
          </button>
          <button
            class="rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm text-white/80 hover:bg-white/10"
            @click="loadUsers"
          >
            刷新
          </button>
        </div>
      </div>

      <div
        v-if="error && !isForbidden"
        class="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200"
      >
        {{ error }}
      </div>

      <div
        v-if="isForbidden"
        class="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-5 text-amber-100"
      >
        <p class="font-semibold">
          当前账号无后台管理权限
        </p>
        <p class="text-sm text-amber-100/80 mt-1">
          请在服务端环境变量设置 `ADMIN_USERNAMES` 或 `ADMIN_USER_IDS`，然后重新登录。
        </p>
      </div>

      <div
        v-else
        class="space-y-3"
      >
        <div
          v-if="loading"
          class="rounded-2xl border border-white/10 bg-white/5 px-4 py-8 text-center text-white/60"
        >
          正在加载账号列表...
        </div>

        <div
          v-else-if="users.length === 0"
          class="rounded-2xl border border-white/10 bg-white/5 px-4 py-8 text-center text-white/50"
        >
          没有匹配的账号
        </div>

        <article
          v-for="user in users"
          :key="user.id"
          class="rounded-2xl border border-white/10 bg-gradient-to-br from-slate-900/70 to-slate-950/70 p-4 text-white/85"
        >
          <div class="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
            <div class="space-y-1 min-w-0">
              <p class="text-sm font-semibold truncate">
                {{ user.nickname }}
              </p>
              <p class="text-xs text-white/55 truncate">
                账号：{{ user.emailOrUsername }}
              </p>
              <p class="text-[11px] text-white/35 font-mono truncate">
                ID: {{ user.id }}
              </p>
              <p class="text-[11px] text-white/35">
                创建：{{ formatDateTime(user.createdAt) }}
              </p>
              <p class="text-[11px] text-white/35">
                最近登录：{{ formatDateTime(user.lastLoginAt) }}
              </p>
            </div>

            <div
              v-if="editUserId !== user.id"
              class="flex gap-2"
            >
              <button
                class="rounded-lg border border-cyan-500/35 bg-cyan-500/15 px-3 py-1.5 text-xs text-cyan-100 hover:bg-cyan-500/25"
                @click="beginEdit(user)"
              >
                编辑
              </button>
              <button
                class="rounded-lg border border-red-500/35 bg-red-500/15 px-3 py-1.5 text-xs text-red-100 hover:bg-red-500/25 disabled:opacity-40"
                :disabled="user.id === session.user?.id || deletingUserId === user.id"
                @click="deleteUser(user)"
              >
                {{ deletingUserId === user.id ? '删除中...' : '删除' }}
              </button>
            </div>
          </div>

          <div
            v-if="editUserId === user.id"
            class="mt-4 grid gap-2 md:grid-cols-[1fr_1fr_auto]"
          >
            <input
              v-model="editNickname"
              class="rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/60"
              placeholder="新昵称（最多20字）"
            >
            <input
              v-model="editPassword"
              type="password"
              class="rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/60"
              placeholder="新密码（留空=不修改）"
            >
            <div class="flex gap-2">
              <button
                class="rounded-lg border border-emerald-500/35 bg-emerald-500/15 px-3 py-2 text-xs text-emerald-100 hover:bg-emerald-500/25"
                :disabled="savingUserId === user.id"
                @click="saveUser(user)"
              >
                {{ savingUserId === user.id ? '保存中...' : '保存' }}
              </button>
              <button
                class="rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-xs text-white/85 hover:bg-white/10"
                :disabled="savingUserId === user.id"
                @click="cancelEdit"
              >
                取消
              </button>
            </div>
          </div>
        </article>
      </div>
    </main>
  </div>
</template>
