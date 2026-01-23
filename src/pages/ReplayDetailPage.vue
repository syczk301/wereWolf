<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '@/utils/api'
import { useSessionStore } from '@/stores/session'

type ReplayEvent = { t: number; type: string; payload: Record<string, any> }
type ReplayDetail = { record: { id: string; createdAt: string; roomName: string; resultSummary: string; durationMs: number }; events: ReplayEvent[] }

const route = useRoute()
const router = useRouter()
const session = useSessionStore()

const replayId = computed(() => String(route.params.replayId || ''))
const detail = ref<ReplayDetail | null>(null)
const error = ref<string | null>(null)
const loading = ref(false)

const playing = ref(false)
const cursor = ref(0)
let timer: number | null = null

const currentEvent = computed(() => detail.value?.events?.[cursor.value] ?? null)

function fmt(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}

function stop() {
  playing.value = false
  if (timer != null) window.clearInterval(timer)
  timer = null
}

function play() {
  if (!detail.value) return
  playing.value = true
  if (timer != null) window.clearInterval(timer)
  timer = window.setInterval(() => {
    if (!detail.value) return
    if (!playing.value) return
    cursor.value = Math.min(detail.value.events.length - 1, cursor.value + 1)
    if (cursor.value >= detail.value.events.length - 1) stop()
  }, 500)
}

async function load() {
  if (!session.token) return
  loading.value = true
  error.value = null
  try {
    const resp = await api.getReplay(session.token, replayId.value)
    detail.value = resp.detail as any
    cursor.value = 0
  } catch (e: any) {
    error.value = e?.message ?? '加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
onUnmounted(stop)
</script>

<template>
  <div class="min-h-dvh px-4 py-4">
    <div class="mx-auto max-w-md">
      <div class="sticky top-0 z-10 -mx-4 mb-3 border-b border-white/10 bg-[#0b1020]/95 px-4 py-3 backdrop-blur">
        <div class="flex items-center justify-between">
          <div class="text-base font-semibold">回放详情</div>
          <div class="flex gap-2">
            <button class="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80" @click="load">刷新</button>
            <button class="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80" @click="router.push('/replays')">返回</button>
          </div>
        </div>
      </div>

      <div v-if="error" class="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
        {{ error }}
      </div>

      <div v-if="loading || !detail" class="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-white/70">
        加载中…
      </div>

      <template v-else>
        <div class="rounded-xl border border-white/10 bg-white/5 p-4">
          <div class="text-sm font-medium">{{ detail.record.roomName }}</div>
          <div class="mt-1 text-xs text-white/60">{{ new Date(detail.record.createdAt).toLocaleString() }}</div>
          <div class="mt-2 text-sm text-white/80">{{ detail.record.resultSummary }}</div>

          <div class="mt-3 flex items-center gap-2">
            <button
              class="flex-1 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white"
              @click="playing ? stop() : play()"
            >
              {{ playing ? '暂停' : '播放' }}
            </button>
            <button
              class="rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white"
              @click="cursor = Math.max(0, cursor - 1)"
            >
              上一条
            </button>
            <button
              class="rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white"
              @click="cursor = Math.min(detail.events.length - 1, cursor + 1)"
            >
              下一条
            </button>
          </div>

          <div class="mt-3 text-xs text-white/60">进度：{{ cursor + 1 }}/{{ detail.events.length }}</div>
        </div>

        <div class="mt-3 rounded-xl border border-white/10 bg-white/5 p-4">
          <div class="mb-2 text-sm font-medium">当前事件</div>
          <div v-if="currentEvent" class="rounded-lg border border-white/10 bg-black/20 p-3">
            <div class="text-xs text-white/60">{{ fmt(currentEvent.t) }} · {{ currentEvent.type }}</div>
            <pre class="mt-2 overflow-auto text-[11px] text-white/80">{{ JSON.stringify(currentEvent.payload, null, 2) }}</pre>
          </div>
        </div>

        <div class="mt-3 rounded-xl border border-white/10 bg-white/5 p-4">
          <div class="mb-2 text-sm font-medium">事件时间线</div>
          <div class="max-h-[45vh] space-y-2 overflow-auto pr-1">
            <button
              v-for="(e, idx) in detail.events"
              :key="idx"
              class="w-full rounded-lg border px-3 py-2 text-left text-xs"
              :class="idx === cursor ? 'border-violet-500/50 bg-violet-600/15 text-white' : 'border-white/10 bg-black/20 text-white/70'"
              @click="cursor = idx"
            >
              <div class="flex items-center justify-between">
                <div>{{ fmt(e.t) }} · {{ e.type }}</div>
                <div class="text-white/50">#{{ idx + 1 }}</div>
              </div>
            </button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

