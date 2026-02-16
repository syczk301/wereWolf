import { nanoid } from 'nanoid'
import { z } from 'zod'
import type { GamePrivateState, GamePublicState, ReplayDetail, ReplayEvent, Role, Side } from '../../shared/types.js'
import { getDb } from '../db/mongo.js'
import { getRedis } from '../db/redis.js'
import { roomService } from './roomService.js'
import { computeWinner } from '../game/rules.js'

type GamePlayer = {
  seat: number
  userId: string
  nickname: string
  role: Role
  isAlive: boolean
  isBot: boolean
}

type GameRuntime = {
  gameId: string
  roomId: string
  roomName: string
  startedAt: number
  phase: GamePublicState['phase']
  dayNo: number
  phaseEndsAt: number
  players: GamePlayer[]
  roleConfig: { werewolf: number; seer: number; witch: number; hunter: number; guard: number }
  timers: { nightSeconds: number; daySpeechSeconds: number; dayVoteSeconds: number; settlementSeconds: number }
  publicLog: { id: string; at: number; text: string }[]
  hintsByUserId: Record<string, { id: string; at: number; text: string }[]>
  night: {
    wolfVotes: Record<string, number>
    seerTarget?: number
    guardTarget?: number
    witchSave?: boolean
    witchPoisonTarget?: number
    witchSaveUsed: boolean
    witchPoisonUsed: boolean
  }
  day: {
    votes: Record<string, number | null>
    stage: 1 | 2
    candidates?: number[]
  }
  settlement: {
    pendingHunterSeat?: number
  }
  events: ReplayEvent[]
  activeRole?: string | null
  activeSpeakerSeat?: number | null
  speakingQueue: number[]
  sheriffSeat?: number | null
  election?: {
    candidates: number[]
    votes: Record<string, number | null>
    stage: 1 | 2
  }
}

type VoiceTurnInfo = {
  roomId: string
  gameId: string
  phase: GamePublicState['phase']
  isSpeechPhase: boolean
  activeSpeakerSeat: number | null
  activeSpeakerUserId: string | null
  seat: number
  userId: string
  isCurrentSpeaker: boolean
}

const actionSchema = z.object({
  actionType: z.string().min(1),
  payload: z.any(),
})

async function loadGame(gameId: string): Promise<GameRuntime | null> {
  const redis = await getRedis()
  const raw = await redis.get(`gamert:${gameId}`)
  if (!raw) return null
  return JSON.parse(String(raw)) as GameRuntime
}

async function getVoiceTurnInfoInternal(roomId: string, userId: string): Promise<VoiceTurnInfo> {
  const roomRt = await roomService.getRuntime(roomId)
  if (!roomRt.gameId) throw new Error('NOT_PLAYING')

  const rt = await loadGame(roomRt.gameId)
  if (!rt) throw new Error('GAME_NOT_FOUND')

  const me = rt.players.find((x) => x.userId === userId)
  if (!me) throw new Error('NOT_IN_GAME')

  const activeSpeakerSeat = rt.activeSpeakerSeat ?? null
  const activeSpeakerUserId = activeSpeakerSeat == null
    ? null
    : (rt.players.find((x) => x.seat === activeSpeakerSeat)?.userId ?? null)

  const isSpeechPhase = rt.phase === 'day_speech' || rt.phase === 'sheriff_speech'

  return {
    roomId,
    gameId: roomRt.gameId,
    phase: rt.phase,
    isSpeechPhase,
    activeSpeakerSeat,
    activeSpeakerUserId,
    seat: me.seat,
    userId,
    isCurrentSpeaker: activeSpeakerSeat != null && me.seat === activeSpeakerSeat,
  }
}

async function saveGame(rt: GameRuntime) {
  const redis = await getRedis()
  await redis.set(`gamert:${rt.gameId}`, JSON.stringify(rt))
}

async function addActiveGame(gameId: string) {
  const redis = await getRedis()
  await redis.sAdd('games:active', gameId)
}

