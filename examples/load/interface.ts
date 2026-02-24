import { PgBoss } from '../../src'

interface JobsSchema {
  'queue-a': { input: { a: string; b: number } };
  // foo: { bar: string }; // <-- This line will fail because its not a valid job definition.
}

interface JobsSchema {
  'queue-b': { input: { a: string; b: number } };
}

export const boss = new PgBoss<{
  [S in keyof JobsSchema]: JobsSchema[S];
}>({})

// Code completion work as expected
boss.send('queue-a', { a: 'a', b: 42 })
// boss.send('queue-c', { foo: 'bar' }) // <-- This line will fail because the job-type is not defined.
