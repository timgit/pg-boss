import { describe, expectTypeOf, it } from 'vitest'
import type {
  GroupAvailabilityCandidate,
  GroupAvailabilityDecision,
  GroupAvailabilityHook,
  QueueAvailabilityContext,
  QueueAvailabilityHook,
  WorkOptions
} from '../src/index.ts'

describe('groupAvailability types', () => {
  it('exports the hook contract through WorkOptions', () => {
    expectTypeOf<NonNullable<WorkOptions['groupAvailability']>>()
      .toEqualTypeOf<GroupAvailabilityHook>()

    expectTypeOf<GroupAvailabilityCandidate>().toMatchTypeOf<{
      groupId: string
      groupTier: string | null
      requested: number
    }>()

    expectTypeOf<GroupAvailabilityDecision>().toMatchTypeOf<{
      groupId: string
      groupTier: string | null
      capacity: number
    }>()

    expectTypeOf<NonNullable<WorkOptions['queueAvailability']>>()
      .toEqualTypeOf<QueueAvailabilityHook>()

    expectTypeOf<QueueAvailabilityContext>().toMatchTypeOf<{
      name: string
      requested: number
    }>()
  })
})