async function removeActiveGame(gameId: string) {
  const redis = await getRedis()
  await redis.sRem('games:active', gameId)
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function toPublic(rt: GameRuntime): GamePublicState {
  const bySeat = new Map(rt.players.map((p) => [p.seat, p]))
  return {
    gameId: rt.gameId,
    roomId: rt.roomId,
    phase: rt.phase,
    dayNo: rt.dayNo,
    serverNow: nowMs(),
    phaseEndsAt: rt.phaseEndsAt,
    players: rt.players
      .map((p) => ({
        seat: p.seat,
        user: { id: p.userId, nickname: p.nickname },
        isReady: false,
        isAlive: p.isAlive,
      }))
      .sort((a, b) => a.seat - b.seat),
    publicLog: rt.publicLog.slice(-60),
    activeRole: rt.activeRole,
    activeSpeakerSeat: rt.activeSpeakerSeat,
    speakingQueue: rt.speakingQueue,
    sheriffSeat: rt.sheriffSeat,
  }
}

function toPrivate(rt: GameRuntime, userId: string): GamePrivateState {
  const p = rt.players.find((x) => x.userId === userId)
  if (!p) throw new Error('NOT_IN_GAME')

  let selectedTargetSeat: number | null = null
  let witchSaveDecision = false

  if (rt.phase === 'night') {
    if (p.role === 'werewolf') selectedTargetSeat = rt.night.wolfVotes[userId] ?? null
    else if (p.role === 'seer') selectedTargetSeat = rt.night.seerTarget ?? null
    else if (p.role === 'guard') selectedTargetSeat = rt.night.guardTarget ?? null
    else if (p.role === 'witch') {
      selectedTargetSeat = rt.night.witchPoisonTarget ?? null
      witchSaveDecision = rt.night.witchSave

      // 计算狼人击杀目标
      let victim: number | null = null
      const voteTargets = Object.values(rt.night.wolfVotes)
      if (voteTargets.length) {
        const counts = new Map<number, number>()
        for (const s of voteTargets) counts.set(s, (counts.get(s) ?? 0) + 1)
        const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
        victim = sorted[0]?.[0] ?? null
      }

      // 如果解药已用，或者今晚自己被杀了（虽然女巫可以自救？规则通常第一晚可以），
      // 这里简单处理：只要有victim就给前端，前端判断能否救
      // 通常规则：全程不能自救，或仅第一晚可自救。这里先不强制后端限制，把信息给前端。

      return {
        role: p.role,
        seat: p.seat,
        hints: (rt.hintsByUserId[userId] ?? []).slice(-60),
        actions: {
          hunterShoot: (rt.phase as string) === 'settlement' && rt.settlement.pendingHunterSeat === p.seat,
        },
        selectedTargetSeat,
        witchSaveDecision,
        witchInfo: {
          nightVictimSeat: victim,
          saveUsed: rt.night.witchSaveUsed,
          poisonUsed: rt.night.witchPoisonUsed
        }
      }
    }
  } else if (rt.phase === 'day_vote') {
    selectedTargetSeat = rt.day.votes[userId]
  }

  // Wolves can see their teammates
  const wolfTeam = p.role === 'werewolf'
    ? rt.players.filter(x => x.role === 'werewolf').map(x => ({ seat: x.seat, nickname: x.nickname, isAlive: x.isAlive }))
    : undefined

  return {
    role: p.role,
    seat: p.seat,
    hints: (rt.hintsByUserId[userId] ?? []).slice(-60),
    actions: {
      hunterShoot: rt.phase === 'settlement' && rt.settlement.pendingHunterSeat === p.seat,
    },
    selectedTargetSeat,
    witchSaveDecision,
    wolfTeam,
  }
}

function nowMs() {
  return Date.now()
}

function t(rt: GameRuntime) {
  return nowMs() - rt.startedAt
}

function pushEvent(rt: GameRuntime, type: ReplayEvent['type'], payload: Record<string, unknown>) {
  rt.events.push({ t: t(rt), type, payload })
}

function pushLog(rt: GameRuntime, text: string) {
  rt.publicLog.push({ id: nanoid(10), at: nowMs(), text })
}

function pushHint(rt: GameRuntime, userId: string, text: string) {
  rt.hintsByUserId[userId] = rt.hintsByUserId[userId] ?? []
  rt.hintsByUserId[userId].push({ id: nanoid(10), at: nowMs(), text })
}

function countAlive(rt: GameRuntime) {
  return rt.players.filter((p) => p.isAlive)
}

function winner(rt: GameRuntime): Side | null {
  return computeWinner(rt.players)
}

function phaseDurationMs(rt: GameRuntime, phase: GameRuntime['phase']) {
  if (phase === 'night') return rt.timers.nightSeconds * 1000
  if (phase === 'day_speech') return rt.timers.daySpeechSeconds * 1000
  if (phase === 'day_vote') return rt.timers.dayVoteSeconds * 1000
  if (phase === 'settlement') return rt.timers.settlementSeconds * 1000
  if (phase === 'sheriff_election') return 20 * 1000 // Enrollment period
  if (phase === 'sheriff_speech') return rt.timers.daySpeechSeconds * 1000
  if (phase === 'sheriff_vote') return 30 * 1000
  return 10 * 1000
}

function startPhase(rt: GameRuntime, phase: GameRuntime['phase']) {
  rt.phase = phase
  rt.phaseEndsAt = nowMs() + phaseDurationMs(rt, phase)
  pushEvent(rt, 'phase_changed', { phase, dayNo: rt.dayNo })

  if (phase === 'night') {
    rt.night.wolfVotes = {}
    rt.night.seerTarget = undefined
    rt.night.guardTarget = undefined
    rt.night.witchSave = false
    rt.night.witchPoisonTarget = undefined
    rt.activeRole = 'werewolf'
    rt.activeSpeakerSeat = null
    rt.speakingQueue = []
    pushLog(rt, '天黑请闭眼')
    pushLog(rt, '狼人请睁眼')
    rt.phaseEndsAt = nowMs() + NIGHT_ROLE_DURATION_SEC * 1000
  } else if (phase === 'sheriff_election') {
    rt.activeRole = null
    rt.activeSpeakerSeat = null
    rt.speakingQueue = []
    rt.election = { candidates: [], votes: {}, stage: 1 }
  } else if (phase === 'sheriff_speech') {
    rt.activeRole = null
    if (rt.election?.candidates.length) {
      rt.speakingQueue = [...rt.election.candidates]
      rt.activeSpeakerSeat = rt.speakingQueue[0]
      rt.phaseEndsAt = nowMs() + rt.timers.daySpeechSeconds * 1000
    } else {
      // No candidates, skip to day speech
      startPhase(rt, 'day_speech')
    }
  } else if (phase === 'day_speech') {
    rt.activeRole = null
    if (rt.speakingQueue.length > 0) {
      rt.activeSpeakerSeat = rt.speakingQueue[0]
      // Sync timer to start of speech
      rt.phaseEndsAt = nowMs() + rt.timers.daySpeechSeconds * 1000
    }
  } else {
    rt.activeRole = null
  }

  if (phase === 'day_vote') {
    rt.day.votes = {}
    rt.activeSpeakerSeat = null
    rt.speakingQueue = []
  }

  // Night phase: bots act on timeout so all players see role announcements.
  // Other phases: bots act immediately.
  if (phase !== 'night') {
    triggerBotAction(rt)
  }
}


function initializeSpeakingQueue(rt: GameRuntime, eliminatedSeats: number[]) {
  const aliveSeats = rt.players.filter((p) => p.isAlive).map((p) => p.seat).sort((a, b) => a - b)
  if (aliveSeats.length === 0) return

  let startSeat = aliveSeats[0]
  if (eliminatedSeats.length > 0) {
    // Start with next alive person after the first eliminated one
    const firstDead = eliminatedSeats[0]
    const nextLiving = aliveSeats.find(s => s > firstDead) || aliveSeats[0]
    startSeat = nextLiving
  }

  const startIndex = aliveSeats.indexOf(startSeat)
  const queue = [...aliveSeats.slice(startIndex), ...aliveSeats.slice(0, startIndex)]
  rt.speakingQueue = queue
  rt.activeSpeakerSeat = queue[0]
}

function advanceSpeaker(rt: GameRuntime) {
  if (!rt.speakingQueue.length) return
  const currentIndex = rt.speakingQueue.indexOf(rt.activeSpeakerSeat || -1)
  if (currentIndex === -1 || currentIndex === rt.speakingQueue.length - 1) {
    // End of speech
    const wasSheriffElection = rt.phase === 'sheriff_speech'
    rt.activeSpeakerSeat = null
    rt.speakingQueue = []
    if (wasSheriffElection) {
      startPhase(rt, 'sheriff_vote')
    } else {
      startPhase(rt, 'day_vote')
    }
  } else {
    rt.activeSpeakerSeat = rt.speakingQueue[currentIndex + 1]
    rt.phaseEndsAt = nowMs() + rt.timers.daySpeechSeconds * 1000
    pushEvent(rt, 'speaker_changed', { seat: rt.activeSpeakerSeat })
  }
}

function resolveSheriffVote(rt: GameRuntime) {
  if (!rt.election) return
  const votes = Object.values(rt.election.votes).filter((v): v is number => typeof v === 'number')
  if (votes.length === 0) {
    pushLog(rt, '无人投票，无警长')
    startPhase(rt, 'day_speech')
    return
  }

  const counts = new Map<number, number>()
  for (const v of votes) counts.set(v, (counts.get(v) ?? 0) + 1)
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const top = sorted[0][1]
  const tied = sorted.filter((x) => x[1] === top).map((x) => x[0])

  if (tied.length === 1) {
    rt.sheriffSeat = tied[0]
    pushLog(rt, `${rt.sheriffSeat} 号当选警长`)
    pushEvent(rt, 'sheriff_elected', { seat: rt.sheriffSeat })
    startPhase(rt, 'day_speech')
  } else {
    if (rt.election.stage === 1) {
      rt.election.stage = 2
      rt.election.candidates = tied
      rt.election.votes = {}
      pushLog(rt, `平票：${tied.join('、')} 号，进入警长PK`)
      startPhase(rt, 'sheriff_speech')
    } else {
      pushLog(rt, '再次平票，本局无警长')
      startPhase(rt, 'day_speech')
    }
  }
}

const NIGHT_ROLE_LABELS: Record<string, string> = {
  werewolf: '狼人请睁眼',
  seer: '预言家请睁眼',
  witch: '女巫请睁眼',
  guard: '守卫请睁眼',
}

const NIGHT_ROLE_CLOSE_LABELS: Record<string, string> = {
  werewolf: '狼人请闭眼',
  seer: '预言家请闭眼',
  witch: '女巫请闭眼',
  guard: '守卫请闭眼',
}

// Minimum seconds each night sub-role stage lasts (so players can see the announcement)
const NIGHT_ROLE_DURATION_SEC = 8

function advanceNightRole(rt: GameRuntime) {
  const sequence = ['werewolf', 'seer', 'witch', 'guard']
  const currentIndex = sequence.indexOf(rt.activeRole || '')

  // Log "X请闭眼" for current role
  if (rt.activeRole && NIGHT_ROLE_CLOSE_LABELS[rt.activeRole]) {
    pushLog(rt, NIGHT_ROLE_CLOSE_LABELS[rt.activeRole])
  }

  for (let i = currentIndex + 1; i < sequence.length; i++) {
    const nextRole = sequence[i]
    const hasRole = rt.players.some(p => p.isAlive && p.role === nextRole)
    if (hasRole) {
      rt.activeRole = nextRole
      pushLog(rt, NIGHT_ROLE_LABELS[nextRole] || `${nextRole}行动`)
      pushEvent(rt, 'phase_changed', { phase: 'night', dayNo: rt.dayNo, activeRole: nextRole })
      rt.phaseEndsAt = nowMs() + NIGHT_ROLE_DURATION_SEC * 1000
      // Do NOT call triggerBotAction here -- let the timer expire first so
      // all players see the role announcement. Bots act on next timeout tick.
      return
    }
  }

  // No more roles, resolve night
  resolveNight(rt)
}

function resolveNight(rt: GameRuntime) {
  const alivePlayers = rt.players.filter((p) => p.isAlive)
  const wolves = alivePlayers.filter((p) => p.role === 'werewolf')
  const voteTargets = Object.values(rt.night.wolfVotes)
  let wolfTarget: number | null = null

  if (voteTargets.length) {
    const counts = new Map<number, number>()
    for (const s of voteTargets) counts.set(s, (counts.get(s) ?? 0) + 1)
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
    wolfTarget = sorted[0]?.[0] ?? null
  }

  const deaths = new Set<number>()

  if (wolfTarget) {
    const witch = alivePlayers.find((p) => p.role === 'witch')
    const guardTarget = rt.night.guardTarget
    const saved = !!witch && !rt.night.witchSaveUsed && rt.night.witchSave === true

    if (saved) {
      rt.night.witchSaveUsed = true
      pushLog(rt, '女巫使用了解药')
    }

    if (!saved && (!guardTarget || guardTarget !== wolfTarget)) {
      deaths.add(wolfTarget)
    }
  }

  if (rt.night.witchPoisonTarget && !rt.night.witchPoisonUsed) {
    const witch = alivePlayers.find((p) => p.role === 'witch')
    if (witch) {
      rt.night.witchPoisonUsed = true
      deaths.add(rt.night.witchPoisonTarget)
      pushLog(rt, '女巫使用了毒药')
    }
  }

  const eliminated: number[] = []
  for (const seat of deaths) {
    const p = rt.players.find((x) => x.seat === seat)
    if (p && p.isAlive) {
      p.isAlive = false
      eliminated.push(seat)
    }
  }

  if (eliminated.length) {
    pushLog(rt, `天亮了，${eliminated.join('、')}号出局`)
  } else {
    pushLog(rt, '天亮了，无人出局')
  }

  pushEvent(rt, 'night_result', { eliminated })

  const hunter = eliminated
    .map((s) => rt.players.find((p) => p.seat === s))
    .find((p) => p?.role === 'hunter')

  if (hunter) {
    rt.settlement.pendingHunterSeat = hunter.seat
    startPhase(rt, 'settlement')
  } else {
    rt.dayNo += 1
    if (rt.dayNo === 1 && rt.players.length >= 12 && !rt.sheriffSeat) {
      startPhase(rt, 'sheriff_election')
    } else {
      initializeSpeakingQueue(rt, eliminated)
      startPhase(rt, 'day_speech')
    }
  }
}

function resolveVote(rt: GameRuntime): { eliminatedSeat: number | null; tiedSeats: number[] } {
  const alive = rt.players.filter((p) => p.isAlive).map((p) => p.seat)
  const candidates = rt.day.stage === 2 && rt.day.candidates?.length ? rt.day.candidates : alive

  const counts = new Map<number, number>()
  for (const p of rt.players) {
    const vote = rt.day.votes[p.userId]
    if (vote == null || !candidates.includes(vote)) continue

    let weight = 1
    if (rt.sheriffSeat === p.seat) weight = 1.5

    counts.set(vote, (counts.get(vote) ?? 0) + weight)
  }

  if (counts.size === 0) return { eliminatedSeat: null, tiedSeats: [] }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const top = sorted[0][1]
  const tied = sorted.filter((x) => x[1] === top).map((x) => x[0])
  if (tied.length === 1) return { eliminatedSeat: tied[0], tiedSeats: [] }
  return { eliminatedSeat: null, tiedSeats: tied }
}

async function persistReplay(rt: GameRuntime, resultSummary: string) {
  const db = await getDb()
  const replays = db.collection<{ _id: string; ownerUserIds: string[]; createdAt: Date; durationMs: number; resultSummary: string; roomName: string; roomId: string; gameId: string; events: ReplayEvent[] }>('replays')
  const replayId = nanoid(12)
  const durationMs = nowMs() - rt.startedAt
  const ownerUserIds = rt.players.map((p) => p.userId)
  await replays.insertOne({
    _id: replayId,
    gameId: rt.gameId,
    roomId: rt.roomId,
    roomName: rt.roomName,
    ownerUserIds,
    createdAt: new Date(),
    durationMs,
    resultSummary,
    events: rt.events,
  })
  return replayId
}

async function finalizeIfWinner(rt: GameRuntime) {
  const w = winner(rt)
  if (!w) return { ended: false as const }

  rt.phase = 'game_over'
  rt.phaseEndsAt = nowMs() + 10 * 1000
  const summary = w === 'werewolves' ? '狼人胜利' : '好人胜利'
  pushLog(rt, summary)
  pushEvent(rt, 'game_result', {
    winner: w,
    roles: rt.players.map((p) => ({ seat: p.seat, nickname: p.nickname, role: p.role })),
  })
  const replayId = await persistReplay(rt, summary)
  await roomService.markEnded(rt.roomId)
  await removeActiveGame(rt.gameId)
  for (const p of rt.players) pushHint(rt, p.userId, `本局结束：${summary}（回放ID: ${replayId}）`)
  return { ended: true as const, winner: w, replayId, summary }
}

function validateRoleConfig(playerCount: number, rc: GameRuntime['roleConfig']) {
  const totalSpecial = rc.seer + rc.witch + rc.hunter + rc.guard
  const total = rc.werewolf + totalSpecial
  if (rc.werewolf < 1) throw new Error('狼人数量至少 1')
  // if (rc.werewolf > Math.min(5, playerCount - 2)) throw new Error('狼人数量过多')
  if (total > playerCount) throw new Error('身份总数超过玩家数')
  // if (playerCount - total < 1) throw new Error('至少需要 1 名村民')
}

function triggerBotAction(rt: GameRuntime) {
  // 1. NIGHT ACTIONS -- bots only perform their action, never call advanceNightRole.
  // Phase advancement is handled by the timeout mechanism so all players see each role stage.
  if (rt.phase === 'night' && rt.activeRole) {
    const bots = rt.players.filter((p) => p.isBot && p.isAlive && p.role === rt.activeRole)
    if (bots.length === 0) return

    if (rt.activeRole === 'werewolf') {
      for (const bot of bots) {
        if (rt.night.wolfVotes[bot.userId] == null) {
          const targets = rt.players.filter((p) => p.isAlive && p.role !== 'werewolf').map((p) => p.seat)
          if (targets.length) {
            const target = targets[Math.floor(Math.random() * targets.length)]
            rt.night.wolfVotes[bot.userId] = target
            pushEvent(rt, 'action_submitted', { actionType: 'night.wolfKill', seat: bot.seat })
          }
        }
      }
    } else if (rt.activeRole === 'seer') {
      const bot = bots[0]
      if (rt.night.seerTarget == null) {
        const targets = rt.players.filter((p) => p.isAlive && p.seat !== bot.seat).map((p) => p.seat)
        if (targets.length) {
          const target = targets[Math.floor(Math.random() * targets.length)]
          rt.night.seerTarget = target
          pushEvent(rt, 'action_submitted', { actionType: 'night.seerCheck', seat: bot.seat })
        }
      }
    } else if (rt.activeRole === 'guard') {
      const bot = bots[0]
      if (rt.night.guardTarget == null) {
        const targets = rt.players.filter((p) => p.isAlive).map((p) => p.seat)
        if (targets.length) {
          const target = targets[Math.floor(Math.random() * targets.length)]
          rt.night.guardTarget = target
          pushEvent(rt, 'action_submitted', { actionType: 'night.guardProtect', seat: bot.seat })
        }
      }
    } else if (rt.activeRole === 'witch') {
      const bot = bots[0]
      const voteTargets = Object.values(rt.night.wolfVotes)
      let victimSeat: number | null = null
      if (voteTargets.length) {
        const counts = new Map<number, number>()
        for (const s of voteTargets) counts.set(s, (counts.get(s) ?? 0) + 1)
        victimSeat = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      }

      let saved = false
      if (victimSeat && !rt.night.witchSaveUsed && rt.night.witchSave === false) {
        if (Math.random() < 0.5) {
          rt.night.witchSave = true
          pushEvent(rt, 'action_submitted', { actionType: 'night.witch.save', seat: bot.seat })
          saved = true
        }
      }

      if (!saved && !rt.night.witchPoisonUsed && rt.night.witchPoisonTarget == null) {
        if (Math.random() < 0.15) {
          const targets = rt.players.filter((p) => p.isAlive && p.seat !== bot.seat).map((p) => p.seat)
          if (targets.length) {
            const target = targets[Math.floor(Math.random() * targets.length)]
            rt.night.witchPoisonTarget = target
            pushEvent(rt, 'action_submitted', { actionType: 'night.witch.poison', seat: bot.seat })
          }
        }
      }
    }
  }

  // 2. DAY VOTE
  if (rt.phase === 'day_vote') {
    const bots = rt.players.filter((p) => p.isBot && p.isAlive && rt.day.votes[p.userId] === undefined)
    const candidates = rt.day.stage === 2 && rt.day.candidates?.length ? rt.day.candidates : rt.players.filter((p) => p.isAlive).map((p) => p.seat)

    let voted = false
    for (const bot of bots) {
      if (candidates.length) {
        const target = candidates[Math.floor(Math.random() * candidates.length)]
        rt.day.votes[bot.userId] = target
        // pushEvent(rt, 'action_submitted', { actionType: 'day.vote', seat: bot.seat }) // Optional: log bot votes?
        voted = true
      }
    }

    if (voted) {
      const alive = rt.players.filter((p) => p.isAlive)
      const allVoted = alive.every((p) => rt.day.votes[p.userId] !== undefined)
      if (allVoted) {
        const result = resolveVote(rt)
        if (result.tiedSeats.length && rt.day.stage === 1) {
          rt.day.stage = 2
          rt.day.candidates = result.tiedSeats
          pushLog(rt, `平票：${result.tiedSeats.join('、')} 号，进入复投`)
          pushEvent(rt, 'vote_result', { stage: 1, tiedSeats: result.tiedSeats })
          startPhase(rt, 'day_vote')
        } else {
          const eliminatedSeat = result.eliminatedSeat
          pushEvent(rt, 'vote_result', { stage: rt.day.stage, eliminatedSeat, tiedSeats: result.tiedSeats })

          if (!eliminatedSeat) {
            pushLog(rt, '投票无结果，直接进入夜晚')
            startPhase(rt, 'night')
          } else {
            const eliminated = rt.players.find((p) => p.seat === eliminatedSeat)
            if (eliminated && eliminated.isAlive) eliminated.isAlive = false
            pushLog(rt, `${eliminatedSeat} 号被放逐`)
            pushEvent(rt, 'player_eliminated', { seat: eliminatedSeat, reason: 'vote' })

            if (eliminated?.role === 'hunter') {
              rt.settlement.pendingHunterSeat = eliminated.seat
              startPhase(rt, 'settlement')
            } else {
              startPhase(rt, 'night')
            }
          }
          rt.day.stage = 1
          rt.day.candidates = undefined
          rt.day.votes = {}
        }
      }
    }
  }
}

export const gameService = {
  async getGamePublicState(gameId: string) {
    const rt = await loadGame(gameId)
    if (!rt) throw new Error('GAME_NOT_FOUND')
    return toPublic(rt)
  },

  async getGamePublicStateByRoom(roomId: string) {
    const roomRt = await roomService.getRuntime(roomId)
    if (!roomRt.gameId) return null
    const rt = await loadGame(roomRt.gameId)
    if (!rt) return null
    return toPublic(rt)
  },

  async getGamePrivateState(gameId: string, userId: string) {
    const rt = await loadGame(gameId)
    if (!rt) throw new Error('GAME_NOT_FOUND')
    return toPrivate(rt, userId)
  },

  async getWolfUserIds(gameId: string) {
    const rt = await loadGame(gameId)
    if (!rt) return []
    return rt.players.filter(p => p.role === 'werewolf').map(p => p.userId)
  },

  async getVoiceTurnInfo(roomId: string, userId: string) {
    return await getVoiceTurnInfoInternal(roomId, userId)
  },

  async canSpeakVoiceNow(roomId: string, userId: string) {
    const info = await getVoiceTurnInfoInternal(roomId, userId)
    return info.isSpeechPhase && info.isCurrentSpeaker
  },

  async startGame(roomId: string, requesterUserId: string) {
    const roomRt = await roomService.getRuntime(roomId)
    if (roomRt.ownerUserId !== requesterUserId) throw new Error('仅房主可开局')
    if (roomRt.status !== 'waiting') throw new Error('房间状态不允许开局')

    const players = roomRt.members.filter((m) => !!m.userId).map((m) => ({
      seat: m.seat,
      userId: m.userId!,
      nickname: m.nickname!,
      isBot: !!m.isBot,
      isReady: m.isReady,
    }))

    if (players.length < 1) throw new Error('至少需要 1 人')

    // 检查人数是否足够
    if (players.length < roomRt.maxPlayers) {
      const needed = roomRt.maxPlayers - players.length
      throw new Error(`NEED_BOTS:${needed}:人数不足，还需要 ${needed} 名玩家`)
    }
    if (players.some((p) => !p.isReady)) throw new Error('仍有玩家未准备')

    validateRoleConfig(players.length, roomRt.roleConfig)

    const roles: Role[] = []
    for (let i = 0; i < roomRt.roleConfig.werewolf; i++) roles.push('werewolf')
    for (let i = 0; i < roomRt.roleConfig.seer; i++) roles.push('seer')
    for (let i = 0; i < roomRt.roleConfig.witch; i++) roles.push('witch')
    for (let i = 0; i < roomRt.roleConfig.hunter; i++) roles.push('hunter')
    for (let i = 0; i < roomRt.roleConfig.guard; i++) roles.push('guard')
    while (roles.length < players.length) roles.push('villager')

    const assignedRoles = shuffle(roles)

    const gameId = nanoid(12)
    const startedAt = nowMs()
    const rt: GameRuntime = {
      gameId,
      roomId,
      roomName: roomRt.name,
      startedAt,
      phase: 'night',
      dayNo: 0,
      phaseEndsAt: startedAt + roomRt.timers.nightSeconds * 1000,
      players: players.map((p, idx) => ({
        seat: p.seat,
        userId: p.userId,
        nickname: p.nickname,
        role: assignedRoles[idx],
        isBot: p.isBot,
        isAlive: true,
      })),
      roleConfig: roomRt.roleConfig,
      timers: roomRt.timers,
      publicLog: [],
      hintsByUserId: {},
      night: {
        wolfVotes: {},
        seerTarget: undefined,
        guardTarget: undefined,
        witchSave: false,
        witchPoisonTarget: undefined,
        witchSaveUsed: false,
        witchPoisonUsed: false,
      },
      day: { votes: {}, stage: 1, candidates: undefined },
      settlement: { pendingHunterSeat: undefined },
      events: [],
      activeRole: 'werewolf',
      speakingQueue: [],
      activeSpeakerSeat: null,
      sheriffSeat: null,
    }

    pushLog(rt, '游戏开始，夜晚降临')
    pushEvent(rt, 'phase_changed', { phase: 'night', dayNo: 0 })

    await saveGame(rt)
    await addActiveGame(rt.gameId)
    const roomState = await roomService.attachGame(roomId, gameId)
    const gamePublic = toPublic(rt)

    return { roomState, gamePublic }
  },

  async appendChat(roomId: string, userId: string, nickname: string, text: string, channel: 'public' | 'wolf' = 'public') {
    const trimmed = String(text ?? '').trim().slice(0, 200)
    if (!trimmed) throw new Error('EMPTY')

    const roomRt = await roomService.getRuntime(roomId)
    if (!roomRt.gameId) throw new Error('NOT_PLAYING')

    const rt = await loadGame(roomRt.gameId)
    if (!rt) throw new Error('GAME_NOT_FOUND')

    const p = rt.players.find((x) => x.userId === userId)
    if (!p) throw new Error('NOT_IN_GAME')

    if (channel === 'wolf') {
      if (p.role !== 'werewolf') throw new Error('你不是狼人')
    } else {
      const isSpeechPhase = rt.phase === 'day_speech' || rt.phase === 'sheriff_speech'
      if (!isSpeechPhase) throw new Error('仅发言阶段可公开发言')
      if (rt.activeSpeakerSeat == null || p.seat !== rt.activeSpeakerSeat) {
        throw new Error('未到你的发言回合')
      }
    }

    const msg = { id: nanoid(10), at: nowMs(), sender: { id: userId, nickname }, text: trimmed, channel }

    // We don't push private chat to public events/logs to keep it hidden
    if (channel === 'public') {
      pushEvent(rt, 'chat_message', msg)
      pushLog(rt, `${nickname}: ${trimmed}`)
    }
    // For wolf chat, we could push a private event or just rely on socket delivery.
    // For simplicity and replay security, we don't push to publicLog.

    await saveGame(rt)
    return msg
  },

  async submitAction(roomId: string, userId: string, input: { actionType: string; payload: any }) {
    const parsed = actionSchema.parse(input)
    const roomRt = await roomService.getRuntime(roomId)
    if (!roomRt.gameId) throw new Error('NOT_PLAYING')

    const rt = await loadGame(roomRt.gameId)
    if (!rt) throw new Error('GAME_NOT_FOUND')

    const actor = rt.players.find((p) => p.userId === userId)
    if (!actor) throw new Error('NOT_IN_GAME')

    const privateUserIds = new Set<string>()

    if (rt.phase === 'night') {
      if (parsed.actionType === 'night.wolfKill') {
        if (actor.role !== 'werewolf' || rt.activeRole !== 'werewolf') throw new Error('当前非狼人行动时间')
        if (rt.night.wolfVotes[userId] != null) throw Error('今晚已行动过，不可更改')
        const targetSeat = Number(parsed.payload?.targetSeat)
        if (!Number.isFinite(targetSeat)) throw new Error('目标无效')
        rt.night.wolfVotes[userId] = targetSeat
        pushEvent(rt, 'action_submitted', { actionType: 'night.wolfKill', seat: actor.seat })
        // 夜间统一按计时推进，避免不同客户端看到不同节奏。
      }

      if (parsed.actionType === 'night.seerCheck') {
        if (actor.role !== 'seer' || rt.activeRole !== 'seer') throw new Error('当前非预言家行动时间')
        if (rt.night.seerTarget != null) throw new Error('今晚已查验过，不可更改')
        const targetSeat = Number(parsed.payload?.targetSeat)
        const target = rt.players.find((p) => p.seat === targetSeat)
        if (!target) throw new Error('目标无效')
        rt.night.seerTarget = targetSeat
        pushEvent(rt, 'action_submitted', { actionType: 'night.seerCheck', seat: actor.seat })
        pushHint(rt, userId, `你查验了 ${targetSeat} 号：${target.role === 'werewolf' ? '狼人' : '好人'}`)
        privateUserIds.add(userId)
      }

      if (parsed.actionType === 'night.guardProtect') {
        if (actor.role !== 'guard' || rt.activeRole !== 'guard') throw new Error('当前非守卫行动时间')
        if (rt.night.guardTarget != null) throw new Error('今晚已选择守护目标，不可更改')
        const targetSeat = Number(parsed.payload?.targetSeat)
        if (targetSeat !== 0) {
          const target = rt.players.find((p) => p.seat === targetSeat)
          if (!target) throw new Error('目标无效')
          rt.night.guardTarget = targetSeat
        } else {
          rt.night.guardTarget = 0 // Explicit no-op
        }
        pushEvent(rt, 'action_submitted', { actionType: 'night.guardProtect', seat: actor.seat })
      }

      if (parsed.actionType === 'night.witch.save') {
        if (actor.role !== 'witch' || rt.activeRole !== 'witch') throw new Error('当前非女巫行动时间')
        if (rt.night.witchSaveUsed) throw new Error('解药已用')
        if (rt.night.witchSave === true) throw new Error('今晚已决定救人，不可更改')
        const use = Boolean(parsed.payload?.use)
        rt.night.witchSave = use
        pushEvent(rt, 'action_submitted', { actionType: 'night.witch.save', seat: actor.seat })

        // If witch used save, they can't use poison? Or they can? 
        // Rules vary, but let's assume if they used either or decided NOT to use, they are done for this phase if they don't have poison.
        // Usually Witch has two sub-phases: Save and Poison.
        // To simplify, let's say Witch action is one "turn".
      }

      if (parsed.actionType === 'night.witch.poison') {
        if (actor.role !== 'witch' || rt.activeRole !== 'witch') throw new Error('当前非女巫行动时间')
        if (rt.night.witchPoisonUsed) throw new Error('毒药已用')
        if (rt.night.witchPoisonTarget != null) throw new Error('今晚已使用毒药，不可更改')
        const targetSeat = parsed.payload?.targetSeat == null ? null : Number(parsed.payload?.targetSeat)
        if (targetSeat != null) {
          const target = rt.players.find((p) => p.seat === targetSeat)
          if (!target) throw new Error('目标无效')
          rt.night.witchPoisonTarget = targetSeat
        } else {
          rt.night.witchPoisonTarget = undefined
        }
        pushEvent(rt, 'action_submitted', { actionType: 'night.witch.poison', seat: actor.seat })
      }
    }

    if (rt.phase === 'day_speech' || rt.phase === 'sheriff_speech') {
      if (parsed.actionType === 'game.nextSpeaker' && actor.seat === rt.activeSpeakerSeat) {
        advanceSpeaker(rt)
      }
    }

    if (rt.phase === 'sheriff_election') {
      if (parsed.actionType === 'sheriff.enroll') {
        if (!actor.isAlive) throw new Error('已出局')
        if (rt.election?.candidates.includes(actor.seat)) throw new Error('已在竞选中')
        rt.election?.candidates.push(actor.seat)
        pushLog(rt, `${actor.seat} 号参与竞选`)
      }
      if (parsed.actionType === 'sheriff.quit') {
        if (!rt.election?.candidates.includes(actor.seat)) throw new Error('未参与竞选')
        rt.election.candidates = rt.election.candidates.filter(s => s !== actor.seat)
        pushLog(rt, `${actor.seat} 号退选`)
      }
    }

    if (rt.phase === 'sheriff_vote') {
      if (parsed.actionType === 'sheriff.vote') {
        if (!actor.isAlive) throw new Error('已出局')
        if (rt.election?.candidates.includes(actor.seat)) throw new Error('参选人不可投票')
        const targetSeat = parsed.payload?.targetSeat == null ? null : Number(parsed.payload?.targetSeat)
        if (targetSeat != null && !rt.election?.candidates.includes(targetSeat)) {
          throw new Error('只能投给参选人')
        }
        rt.election!.votes[userId] = targetSeat
        pushEvent(rt, 'action_submitted', { actionType: 'sheriff.vote', seat: actor.seat })

        // Check if all non-candidates have voted
        const voters = rt.players.filter(p => p.isAlive && !rt.election?.candidates.includes(p.seat))
        if (voters.every(v => rt.election?.votes[v.userId] !== undefined)) {
          resolveSheriffVote(rt)
        }
      }
    }

    if (rt.phase === 'day_vote') {
      if (!actor.isAlive) throw new Error('已出局')
      if (parsed.actionType !== 'day.vote') throw new Error('当前阶段不可用')
      const targetSeat = parsed.payload?.targetSeat == null ? null : Number(parsed.payload?.targetSeat)
      if (targetSeat != null) {
        const target = rt.players.find((p) => p.seat === targetSeat)
        if (!target || !target.isAlive) throw new Error('目标无效')
        if (rt.day.stage === 2 && rt.day.candidates?.length && !rt.day.candidates.includes(targetSeat)) {
          throw new Error('不在候选范围')
        }
      }

      if (rt.day.votes[userId] !== undefined) throw new Error('已投票，不可更改')
      rt.day.votes[userId] = targetSeat
      pushEvent(rt, 'action_submitted', { actionType: 'day.vote', seat: actor.seat })

      const alive = rt.players.filter((p) => p.isAlive)
      const allVoted = alive.every((p) => rt.day.votes[p.userId] !== undefined)
      if (allVoted) {
        const result = resolveVote(rt)

        if (result.tiedSeats.length && rt.day.stage === 1) {
          rt.day.stage = 2
          rt.day.candidates = result.tiedSeats
          pushLog(rt, `平票：${result.tiedSeats.join('、')} 号，进入复投`)
          pushEvent(rt, 'vote_result', { stage: 1, tiedSeats: result.tiedSeats })
          startPhase(rt, 'day_vote')
        } else {
          const eliminatedSeat = result.eliminatedSeat
          pushEvent(rt, 'vote_result', { stage: rt.day.stage, eliminatedSeat, tiedSeats: result.tiedSeats })

          if (!eliminatedSeat) {
            pushLog(rt, '投票无结果，直接进入夜晚')
            startPhase(rt, 'night')
          } else {
            const eliminated = rt.players.find((p) => p.seat === eliminatedSeat)
            if (eliminated && eliminated.isAlive) eliminated.isAlive = false
            pushLog(rt, `${eliminatedSeat} 号被放逐`)
            pushEvent(rt, 'player_eliminated', { seat: eliminatedSeat, reason: 'vote' })

            if (eliminated?.role === 'hunter') {
              rt.settlement.pendingHunterSeat = eliminated.seat
              startPhase(rt, 'settlement')
            } else {
              startPhase(rt, 'night')
            }
          }

          rt.day.stage = 1
          rt.day.candidates = undefined
          rt.day.votes = {}
        }
      }
    }

    if (rt.phase === 'settlement') {
      if (parsed.actionType !== 'settlement.hunterShoot') throw new Error('当前阶段不可用')
      const pendingSeat = rt.settlement.pendingHunterSeat
      if (!pendingSeat) throw new Error('无待结算')
      const hunter = rt.players.find((p) => p.seat === pendingSeat)
      if (!hunter || hunter.userId !== userId || hunter.role !== 'hunter') throw new Error('无权操作')

      const targetSeat = parsed.payload?.targetSeat == null ? null : Number(parsed.payload?.targetSeat)
      if (targetSeat != null) {
        const target = rt.players.find((p) => p.seat === targetSeat)
        if (!target || !target.isAlive) throw new Error('目标无效')
        target.isAlive = false
        pushLog(rt, `猎人开枪带走了 ${targetSeat} 号`)
        pushEvent(rt, 'player_eliminated', { seat: targetSeat, reason: 'hunter' })
      } else {
        pushLog(rt, '猎人未开枪')
      }

      rt.settlement.pendingHunterSeat = undefined
      startPhase(rt, rt.dayNo > 0 ? 'night' : 'day_speech')
    }

    let roomState = null as any
    const ended = await finalizeIfWinner(rt)
    if (ended.ended) {
      roomState = await roomService.getRoomState(roomId)
      privateUserIds.clear()
      for (const p of rt.players) privateUserIds.add(p.userId)
    }

    await saveGame(rt)

    const gamePublic = toPublic(rt)
    return {
      roomState: roomState ?? undefined,
      gamePublic,
      privateUserIds: [...privateUserIds],
    }
  },

  async advanceGameOnTimeout(gameId: string) {
    const rt = await loadGame(gameId)
    if (!rt) return null
    if (rt.phase === 'game_over') return null
    if (nowMs() < rt.phaseEndsAt) return null

    const privateUserIds = new Set<string>()

    if (rt.phase === 'night' && rt.activeRole) {
      // Let bots act before advancing (they didn't act during their window)
      triggerBotAction(rt)
      advanceNightRole(rt)
    } else if (rt.phase === 'sheriff_election') {
      startPhase(rt, 'sheriff_speech')
    } else if (rt.phase === 'sheriff_speech') {
      advanceSpeaker(rt)
    } else if (rt.phase === 'sheriff_vote') {
      resolveSheriffVote(rt)
    } else if (rt.phase === 'day_speech') {
      advanceSpeaker(rt)
    } else if (rt.phase === 'day_vote') {
      const result = resolveVote(rt)

      if (result.tiedSeats.length && rt.day.stage === 1) {
        rt.day.stage = 2
        rt.day.candidates = result.tiedSeats
        pushLog(rt, `平票：${result.tiedSeats.join('、')} 号，进入复投`)
        pushEvent(rt, 'vote_result', { stage: 1, tiedSeats: result.tiedSeats })
        startPhase(rt, 'day_vote')
      } else {
        const eliminatedSeat = result.eliminatedSeat
        pushEvent(rt, 'vote_result', { stage: rt.day.stage, eliminatedSeat, tiedSeats: result.tiedSeats })

        if (!eliminatedSeat) {
          pushLog(rt, '投票无结果，进入夜晚')
          startPhase(rt, 'night')
        } else {
          const eliminated = rt.players.find((p) => p.seat === eliminatedSeat)
          if (eliminated && eliminated.isAlive) eliminated.isAlive = false
          pushLog(rt, `${eliminatedSeat} 号被放逐`)
          pushEvent(rt, 'player_eliminated', { seat: eliminatedSeat, reason: 'vote' })
          if (eliminated?.role === 'hunter') {
            rt.settlement.pendingHunterSeat = eliminated.seat
            startPhase(rt, 'settlement')
          } else {
            startPhase(rt, 'night')
          }
        }

        rt.day.stage = 1
        rt.day.candidates = undefined
        rt.day.votes = {}
      }
    } else if (rt.phase === 'settlement') {
      const pendingSeat = rt.settlement.pendingHunterSeat
      if (pendingSeat) {
        pushLog(rt, '猎人超时未开枪')
      }
      rt.settlement.pendingHunterSeat = undefined
      startPhase(rt, 'night')
    }

    const ended = await finalizeIfWinner(rt)
    if (ended.ended) {
      for (const p of rt.players) privateUserIds.add(p.userId)
    }

    await saveGame(rt)
    return {
      roomId: rt.roomId,
      gamePublic: toPublic(rt),
      roomState: ended.ended ? await roomService.getRoomState(rt.roomId) : undefined,
      privateUserIds: ended.ended ? [...privateUserIds] : [],
    }
  },

  async listActiveGameIds() {
    const redis = await getRedis()
    return await redis.sMembers('games:active')
  },
}
