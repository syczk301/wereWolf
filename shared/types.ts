export type UserId = string
export type RoomId = string
export type GameId = string
export type ReplayId = string

export type RoomStatus = 'waiting' | 'playing' | 'ended'
export type Phase =
  | 'night'
  | 'day_speech'
  | 'day_vote'
  | 'settlement'
  | 'game_over'
  | 'sheriff_election'
  | 'sheriff_speech'
  | 'sheriff_vote'

export type Role = 'werewolf' | 'seer' | 'witch' | 'hunter' | 'guard' | 'villager'
export type Side = 'werewolves' | 'villagers'

export type PublicUser = {
  id: UserId
  nickname: string
}

export type RoomSummary = {
  id: RoomId
  name: string
  status: RoomStatus
  playerCount: number
  maxPlayers: number
  roomNumber?: number
}

export type SeatPublicState = {
  seat: number
  user?: PublicUser
  isReady: boolean
  isAlive: boolean
}

export type RoomState = {
  id: RoomId
  roomNumber?: number
  name: string
  status: RoomStatus
  ownerUserId: UserId
  maxPlayers: number
  members: SeatPublicState[]
  gameId?: GameId
  roleConfig?: { werewolf: number; seer: number; witch: number; hunter: number; guard: number }
  timers?: { nightSeconds: number; daySpeechSeconds: number; dayVoteSeconds: number; settlementSeconds: number }
  createdAt?: number
}

export type GamePublicState = {
  gameId: GameId
  roomId: RoomId
  phase: Phase
  dayNo: number
  phaseEndsAt: number
  players: SeatPublicState[]
  publicLog: { id: string; at: number; text: string }[]
  activeRole?: string | null
  activeSpeakerSeat?: number | null
  speakingQueue?: number[]
  sheriffSeat?: number | null
}

export type GamePrivateState = {
  role: Role
  seat: number
  hints: { id: string; at: number; text: string }[]
  actions?: {
    hunterShoot?: boolean
  }
  selectedTargetSeat?: number | null
  witchSaveDecision?: boolean
  // 新增女巫信息
  witchInfo?: {
    nightVictimSeat?: number | null // 昨夜死者
    saveUsed: boolean    // 解药已用
    poisonUsed: boolean  // 毒药已用
  }
}

export type ReplayEventType =
  | 'phase_changed'
  | 'chat_message'
  | 'action_submitted'
  | 'vote_result'
  | 'night_result'
  | 'player_eliminated'
  | 'game_result'
  | 'speaker_changed'
  | 'sheriff_elected'

export type ReplayEvent = {
  t: number
  type: ReplayEventType
  payload: Record<string, unknown>
}

export type ReplayRecord = {
  id: ReplayId
  createdAt: string
  roomName: string
  resultSummary: string
  durationMs: number
}

export type ReplayDetail = {
  record: ReplayRecord
  events: ReplayEvent[]
}
