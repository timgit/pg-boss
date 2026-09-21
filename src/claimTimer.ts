import type { Clock, ClockTimer } from './types.ts'

/**
 * The timer behind an interval claim, anchored to the claim instead of to a fixed grid.
 *
 * An interval claim is a conditional UPDATE that only goes through when the row it stamps is at
 * least `seconds` old by the server's clock, so exactly one instance in a deployment runs the pass
 * per interval (see plans.trySetTimestamp). Every instance tries on a timer of its own.
 *
 * setInterval schedules the next tick from a grid fixed before the callback runs, while the row is
 * stamped when the UPDATE reaches the server - a moment later by however long the pool wait, the
 * round trip and the plan took. The two do not move together. When a tick's statement lands faster
 * than the previous tick's did, the two stamps come out closer together than the period, the claim
 * is refused, and the pass after it is a whole interval late. Measured on an idle Linux box that is
 * 4 of 19 ticks at a 45-second period, all of them between 44.990 and 44.998 seconds old, and a
 * quarter of the queue monitor's passes at its defaults. For the cron pass a lost claim is a
 * 90-second gap against a 60-second due window, and the occurrences inside it are never sent.
 *
 * Anchoring removes the mismatch rather than tolerating it: the next attempt is scheduled once the
 * claim has been stamped, so the gap between two stamps is the period plus one round trip rather
 * than the period minus the difference between two of them. It can only ever come out long, never
 * short, which is the direction that costs nothing - a pass never runs before its interval is up.
 *
 * Note what does not appear here: a clock. The claim compares two timestamps that the server wrote,
 * so the client's clock is already absent from it and skew between the two cancels exactly. There
 * is nothing for a skew correction to correct, which is why the fix is in when the attempt is made
 * rather than in what it is measured against.
 *
 * `anchor()` is what a pass calls once its claim has been stamped, and it takes a wait of its own
 * for the pass that knows when the row it was refused by comes due. A pass that returns without ever
 * reaching its claim - stopped, already working, an error on the way in - is re-armed from the end
 * of the callback instead, so the chain cannot die on a path that never anchored it.
 */
export class ClaimTimer {
  readonly #clock: Clock
  readonly #ms: number
  readonly #fn: () => Promise<void>

  #handle: ClockTimer | undefined
  #stopped = true
  #anchored = false

  constructor (clock: Clock, seconds: number, fn: () => Promise<void>) {
    this.#clock = clock
    this.#ms = seconds * 1000
    this.#fn = fn
  }

  start (): void {
    if (!this.#stopped) return

    this.#stopped = false
    this.#arm()
  }

  stop (): void {
    this.#stopped = true
    this.#disarm()
  }

  /**
   * Re-anchors the next attempt to now, because the claim this timer drives has just been stamped.
   *
   * Called whether the claim was won or lost. A winner needs its next attempt to fall an interval
   * after its own stamp. A loser has two phases it could take, and which one it takes is not a
   * matter of taste: measured from its own failure it comes back an interval later, which is up to
   * a whole interval after the row is next due, and that is the deployment's spacing the moment the
   * instance holding the claim stops. A caller that knows when the row comes due passes that wait
   * in `ms` instead. See Timekeeper.onCron(), which is the one claim where the difference costs
   * work rather than latency.
   */
  anchor (ms: number = this.#ms): void {
    if (this.#stopped) return

    this.#anchored = true
    this.#arm(ms)
  }

  #arm (ms: number = this.#ms): void {
    this.#disarm()

    if (this.#stopped) return

    this.#handle = this.#clock.setTimeout(() => { this.#run() }, ms)
  }

  #disarm (): void {
    if (this.#handle !== undefined) {
      this.#clock.clearTimeout(this.#handle)
      this.#handle = undefined
    }
  }

  async #run (): Promise<void> {
    this.#handle = undefined
    this.#anchored = false

    // Deliberately not caught. Every pass this drives ends its own catch in an error event, so the
    // only rejection that reaches here is one that could not be reported - an error event with
    // nothing listening, which EventEmitter throws on. That belongs to the process, the way it did
    // when these ran on setInterval; a timer that turned it into anything else would be inventing a
    // failure mode for the host to handle. What the timer does owe is the chain, and finally pays
    // that whether the pass resolved or not.
    try {
      await this.#fn()
    } finally {
      // A pass that reached its claim already armed the next attempt through anchor(); this is the
      // path for one that did not, including one that threw.
      if (!this.#anchored) this.#arm()
    }
  }
}
