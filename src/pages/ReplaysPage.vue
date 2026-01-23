<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/utils/api'
import { useSessionStore } from '@/stores/session'

type ReplayRecord = { id: string; createdAt: string; roomName: string; resultSummary: string; durationMs: number }

const router = useRouter()
const session = useSessionStore()

const records = ref<ReplayRecord[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

async function load() {
  if (!session.token) return
  loading.value = true
  error.value = null
  try {
    const resp = await api.listReplays(session.token)
    records.value = resp.records as any
  } catch (e: any) {
    error.value = e?.message ?? '加载失败'
  } finally {
    loading.value = false
  }
}

function fmtDur(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}

onMounted(load)
</script>

<template>
  <div class="min-h-dvh px-4 py-4">
    <div class="mx-auto max-w-md">
      <div class="sticky top-0 z-10 -mx-4 mb-3 border-b border-white/10 bg-[#0b1020]/95 px-4 py-3 backdrop-blur">
        <div class="flex items-center justify-between">
          <div class="text-base font-semibold">回放</div>
          <div class="flex gap-2">
            <button class="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80" @click="load">
              刷新
            </button>
            <button class="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80" @click="router.push('/lobby')">
              返回
            </button>
          </div>
        </div>
      </div>

      <div v-if="error" class="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
        {{ error }}
      </div>

      <div v-if="loading" class="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-white/70">
        加载中…
      </div>

      <div v-else-if="records.length === 0" class="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-white/70">
        暂无回放。
      </div>

      <div v-else class="space-y-2">
        <button
          v-for="r in records"
          :key="r.id"
          class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-left"
          @click="router.push(`/replays/${r.id}`)"
        >
          <div class="flex items-center justify-between">
            <div class="text-sm font-medium">{{ r.roomName }}</div>
            <div class="text-xs text-white/60">{{ fmtDur(r.durationMs) }}</div>
          </div>
          <div class="mt-1 text-xs text-white/60">{{ new Date(r.createdAt).toLocaleString() }}</div>
          <div class="mt-1 text-xs text-white/80">{{ r.resultSummary }}</div>
        </button>
      </div>
    </div>
  </div>
</template>

