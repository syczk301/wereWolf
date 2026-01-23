import { describe, expect, it } from 'vitest'
import { computeWinner } from './rules.js'

describe('computeWinner', () => {
  it('returns villagers when no wolves alive', () => {
    expect(computeWinner([{ role: 'villager', isAlive: true } as any])).toBe('villagers')
  })

  it('returns werewolves when wolves >= others', () => {
    const players = [
      { role: 'werewolf', isAlive: true },
      { role: 'villager', isAlive: true },
    ] as any
    expect(computeWinner(players)).toBe('werewolves')
  })

  it('returns null when game should continue', () => {
    const players = [
      { role: 'werewolf', isAlive: true },
      { role: 'villager', isAlive: true },
      { role: 'villager', isAlive: true },
    ] as any
    expect(computeWinner(players)).toBeNull()
  })
})

