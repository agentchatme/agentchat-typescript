/**
 * Turns that are running, per conversation (reply turns) and per invite
 * (invite turns). While a reply turn runs, its conversation's card stays on
 * the tray (the verdict is recorded when the turn has ended), so every wake
 * in between would gate it again and start a second turn: the tracker is
 * what keeps such cards out of the gate.
 *
 * A turn ends only when the runtime confirms it ended. A wait that timed out
 * is not an end: the runtime reports `still_running` and the turn keeps its
 * conversation, following `next` when the runtime can say when it really
 * ends. Only `release()` lets go of a turn whose end never comes.
 *
 * Where the copies this replaces differed: OpenClaw ended a turn when its
 * wait timed out (so a second turn could start for a conversation whose
 * first was still running); Hermes ran one turn per cycle and held the
 * worker; agent-core ran one run at a time. Here the turn is held until its
 * confirmed end, and cycles go on meanwhile.
 */

import type { InboxCard } from '../types/index.js'
import type { TurnEnd } from './outcome.js'

export type TrackedTurn =
  | { readonly kind: 'reply'; readonly conversationId: string; readonly anchor: string | null }
  | { readonly kind: 'invite'; readonly inviteId: string }

export type RunningTurn = TrackedTurn & {
  /** Epoch ms the host started the turn. */
  readonly startedAt: number
  /** Epoch ms the last wait timed out without an end, or null. */
  readonly waitTimedOutAt: number | null
}

export interface TurnHandle {
  readonly key: string
  readonly turn: TrackedTurn
  readonly startedAt: number
}

/** A confirmed end: `completed` or `failed`. */
export type ConfirmedTurnEnd = Extract<TurnEnd, { status: 'completed' | 'failed' }>

function keyOf(turn: TrackedTurn): string {
  return turn.kind === 'reply' ? `conversation:${turn.conversationId}` : `invite:${turn.inviteId}`
}

export class TurnTracker {
  private readonly now: () => number
  private readonly turns = new Map<string, { handle: TurnHandle; waitTimedOutAt: number | null; released: boolean }>()
  /** Turns held with no way to learn their end: resolved by `release`. */
  private readonly waiters = new Map<string, () => void>()

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now
  }

  /** Start tracking a turn. Null when one is already running for that conversation or invite. */
  begin(turn: TrackedTurn): TurnHandle | null {
    const key = keyOf(turn)
    if (this.turns.has(key)) return null
    const handle: TurnHandle = { key, turn, startedAt: this.now() }
    this.turns.set(key, { handle, waitTimedOutAt: null, released: false })
    return handle
  }

  conversationRunning(conversationId: string): boolean {
    return this.turns.has(`conversation:${conversationId}`)
  }

  inviteRunning(inviteId: string): boolean {
    return this.turns.has(`invite:${inviteId}`)
  }

  /** The cards whose conversation has no running turn: the ones a gate may see. */
  withoutRunning<T extends Pick<InboxCard, 'conversation_id'>>(cards: readonly T[]): T[] {
    return cards.filter((card) => !this.conversationRunning(card.conversation_id))
  }

  /** Snapshot for status. */
  running(): RunningTurn[] {
    return [...this.turns.values()].map(({ handle, waitTimedOutAt }) => ({
      ...handle.turn,
      startedAt: handle.startedAt,
      waitTimedOutAt,
    }))
  }

  get size(): number {
    return this.turns.size
  }

  /**
   * Follow what the runtime reports until it confirms the end, through any
   * number of `still_running` reports. Resolves with the confirmed end, or
   * never when the runtime cannot say (until `release`). A rejected report
   * counts as a failed turn. The turn stays tracked: call `end` once its
   * outcome is recorded.
   */
  async confirmedEnd(handle: TurnHandle, done: Promise<TurnEnd>): Promise<ConfirmedTurnEnd | null> {
    let report: Promise<TurnEnd> | undefined = done
    while (report !== undefined) {
      let end: TurnEnd
      try {
        end = await report
      } catch (err) {
        return { status: 'failed', agentchatCalls: null, detail: `the turn's report failed: ${err instanceof Error ? err.message : String(err)}` }
      }
      if (end.status !== 'still_running') return end
      const entry = this.turns.get(handle.key)
      if (!entry || entry.handle !== handle || entry.released) return null
      entry.waitTimedOutAt = this.now()
      report = end.next
    }
    // Still running and the runtime cannot say when it ends: hold the turn
    // until `release` lets go of it.
    return new Promise<null>((resolve) => {
      const entry = this.turns.get(handle.key)
      if (!entry || entry.handle !== handle) {
        resolve(null)
        return
      }
      this.waiters.set(handle.key, () => resolve(null))
    })
  }

  /** Stop tracking a turn (its outcome is recorded, or it never started). */
  end(handle: TurnHandle): void {
    const entry = this.turns.get(handle.key)
    if (entry?.handle === handle) this.turns.delete(handle.key)
  }

  /**
   * Let go of a turn whose end will not be confirmed (an operator's call). Its
   * conversation may be gated again; nothing is recorded for it.
   */
  release(key: string): boolean {
    const entry = this.turns.get(key)
    if (!entry) return false
    entry.released = true
    this.turns.delete(key)
    this.waiters.get(key)?.()
    this.waiters.delete(key)
    return true
  }
}
