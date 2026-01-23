import type { Role, Side } from '../../shared/types.js'

export function computeWinner(players: { role: Role; isAlive: boolean }[]): Side | null {
  const alive = players.filter((p) => p.isAlive)
  const wolves = alive.filter((p) => p.role === 'werewolf').length
  const others = alive.length - wolves
  if (wolves <= 0) return 'villagers'
  if (wolves >= others) return 'werewolves'
  return null
}

