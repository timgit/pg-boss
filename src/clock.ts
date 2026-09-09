import type { Clock, ClockTimer } from './types.ts'

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle: ClockTimer) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle: ClockTimer) => clearInterval(handle as NodeJS.Timeout)
}
