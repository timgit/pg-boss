import { describe, it } from 'vitest'
import { ctx, expect } from './hooks.ts'
import * as helper from './testHelper.ts'
import * as plans from '../src/plans.ts'
import * as drifter from '../src/drifter.ts'
import Contractor from '../src/contractor.ts'
import packageJson from '../package.json' with { type: 'json' }

const schemaVersion = packageJson.pgboss.schema as number

describe('drift', function () {
  describe('expectedManagedIndexes (pure)', function () {
    it('non-partitioned puts the full job_iN set on the job table', function () {
      const expected = plans.expectedManagedIndexes('pgboss', false, [])
      const names = expected.map(i => i.name)

      for (let n = 1; n <= 9; n++) {
        expect(names).toContain(`job_i${n}`)
      }
      expect(names).toContain('warning_i1')
      expect(names).toContain('queue_stats_i1')
      expect(names).toContain('job_dep_parent_idx')
      // no per-partition names
      expect(names.some(n => n.startsWith('job_common_'))).toBe(false)
    })

    it('partitioned puts the full set on job_common', function () {
      const names = plans.expectedManagedIndexes('pgboss', true, []).map(i => i.name)

      for (let n = 1; n <= 9; n++) {
        expect(names).toContain(`job_common_i${n}`)
      }
      expect(names).not.toContain('job_i1')
    })

    it('a per-queue partition only carries the base set plus its policy index', function () {
      const names = plans.expectedManagedIndexes('pgboss', true, [{ table: 'jabc', policy: 'short' }]).map(i => i.name)

      // base: throttle/fetch/group/blocking
      expect(names).toContain('jabc_i4')
      expect(names).toContain('jabc_i5')
      expect(names).toContain('jabc_i7')
      expect(names).toContain('jabc_i9')
      // short -> i1
      expect(names).toContain('jabc_i1')
      // other policy indexes absent
      expect(names).not.toContain('jabc_i2')
      expect(names).not.toContain('jabc_i3')
      expect(names).not.toContain('jabc_i6')
      expect(names).not.toContain('jabc_i8')
    })

    it('attaches the expected key-column list to each index', function () {
      const byName = new Map(plans.expectedManagedIndexes('pgboss', true, []).map(i => [i.name, i]))
      expect(byName.get('job_common_i5')!.keys).toBe('name, start_after')
      expect(byName.get('job_common_i9')!.keys).toBe('name, id')
      expect(byName.get('job_common_i1')!.keys).toBe("name, COALESCE(singleton_key, '')")
      // predicate is the catalog-canonical pg_get_indexdef form (per-conjunct parens)
      expect(byName.get('job_common_i9')!.predicate).toBe("blocking AND (state = 'completed')")
    })

    it('attaches the full schema-qualified, physically-named CREATE INDEX definition', function () {
      const byName = new Map(
        plans.expectedManagedIndexes('myschema', true, [{ table: 'jabc', policy: 'short' }]).map(i => [i.name, i])
      )
      // shared partition: name and table rewritten from job_iN/job to job_common
      expect(byName.get('job_common_i9')!.definition)
        .toBe("CREATE INDEX job_common_i9 ON myschema.job_common (name, id) WHERE blocking AND (state = 'completed')")
      // UNIQUE and the predicate are preserved
      expect(byName.get('job_common_i1')!.definition)
        .toBe("CREATE UNIQUE INDEX job_common_i1 ON myschema.job_common (name, COALESCE(singleton_key, '')) WHERE (state = 'created') AND (policy = 'short')")
      // per-queue partition keeps its own physical name and table
      expect(byName.get('jabc_i5')!.definition)
        .toBe("CREATE INDEX jabc_i5 ON myschema.jabc (name, start_after) WHERE (state < 'active') AND (NOT blocked)")
      // static index needs no partition rewrite
      expect(byName.get('warning_i1')!.definition)
        .toBe('CREATE INDEX warning_i1 ON myschema.warning (created_on DESC)')
    })

    it('maps each policy to its own index', function () {
      const cases: Array<[string, string]> = [
        ['short', 'jx_i1'],
        ['singleton', 'jx_i2'],
        ['stately', 'jx_i3'],
        ['exclusive', 'jx_i6'],
        ['key_strict_fifo', 'jx_i8']
      ]
      for (const [policy, idx] of cases) {
        const names = plans.expectedManagedIndexes('pgboss', true, [{ table: 'jx', policy }]).map(i => i.name)
        expect(names).toContain(idx)
      }
    })
  })

  describe('computeSchemaDrift (pure)', function () {
    const expected = [
      { name: 'job_common_i5', table: 'job_common' },
      { name: 'warning_i1', table: 'warning' }
    ]

    it('reports ok when the live catalog matches', function () {
      const live = [
        { name: 'job_common_i5', table: 'job_common', valid: true },
        { name: 'warning_i1', table: 'warning', valid: true }
      ]
      const report = drifter.computeSchemaDrift({ indexes: { expected, live } })
      expect(report.ok).toBe(true)
      expect(report.missing).toHaveLength(0)
    })

    it('flags a missing index', function () {
      const live = [{ name: 'warning_i1', table: 'warning', valid: true }]
      const report = drifter.computeSchemaDrift({ indexes: { expected, live } })
      expect(report.ok).toBe(false)
      expect(report.missing.map(i => i.name)).toEqual(['job_common_i5'])
    })

    it('treats a missing index with an incomplete BAM build as building, not missing', function () {
      const live = [{ name: 'warning_i1', table: 'warning', valid: true }]
      const report = drifter.computeSchemaDrift({ indexes: { expected, live, building: new Set(['job_common_i5']) } })
      expect(report.missing).toHaveLength(0)
      expect(report.building.map(i => i.name)).toEqual(['job_common_i5'])
      // building alone is not drift
      expect(report.ok).toBe(true)
    })

    it('flags an invalid index', function () {
      const live = [
        { name: 'job_common_i5', table: 'job_common', valid: false, def: 'CREATE INDEX job_common_i5 ON pgboss.job_common USING btree (name, start_after)' },
        { name: 'warning_i1', table: 'warning', valid: true }
      ]
      const report = drifter.computeSchemaDrift({ indexes: { expected, live } })
      expect(report.ok).toBe(false)
      expect(report.invalid.map(i => i.name)).toEqual(['job_common_i5'])
    })

    it('reports non-constraint indexes on a managed table that are not expected as extra (a warning)', function () {
      const live = [
        { name: 'job_common_i5', table: 'job_common', valid: true },
        { name: 'warning_i1', table: 'warning', valid: true },
        { name: 'job_common_i99', table: 'job_common', valid: true }, // stale pg-boss-named
        { name: 'my_custom_lookup', table: 'job_common', valid: true }, // user's own
        { name: 'job_common_pkey', table: 'job_common', valid: true, constraintBacked: true }, // pk index, ignored
        { name: 'their_idx', table: 'their_table', valid: true } // not a managed table, ignored
      ]
      const report = drifter.computeSchemaDrift({ indexes: { expected, live } })
      expect(report.extraIndexes.map(i => i.name).sort()).toEqual(['job_common_i99', 'my_custom_lookup'])
      expect(report.ok).toBe(true) // extra indexes are informational, not drift
    })
  })

  describe('indexKeys (pure)', function () {
    it('extracts and normalizes the key-column list', function () {
      expect(drifter.indexKeys("CREATE UNIQUE INDEX job_i1 ON x.job (name, COALESCE(singleton_key, '')) WHERE state='created'"))
        .toBe("name,coalesce(singleton_key,'')")
    })

    it('normalizes a pg_get_indexdef form (casts, USING btree) to the same value', function () {
      expect(drifter.indexKeys("CREATE UNIQUE INDEX job_i1 ON pgboss.job USING btree (name, COALESCE(singleton_key, ''::text)) WHERE (state = 'created')"))
        .toBe("name,coalesce(singleton_key,'')")
    })

    it('preserves column order (order is significant)', function () {
      const ab = drifter.indexKeys('CREATE INDEX x ON s.t (a, b)')
      const ba = drifter.indexKeys('CREATE INDEX x ON s.t (b, a)')
      expect(ab).not.toBe(ba)
    })

    it('returns empty when there is no key list or the parens are unbalanced', function () {
      expect(drifter.indexKeys('CREATE INDEX x ON s.t')).toBe('')
      expect(drifter.indexKeys('CREATE INDEX x ON s.t (a, b')).toBe('')
    })
  })

  describe('indexPredicate (pure)', function () {
    it('returns empty for a non-partial index', function () {
      expect(drifter.indexPredicate('CREATE INDEX x ON s.t (a)')).toBe('')
    })

    it('normalizes two catalog-canonical predicates equal despite casts, whitespace and outer parens', function () {
      // Both expected (manifest) and live come from pg_get_indexdef, so both carry the same per-conjunct
      // parens; normalization only strips casts, the redundant OUTER wrapper, and whitespace.
      const a = drifter.indexPredicate("CREATE UNIQUE INDEX job_i1 ON s.job USING btree (name) WHERE ((state = 'created'::s.job_state) AND (policy = 'short'::text))")
      const b = drifter.indexPredicate("CREATE UNIQUE INDEX job_i1 ON x.job (name) WHERE (  (state = 'created')   AND   (policy = 'short')  )")
      expect(b).toBe(a)
    })

    it('preserves inner grouping so a regrouped AND/OR predicate is detected as different', function () {
      // The reason normalization strips only the OUTER parens: two predicates that differ only in how
      // their AND/OR terms are grouped must NOT normalize equal, or real drift would slip through.
      const g1 = drifter.indexPredicate('CREATE INDEX x ON s.t (a) WHERE ((a OR b) AND c)')
      const g2 = drifter.indexPredicate('CREATE INDEX x ON s.t (a) WHERE (a OR (b AND c))')
      expect(g1).not.toBe(g2)
    })

    it('folds IN (...) and = ANY (ARRAY[...]) to the same value', function () {
      const inForm = drifter.indexPredicate("CREATE INDEX x ON s.t (a) WHERE state IN ('active', 'retry', 'failed')")
      const anyForm = drifter.indexPredicate("CREATE INDEX x ON s.t (a) WHERE (state = ANY (ARRAY['active'::s.job_state, 'retry'::s.job_state, 'failed'::s.job_state]))")
      expect(anyForm).toBe(inForm)
    })

    it('treats different predicates as different', function () {
      const a = drifter.indexPredicate("CREATE INDEX x ON s.t (a) WHERE state = 'active'")
      const b = drifter.indexPredicate("CREATE INDEX x ON s.t (a) WHERE state = 'completed'")
      expect(a).not.toBe(b)
    })
  })

  describe('indexKeysRaw / indexPredicateRaw (pure, readable output)', function () {
    it('returns the readable key list without normalizing', function () {
      expect(drifter.indexKeysRaw("CREATE UNIQUE INDEX job_i1 ON x.job (name, COALESCE(singleton_key, '')) WHERE state='created'"))
        .toBe("name, COALESCE(singleton_key, '')")
    })

    it('returns the readable predicate without normalizing', function () {
      expect(drifter.indexPredicateRaw("CREATE INDEX x ON s.t (a) WHERE state < 'active' AND NOT blocked"))
        .toBe("state < 'active' AND NOT blocked")
    })

    it('collapses whitespace runs and returns empty when absent', function () {
      expect(drifter.indexKeysRaw('CREATE INDEX x ON s.t\n  (a,\n   b)')).toBe('a, b')
      expect(drifter.indexKeysRaw('CREATE INDEX x ON s.t')).toBe('')
      expect(drifter.indexPredicateRaw('CREATE INDEX x ON s.t (a)')).toBe('')
    })

    it('displayIndexDefinition drops the default USING btree clause and outer predicate parens', function () {
      expect(drifter.displayIndexDefinition("CREATE INDEX job_common_i9 ON pgboss.job_common USING btree (name, id) WHERE (blocking AND (state = 'active'::pgboss.job_state))"))
        .toBe("CREATE INDEX job_common_i9 ON pgboss.job_common (name, id) WHERE blocking AND (state = 'active')")
    })

    it('displayIndexDefinition handles a non-partial index (no WHERE)', function () {
      expect(drifter.displayIndexDefinition('CREATE INDEX warning_i1 ON pgboss.warning USING btree (created_on DESC)'))
        .toBe('CREATE INDEX warning_i1 ON pgboss.warning (created_on DESC)')
    })

    it('indexPredicateRaw strips the redundant outer parentheses but keeps inner grouping', function () {
      expect(drifter.indexPredicateRaw("CREATE INDEX x ON s.t (a) WHERE (blocking AND (state = 'active'::s.job_state))"))
        .toBe("blocking AND (state = 'active')")
      // inner-only grouping (not a single outer wrap) is left intact
      expect(drifter.indexPredicateRaw('CREATE INDEX x ON s.t (a) WHERE (a) AND (b)'))
        .toBe('(a) AND (b)')
      // an unbalanced leading paren is not treated as an outer wrap
      expect(drifter.indexPredicateRaw('CREATE INDEX x ON s.t (a) WHERE (a AND b')).toBe('(a AND b')
    })
  })

  describe('computeSchemaDrift definition-diff (pure)', function () {
    // Canonical (per-conjunct parens), matching what expectedManagedIndexes derives from pg_get_indexdef.
    const expected = [{ name: 'job_common_i9', table: 'job_common', keys: 'name, id', predicate: "blocking AND (state = 'completed')" }]

    it('reports ok when keys and predicate match', function () {
      const live = [{ name: 'job_common_i9', table: 'job_common', valid: true, def: "CREATE INDEX job_common_i9 ON pgboss.job_common USING btree (name, id) WHERE (blocking AND (state = 'completed'::pgboss.job_state))" }]
      const report = drifter.computeSchemaDrift({ indexes: { expected, live } })
      expect(report.ok).toBe(true)
      expect(report.mismatched).toHaveLength(0)
    })

    it('flags an index whose key columns are reordered', function () {
      const live = [{ name: 'job_common_i9', table: 'job_common', valid: true, def: "CREATE INDEX job_common_i9 ON pgboss.job_common USING btree (id, name) WHERE (blocking AND (state = 'completed'::pgboss.job_state))" }]
      const report = drifter.computeSchemaDrift({ indexes: { expected, live } })
      expect(report.ok).toBe(false)
      expect(report.mismatched).toHaveLength(1)
      expect(report.mismatched[0]).toMatchObject({ name: 'job_common_i9', actualKeys: 'id, name', differs: ['keys'] })
    })

    it('flags an index whose predicate differs', function () {
      const live = [{ name: 'job_common_i9', table: 'job_common', valid: true, def: "CREATE INDEX job_common_i9 ON pgboss.job_common USING btree (name, id) WHERE (blocking AND (state = 'active'::pgboss.job_state))" }]
      const report = drifter.computeSchemaDrift({ indexes: { expected, live } })
      expect(report.ok).toBe(false)
      expect(report.mismatched[0].differs).toEqual(['predicate'])
      expect(report.mismatched[0].actualPredicate).toBe("blocking AND (state = 'active')")
    })

    it('flags an index whose keys AND predicate both differ', function () {
      const live = [{ name: 'job_common_i9', table: 'job_common', valid: true, def: "CREATE INDEX job_common_i9 ON pgboss.job_common USING btree (id, name) WHERE (blocking AND (state = 'active'::pgboss.job_state))" }]
      const report = drifter.computeSchemaDrift({ indexes: { expected, live } })
      expect(report.mismatched[0].differs).toEqual(['keys', 'predicate'])
    })

    it('does not flag when the live def is unparseable', function () {
      const live = [{ name: 'job_common_i9', table: 'job_common', valid: true, def: 'garbage' }]
      const report = drifter.computeSchemaDrift({ indexes: { expected, live } })
      expect(report.mismatched).toHaveLength(0)
    })

    it('treats an expected index without a predicate as non-partial', function () {
      const noPredicate = [{ name: 'x_i1', table: 't', keys: 'a' }]
      const live = [{ name: 'x_i1', table: 't', valid: true, def: 'CREATE INDEX x_i1 ON s.t USING btree (a)' }]
      const report = drifter.computeSchemaDrift({ indexes: { expected: noPredicate, live } })
      expect(report.ok).toBe(true)
      expect(report.mismatched).toHaveLength(0)
    })

    it('skips the definition-diff for an expected index without a known key list', function () {
      const noKeys = [{ name: 'job_common_i9', table: 'job_common' }]
      const live = [{ name: 'job_common_i9', table: 'job_common', valid: true, def: 'CREATE INDEX job_common_i9 ON pgboss.job_common USING btree (id, name)' }]
      const report = drifter.computeSchemaDrift({ indexes: { expected: noKeys, live } })
      expect(report.ok).toBe(true)
      expect(report.mismatched).toHaveLength(0)
    })

    it('reports an invalid index that a BAM row is rebuilding as building', function () {
      const live = [{ name: 'job_common_i9', table: 'job_common', valid: false }]
      const report = drifter.computeSchemaDrift({ indexes: { expected, live, building: new Set(['job_common_i9']) } })
      expect(report.invalid).toHaveLength(1)
      expect(report.invalid[0].building).toBe(true)
    })

    it('scopes extra indexes to managed tables from tables.expected', function () {
      const live = [
        { name: 'stray_idx', table: 'queue', valid: true }, // on a managed table -> extra
        { name: 'user_idx', table: 'their_table', valid: true } // not a managed table -> ignored
      ]
      const report = drifter.computeSchemaDrift({ indexes: { expected: [], live }, tables: { expected: ['queue'], live: ['queue', 'their_table'] } })
      expect(report.extraIndexes.map(i => i.name)).toEqual(['stray_idx'])
      expect(report.ok).toBe(true)
    })
  })

  describe('bamCommandIndexName (pure)', function () {
    it('extracts the index name from CREATE INDEX variants', function () {
      expect(plans.bamCommandIndexName('CREATE INDEX CONCURRENTLY jabc_i5 ON s.t (a)')).toBe('jabc_i5')
      expect(plans.bamCommandIndexName('CREATE UNIQUE INDEX IF NOT EXISTS job_i1 ON s.t (a)')).toBe('job_i1')
      expect(plans.bamCommandIndexName('ANALYZE s.t')).toBe(null)
    })
  })

  describe('function-body helpers (pure)', function () {
    it('extractFunctionBody pulls the body from the outer dollar quotes', function () {
      expect(drifter.extractFunctionBody('CREATE FUNCTION s.f() RETURNS void AS $$ BEGIN END; $$ LANGUAGE plpgsql'))
        .toBe(' BEGIN END; ')
    })

    it('extractFunctionBody handles pg_get_functiondef $function$ tags', function () {
      expect(drifter.extractFunctionBody('CREATE OR REPLACE FUNCTION s.f()\n RETURNS void\n LANGUAGE plpgsql\nAS $function$ BEGIN END; $function$\n'))
        .toBe(' BEGIN END; ')
    })

    it('extractFunctionBody keeps nested $cmd$ quotes inside the body', function () {
      expect(drifter.extractFunctionBody('CREATE FUNCTION s.f() RETURNS void AS $$ EXECUTE $cmd$SELECT 1$cmd$; $$ LANGUAGE plpgsql'))
        .toBe(' EXECUTE $cmd$SELECT 1$cmd$; ')
    })

    it('extractFunctionBody returns empty when there is no dollar-quoted body', function () {
      expect(drifter.extractFunctionBody('CREATE FUNCTION s.f() RETURNS void LANGUAGE sql')).toBe('')
    })

    it('normalizeFunctionBody collapses whitespace and trims', function () {
      expect(drifter.normalizeFunctionBody('  BEGIN\n   RETURN;\n END;  ')).toBe('BEGIN RETURN; END;')
    })
  })

  describe('expectedManagedFunctions (pure)', function () {
    it('partitioned mode expects the job_table_* helpers plus queue functions', function () {
      const names = plans.expectedManagedFunctions('pgboss', true).map(f => f.name).sort()
      expect(names).toEqual(['create_queue', 'delete_queue', 'job_table_format', 'job_table_run', 'job_table_run_async'])
    })

    it('non-partitioned mode expects only the queue functions', function () {
      const names = plans.expectedManagedFunctions('pgboss', false).map(f => f.name).sort()
      expect(names).toEqual(['create_queue', 'delete_queue'])
    })
  })

  describe('column drift (pure)', function () {
    it('expectedManagedColumns lists job_common and partitions with the job column set only when partitioned', function () {
      const np = plans.expectedManagedColumns('pgboss', false).map(t => t.table)
      expect(np).toContain('job')
      expect(np).not.toContain('job_common')

      const part = plans.expectedManagedColumns('pgboss', true, [{ table: 'jabc', policy: 'standard' }])
      const jobCols = part.find(t => t.table === 'job')!.columns
      expect(part.find(t => t.table === 'job_common')!.columns).toEqual(jobCols)
      expect(part.find(t => t.table === 'jabc')!.columns).toEqual(jobCols)
      expect(jobCols).toContain('source_retry_count')
    })

    it('flags a missing column', function () {
      const report = drifter.computeSchemaDrift({
        columns: {
          expected: [{ table: 'queue', columns: ['name', 'policy', 'notify'] }],
          live: [{ table: 'queue', column: 'name' }, { table: 'queue', column: 'policy' }]
        }
      })
      expect(report.columnDrift).toEqual([{ table: 'queue', missingColumns: ['notify'], unexpectedColumns: [], defaultMismatches: [], typeMismatches: [], nullabilityMismatches: [] }])
      expect(report.ok).toBe(false)
    })

    it('flags an unexpected column', function () {
      const report = drifter.computeSchemaDrift({
        columns: {
          expected: [{ table: 'queue', columns: ['name'] }],
          live: [{ table: 'queue', column: 'name' }, { table: 'queue', column: 'legacy_flag' }]
        }
      })
      expect(report.columnDrift).toEqual([{ table: 'queue', missingColumns: [], unexpectedColumns: ['legacy_flag'], defaultMismatches: [], typeMismatches: [], nullabilityMismatches: [] }])
      expect(report.ok).toBe(false)
    })

    it('skips a managed table that has no live columns (absent table)', function () {
      const report = drifter.computeSchemaDrift({
        columns: {
          expected: [{ table: 'bam', columns: ['id', 'name'] }],
          live: []
        }
      })
      expect(report.columnDrift).toHaveLength(0)
      expect(report.ok).toBe(true)
    })

    it('reports ok when columns match', function () {
      const report = drifter.computeSchemaDrift({
        columns: {
          expected: [{ table: 'queue', columns: ['name', 'policy'] }],
          live: [{ table: 'queue', column: 'policy' }, { table: 'queue', column: 'name' }]
        }
      })
      expect(report.columnDrift).toHaveLength(0)
      expect(report.ok).toBe(true)
    })
  })

  describe('computeSchemaDrift function/enum drift (pure)', function () {
    // Simulates pg_get_functiondef: the stored body is byte-identical (Postgres keeps prosrc verbatim),
    // re-wrapped in $function$ under a CREATE OR REPLACE header.
    const asLive = (fn: { name: string, expectedBody: string }) =>
      ({ name: fn.name, def: `CREATE OR REPLACE FUNCTION pgboss.${fn.name}()\n RETURNS void\n LANGUAGE plpgsql\nAS $function$${fn.expectedBody}$function$\n` })

    const funcs = plans.expectedManagedFunctions('pgboss', false)

    it('reports ok when every function body matches', function () {
      const report = drifter.computeSchemaDrift({ functions: { expected: funcs, live: funcs.map(asLive) } })
      expect(report.missingFunctions).toHaveLength(0)
      expect(report.mismatchedFunctions).toHaveLength(0)
      expect(report.ok).toBe(true)
    })

    it('flags an absent function as missing', function () {
      const report = drifter.computeSchemaDrift({ functions: { expected: funcs, live: [asLive(funcs[0])] } })
      expect(report.missingFunctions.map(f => f.name)).toEqual(['delete_queue'])
      expect(report.ok).toBe(false)
    })

    it('flags a function whose body differs as mismatched', function () {
      const live = funcs.map(asLive)
      live[0].def = live[0].def.replace('$function$', '$function$ /* tampered */')
      const report = drifter.computeSchemaDrift({ functions: { expected: funcs, live } })
      expect(report.mismatchedFunctions.map(f => f.name)).toEqual(['create_queue'])
      expect(report.mismatchedFunctions[0].actualBody).toContain('tampered')
      expect(report.ok).toBe(false)
    })

    it('does not flag a function whose body cannot be extracted', function () {
      const report = drifter.computeSchemaDrift({
        functions: {
          expected: funcs,
          live: funcs.map(f => ({ name: f.name, def: `CREATE FUNCTION pgboss.${f.name}() RETURNS void LANGUAGE sql` }))
        }
      })
      expect(report.mismatchedFunctions).toHaveLength(0)
      expect(report.missingFunctions).toHaveLength(0)
    })

    it('reports no enum drift when values and order match', function () {
      const report = drifter.computeSchemaDrift({ enum: { name: 'job_state', expected: plans.EXPECTED_JOB_STATES, actual: [...plans.EXPECTED_JOB_STATES] } })
      expect(report.enumDrift).toBeNull()
      expect(report.ok).toBe(true)
    })

    it('flags a reordered enum as drift', function () {
      const reordered = [...plans.EXPECTED_JOB_STATES]
      ;[reordered[1], reordered[2]] = [reordered[2], reordered[1]]
      const report = drifter.computeSchemaDrift({ enum: { name: 'job_state', expected: plans.EXPECTED_JOB_STATES, actual: reordered } })
      expect(report.enumDrift).toBeTruthy()
      expect(report.enumDrift!.actualValues).toEqual(reordered)
      expect(report.ok).toBe(false)
    })

    it('flags an added enum value as drift', function () {
      const report = drifter.computeSchemaDrift({ enum: { name: 'job_state', expected: plans.EXPECTED_JOB_STATES, actual: [...plans.EXPECTED_JOB_STATES, 'archived'] } })
      expect(report.enumDrift!.actualValues).toContain('archived')
      expect(report.ok).toBe(false)
    })

    it('treats an absent enum (empty actual) as not-drift', function () {
      const report = drifter.computeSchemaDrift({ enum: { name: 'job_state', expected: plans.EXPECTED_JOB_STATES, actual: [] } })
      expect(report.enumDrift).toBeNull()
      expect(report.ok).toBe(true)
    })
  })

  describe('default / constraint drift (pure)', function () {
    it('normalizeDefault strips casts, lower-cases and drops redundant outer parens', function () {
      expect(drifter.normalizeDefault("'pending'::text")).toBe("'pending'")
      expect(drifter.normalizeDefault("'{}'::integer[]")).toBe("'{}'")
      expect(drifter.normalizeDefault("(now() + '5 mins'::interval)")).toBe("now() + '5 mins'")
      expect(drifter.normalizeDefault('gen_random_uuid()')).toBe('gen_random_uuid()')
    })

    it('normalizeConstraintDef lower-cases and strips quotes and casts', function () {
      expect(drifter.normalizeConstraintDef('CHECK ((dead_letter IS DISTINCT FROM name))'))
        .toBe('check ((dead_letter is distinct from name))')
      expect(drifter.normalizeConstraintDef('FOREIGN KEY ("name") REFERENCES s.queue("name")'))
        .toBe('foreign key (name) references s.queue(name)')
    })

    it('computeConstraintDrift flags a missing constraint', function () {
      const report = drifter.computeSchemaDrift({
        constraints: {
          expected: [{ table: 'queue', constraints: ['PRIMARY KEY (name)', 'CHECK ((dead_letter IS DISTINCT FROM name))'] }],
          live: [{ table: 'queue', def: 'PRIMARY KEY (name)' }]
        }
      })
      expect(report.constraintDrift).toEqual([{ table: 'queue', missingConstraints: ['CHECK ((dead_letter IS DISTINCT FROM name))'], unexpectedConstraints: [] }])
      expect(report.ok).toBe(false)
    })

    it('computeConstraintDrift flags an unexpected constraint', function () {
      const report = drifter.computeSchemaDrift({
        constraints: {
          expected: [{ table: 'warning', constraints: ['PRIMARY KEY (id)'] }],
          live: [{ table: 'warning', def: 'PRIMARY KEY (id)' }, { table: 'warning', def: "CHECK ((type <> ''::text))" }]
        }
      })
      expect(report.constraintDrift).toEqual([{ table: 'warning', missingConstraints: [], unexpectedConstraints: ["CHECK ((type <> ''::text))"] }])
      expect(report.ok).toBe(false)
    })

    it('computeConstraintDrift reports ok when the constraint set matches (modulo casts/quotes)', function () {
      const report = drifter.computeSchemaDrift({
        constraints: {
          expected: [{ table: 'queue', constraints: ['CHECK ((dead_letter IS DISTINCT FROM name))'] }],
          live: [{ table: 'queue', def: 'CHECK ((dead_letter IS DISTINCT FROM name))' }]
        }
      })
      expect(report.constraintDrift).toHaveLength(0)
      expect(report.ok).toBe(true)
    })

    it('computeConstraintDrift skips a table with no live constraints (absent table)', function () {
      const report = drifter.computeSchemaDrift({
        constraints: {
          expected: [{ table: 'bam', constraints: ['PRIMARY KEY (id)'] }],
          live: []
        }
      })
      expect(report.constraintDrift).toHaveLength(0)
      expect(report.ok).toBe(true)
    })

    it('flags a column whose default differs as default drift', function () {
      const report = drifter.computeSchemaDrift({
        columns: {
          expected: [{ table: 'queue', columns: ['notify'], defaults: { notify: 'false' } }],
          live: [{ table: 'queue', column: 'notify', default: 'true' }]
        }
      })
      expect(report.columnDrift).toHaveLength(1)
      expect(report.columnDrift[0].defaultMismatches).toEqual([{ column: 'notify', expected: 'false', actual: 'true' }])
      expect(report.ok).toBe(false)
    })

    it('reports no default drift when the default matches modulo casts', function () {
      const report = drifter.computeSchemaDrift({
        columns: {
          expected: [{ table: 'queue', columns: ['policy'], defaults: { policy: "'standard'" } }],
          live: [{ table: 'queue', column: 'policy', default: "'standard'::text" }]
        }
      })
      expect(report.columnDrift).toHaveLength(0)
      expect(report.ok).toBe(true)
    })
  })

  describe('column type / nullability + table presence (pure)', function () {
    it('flags a column type mismatch', function () {
      const report = drifter.computeSchemaDrift({
        columns: {
          expected: [{ table: 'queue', columns: ['retry_limit'], types: { retry_limit: { type: 'integer', notNull: true } } }],
          live: [{ table: 'queue', column: 'retry_limit', type: 'bigint', notNull: true }]
        }
      })
      expect(report.columnDrift[0].typeMismatches).toEqual([{ column: 'retry_limit', expected: 'integer', actual: 'bigint' }])
      expect(report.ok).toBe(false)
    })

    it('flags a nullability mismatch', function () {
      const report = drifter.computeSchemaDrift({
        columns: {
          expected: [{ table: 'queue', columns: ['policy'], types: { policy: { type: 'text', notNull: true } } }],
          live: [{ table: 'queue', column: 'policy', type: 'text', notNull: false }]
        }
      })
      expect(report.columnDrift[0].nullabilityMismatches).toEqual([{ column: 'policy', expected: true, actual: false }])
      expect(report.ok).toBe(false)
    })

    it('does not flag type/nullability when the expected table carries no types map', function () {
      const report = drifter.computeSchemaDrift({
        columns: {
          expected: [{ table: 'job', columns: ['state'] }],
          live: [{ table: 'job', column: 'state', type: 'pgboss.job_state', notNull: true }]
        }
      })
      expect(report.columnDrift).toHaveLength(0)
      expect(report.ok).toBe(true)
    })

    it('flags a missing table', function () {
      const report = drifter.computeSchemaDrift({
        tables: { expected: ['queue', 'warning', 'bam'], live: ['queue', 'warning'] }
      })
      expect(report.missingTables).toEqual(['bam'])
      expect(report.ok).toBe(false)
    })

    it('reports no missing tables when all are present', function () {
      const report = drifter.computeSchemaDrift({
        tables: { expected: ['queue', 'warning'], live: ['queue', 'warning', 'user_table'] }
      })
      expect(report.missingTables).toEqual([])
      expect(report.ok).toBe(true)
    })

    it('treats a live column with no type as an empty actual type', function () {
      const report = drifter.computeSchemaDrift({
        columns: {
          expected: [{ table: 'q', columns: ['x'], types: { x: { type: 'integer', notNull: false } } }],
          live: [{ table: 'q', column: 'x', notNull: false }]
        }
      })
      expect(report.columnDrift[0].typeMismatches).toEqual([{ column: 'x', expected: 'integer', actual: '' }])
    })

    it('expectedManagedTables adds job_common and partitions only when partitioned', function () {
      expect(plans.expectedManagedTables('pgboss', false)).not.toContain('job_common')
      const part = plans.expectedManagedTables('pgboss', true, [{ table: 'jabc', policy: 'standard' }])
      expect(part).toContain('job_common')
      expect(part).toContain('jabc')
      expect(part).toContain('job')
    })
  })

  describe('drifter edge branches (pure)', function () {
    it('extractFunctionBody returns empty when the closing tag is missing', function () {
      expect(drifter.extractFunctionBody('CREATE FUNCTION s.f() AS $$ BEGIN')).toBe('')
    })

    it('functionName returns empty for a non-function statement', function () {
      expect(drifter.functionName('SELECT 1')).toBe('')
    })

    it('treats a live column with a null default as an empty default', function () {
      const report = drifter.computeSchemaDrift({
        columns: {
          expected: [{ table: 'q', columns: ['x'], defaults: { x: '0' } }],
          live: [{ table: 'q', column: 'x', default: null }]
        }
      })
      expect(report.columnDrift[0].defaultMismatches).toEqual([{ column: 'x', expected: '0', actual: '' }])
    })

    it('does not report an extra index on a table outside the managed set', function () {
      const report = drifter.computeSchemaDrift({ indexes: { expected: [], live: [{ name: 'stray_i9', table: 't', valid: true }] } })
      expect(report.extraIndexes).toEqual([])
      expect(report.ok).toBe(true)
    })
  })

  describe('detectSchemaDrift (integration)', function () {
    it('reports ok for a freshly installed schema', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig })
      const report = await ctx.boss.detectSchemaDrift()
      expect(report.ok).toBe(true)
      expect(report.missing).toHaveLength(0)
      expect(report.invalid).toHaveLength(0)
      expect(report.extraIndexes).toHaveLength(0)
      expect(report.columnDrift).toHaveLength(0)
      expect(report.constraintDrift).toHaveLength(0)
    })

    it('detects a dropped index as missing', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig })
      const schema = ctx.schema

      const db = await helper.getDb()
      // job_common exists in partitioned mode; job in non-partitioned. Drop the fetch index either way.
      const table = helper.isCockroachDb ? 'job' : 'job_common'
      await db.executeSql(`DROP INDEX ${schema}.${table}_i5`)
      await db.close()

      const report = await ctx.boss.detectSchemaDrift()
      expect(report.ok).toBe(false)
      expect(report.missing.map(i => i.name)).toContain(`${table}_i5`)
      // the report carries the exact DDL to recreate it, schema-qualified
      const m = report.missing.find(i => i.name === `${table}_i5`)!
      expect(m.definition).toBe(`CREATE INDEX ${table}_i5 ON ${schema}.${table} (name, start_after) WHERE (state < 'active') AND (NOT blocked)`)
    })

    it('treats a missing index with a pending BAM build as building, not missing', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig })
      const schema = ctx.schema
      const table = helper.isCockroachDb ? 'job' : 'job_common'

      const db = await helper.getDb()
      await db.executeSql(`DROP INDEX ${schema}.${table}_i5`)
      // Insert as a fresh in_progress build, not pending: the started boss runs a live BAM worker, and a
      // 'pending' row would be picked up and actually built (CREATE INDEX CONCURRENTLY) before the drift
      // scan runs — a race that leaves `building` empty. A non-stale in_progress row is neither a pending
      // pickup nor stale-reclaimable, so the worker leaves it alone while it still counts as an
      // incomplete build the drift check reports as `building`.
      await db.executeSql(
        `INSERT INTO ${schema}.bam (name, version, status, started_on, table_name, command)
         VALUES ($1, 27, 'in_progress', now(), $2, $3)`,
        ['drift-build', table, `CREATE INDEX CONCURRENTLY ${table}_i5 ON ${schema}.${table} (name, start_after)`]
      )
      await db.close()

      const report = await ctx.boss.detectSchemaDrift()
      expect(report.building.map(i => i.name)).toContain(`${table}_i5`)
      expect(report.missing.map(i => i.name)).not.toContain(`${table}_i5`)
    })

    it('reports stray indexes on a managed table as extra (a warning; ok stays true)', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig })
      const schema = ctx.schema
      const table = helper.isCockroachDb ? 'job' : 'job_common'

      const db = await helper.getDb()
      await db.executeSql(`CREATE INDEX ${table}_i99 ON ${schema}.${table} (name)`) // stale pg-boss-named
      await db.executeSql(`CREATE INDEX my_custom_idx ON ${schema}.${table} (priority)`) // user-named
      await db.close()

      const report = await ctx.boss.detectSchemaDrift()
      const names = report.extraIndexes.map(i => i.name)
      expect(names).toContain(`${table}_i99`)
      expect(names).toContain('my_custom_idx')
      expect(report.ok).toBe(true) // extra indexes are informational, not drift
    })

    it('detects an index whose key columns are reordered as mismatched', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig })
      const schema = ctx.schema
      const table = helper.isCockroachDb ? 'job' : 'job_common'

      const db = await helper.getDb()
      // Rebuild i9 (name, id) with the columns swapped, keeping the same partial predicate so it is a
      // valid, present index that differs only in key-column order.
      await db.executeSql(`DROP INDEX ${schema}.${table}_i9`)
      await db.executeSql(`CREATE INDEX ${table}_i9 ON ${schema}.${table} (id, name) WHERE blocking AND state = 'completed'`)
      await db.close()

      const report = await ctx.boss.detectSchemaDrift()
      expect(report.ok).toBe(false)
      expect(report.mismatched.map(i => i.name)).toContain(`${table}_i9`)
      const m = report.mismatched.find(i => i.name === `${table}_i9`)!
      expect(m.differs).toEqual(['keys'])
      expect(m.expectedKeys).toBe('name, id')
      expect(m.actualKeys).toBe('id, name')
      // side-by-side full definitions: expected (correct) vs actual (from pg_get_indexdef)
      expect(m.definition).toBe(`CREATE INDEX ${table}_i9 ON ${schema}.${table} (name, id) WHERE blocking AND (state = 'completed')`)
      expect(m.actualDefinition).toContain('(id, name)')
      expect(m.actualDefinition).not.toContain('USING btree')
    })

    it('detects an index whose predicate differs as mismatched', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig })
      const schema = ctx.schema
      const table = helper.isCockroachDb ? 'job' : 'job_common'

      const db = await helper.getDb()
      // Same key columns as i9, but a different partial predicate (state = 'active' not 'completed').
      await db.executeSql(`DROP INDEX ${schema}.${table}_i9`)
      await db.executeSql(`CREATE INDEX ${table}_i9 ON ${schema}.${table} (name, id) WHERE blocking AND state = 'active'`)
      await db.close()

      const report = await ctx.boss.detectSchemaDrift()
      expect(report.ok).toBe(false)
      const m = report.mismatched.find(i => i.name === `${table}_i9`)!
      expect(m).toBeTruthy()
      expect(m.differs).toEqual(['predicate'])
      // Readable form from pg_get_indexdef (schema-qualified casts vary), so match on the meaningful bits.
      expect(m.expectedPredicate).toBe("blocking AND (state = 'completed')")
      expect(m.actualPredicate).toContain("state = 'active'")
      expect(m.actualPredicate).not.toContain("'completed'")
    })

    it('detectDrift tolerates catalog queries that throw (best-effort fallbacks)', async function () {
      // A backend that rejects the function/enum/column/constraint catalog queries must not abort the
      // whole scan — each falls back to empty. Stub db throws on those four, returns empty otherwise.
      const throwOn = [/pg_get_functiondef/, /pg_enum/, /pg_attribute/, /pg_get_constraintdef/]
      // Table presence comes from its own pg_class probe (relkind IN ('r','p'), no pg_attribute), which
      // stays available even though the column query throws — return the real managed tables for it so
      // the decoupling can be asserted below.
      const managedTables = plans.expectedManagedTables('pgboss', false)
      const db = {
        executeSql: async (text: string) => {
          if (throwOn.some(re => re.test(text))) throw new Error('catalog unsupported')
          if (/to_regclass/.test(text)) return { rows: [{ name: null }] } // non-partitioned probe
          if (/relkind IN \('r', 'p'\)/.test(text)) return { rows: managedTables.map(t => ({ table: t })) }
          return { rows: [] }
        }
      }
      const contractor = new Contractor(db as any, { schema: 'pgboss' } as any)
      const report = await contractor.detectDrift()

      // the throwing queries SKIP their checks; the scan still produced a report and did not false-flag.
      // A thrown function query means "unsupported / could not read", NOT "no functions exist" — so the
      // function check is skipped, not reported as every expected function missing (which would flip `ok`
      // to false on every scan against a backend like CockroachDB that rejects pg_get_functiondef).
      expect(report.missingFunctions).toHaveLength(0)
      expect(report.mismatchedFunctions).toHaveLength(0)
      expect(report.columnDrift).toHaveLength(0)
      expect(report.constraintDrift).toHaveLength(0)
      expect(report.enumDrift).toBeNull()
      // Table presence is read from pg_class, NOT derived from the (thrown) column query, so a failing
      // column diff does not false-report every managed table as missing.
      expect(report.missingTables).toHaveLength(0)
    })

    it('falls back to the columns-derived table set when the pg_class table probe throws', async function () {
      // Inverse of the case above: the dedicated pg_class table probe fails but the column query
      // succeeds. Table presence must then fall back to the tables seen in the column rows rather than
      // aborting or reporting everything missing. (getSchemaTables is the relkind probe WITHOUT
      // pg_attribute; getSchemaColumns also filters on relkind but joins pg_attribute.)
      const managedTables = plans.expectedManagedTables('pgboss', false)
      const db = {
        executeSql: async (text: string) => {
          const isTableProbe = /relkind IN \('r', 'p'\)/.test(text) && !/pg_attribute/.test(text)
          if (isTableProbe) throw new Error('pg_class unavailable')
          if (/to_regclass/.test(text)) return { rows: [{ name: null }] } // non-partitioned probe
          if (/pg_attribute/.test(text)) {
            // one column row per managed table, so the fallback set covers every expected table
            return { rows: managedTables.map(t => ({ table: t, column: 'id', default: null, type: 'text', notNull: true })) }
          }
          return { rows: [] }
        }
      }
      const contractor = new Contractor(db as any, { schema: 'pgboss' } as any)
      const report = await contractor.detectDrift()

      // fell back to the column-derived table set (which covers every expected table) — no false missing.
      expect(report.missingTables).toHaveLength(0)
    })

    it('handles a non-partitioned schema and a missing bam table', async function () {
      // noTablePartitioning is forced false by Attorney on non-distributed backends, so build the
      // schema directly and drive a Contractor to cover detectDrift's non-partitioned branch (job
      // indexes live on `job`, no job_common) and the bam-table-absent query fallback. The dropped
      // bam table is itself reported as a missing table.
      const npSchema = `${ctx.schema}_np`
      const db = await helper.getDb()
      try {
        await db.executeSql(plans.create(npSchema, schemaVersion, { createSchema: true, noTablePartitioning: true }))
        await db.executeSql(`DROP TABLE ${npSchema}.bam`)

        const contractor = new Contractor(db, { schema: npSchema } as any)
        const report = await contractor.detectDrift()

        // indexes/columns/constraints are clean; only the dropped bam table is drift
        expect(report.missing).toHaveLength(0)
        expect(report.mismatched).toHaveLength(0)
        expect(report.columnDrift).toHaveLength(0)
        expect(report.missingTables).toEqual(['bam'])
        expect(report.ok).toBe(false)
      } finally {
        await db.executeSql(`DROP SCHEMA IF EXISTS ${npSchema} CASCADE`)
        await db.close()
      }
    })

    it('detects a tampered function body as mismatched', async function () {
      if (helper.isCockroachDb) return // pg_get_functiondef / job_table_* helpers not present
      ctx.boss = await helper.start({ ...ctx.bossConfig })
      const schema = ctx.schema

      const db = await helper.getDb()
      // Redefine job_table_format with a different (trivial) body, keeping the signature intact.
      await db.executeSql(`
        CREATE OR REPLACE FUNCTION ${schema}.job_table_format(command text, table_name text)
        RETURNS text AS $$ SELECT command; $$ LANGUAGE sql IMMUTABLE
      `)
      await db.close()

      const report = await ctx.boss.detectSchemaDrift()
      expect(report.ok).toBe(false)
      expect(report.mismatchedFunctions.map(f => f.name)).toContain('job_table_format')
      const m = report.mismatchedFunctions.find(f => f.name === 'job_table_format')!
      expect(m.actualBody).toContain('SELECT command')
    })

    it('detects an unexpected table column as column drift', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig })
      const schema = ctx.schema

      const db = await helper.getDb()
      await db.executeSql(`ALTER TABLE ${schema}.warning ADD COLUMN legacy_flag boolean`)
      await db.close()

      const report = await ctx.boss.detectSchemaDrift()
      expect(report.ok).toBe(false)
      const c = report.columnDrift.find(t => t.table === 'warning')!
      expect(c).toBeTruthy()
      expect(c.unexpectedColumns).toContain('legacy_flag')
      expect(c.missingColumns).toHaveLength(0)
    })

    it('detects a dropped table column as column drift', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig })
      const schema = ctx.schema

      const db = await helper.getDb()
      await db.executeSql(`ALTER TABLE ${schema}.warning DROP COLUMN data`)
      await db.close()

      const report = await ctx.boss.detectSchemaDrift()
      expect(report.ok).toBe(false)
      const c = report.columnDrift.find(t => t.table === 'warning')!
      expect(c.missingColumns).toContain('data')
    })

    it('detects an unexpected constraint as constraint drift', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig })
      const schema = ctx.schema

      const db = await helper.getDb()
      await db.executeSql(`ALTER TABLE ${schema}.warning ADD CONSTRAINT extra_chk CHECK (type <> '')`)
      await db.close()

      const report = await ctx.boss.detectSchemaDrift()
      expect(report.ok).toBe(false)
      const c = report.constraintDrift.find(t => t.table === 'warning')!
      expect(c).toBeTruthy()
      expect(c.unexpectedConstraints.some(d => d.includes('extra_chk') || d.toLowerCase().includes('type'))).toBe(true)
      expect(c.missingConstraints).toHaveLength(0)
    })

    it('detects a changed column default as default drift', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig })
      const schema = ctx.schema

      const db = await helper.getDb()
      await db.executeSql(`ALTER TABLE ${schema}.queue ALTER COLUMN notify SET DEFAULT true`)
      await db.close()

      const report = await ctx.boss.detectSchemaDrift()
      expect(report.ok).toBe(false)
      const c = report.columnDrift.find(t => t.table === 'queue')!
      expect(c).toBeTruthy()
      expect(c.defaultMismatches.map(d => d.column)).toContain('notify')
    })

    it('detects a changed column type as type drift', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig })
      const schema = ctx.schema

      const db = await helper.getDb()
      await db.executeSql(`ALTER TABLE ${schema}.queue ALTER COLUMN retry_limit TYPE bigint`)
      await db.close()

      const report = await ctx.boss.detectSchemaDrift()
      expect(report.ok).toBe(false)
      const c = report.columnDrift.find(t => t.table === 'queue')!
      const m = c.typeMismatches.find(d => d.column === 'retry_limit')!
      expect(m).toBeTruthy()
      expect(m.expected).toBe('integer')
      expect(m.actual).toBe('bigint')
    })

    it('detects a dropped NOT NULL as nullability drift', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig })
      const schema = ctx.schema

      const db = await helper.getDb()
      await db.executeSql(`ALTER TABLE ${schema}.queue ALTER COLUMN policy DROP NOT NULL`)
      await db.close()

      const report = await ctx.boss.detectSchemaDrift()
      expect(report.ok).toBe(false)
      const c = report.columnDrift.find(t => t.table === 'queue')!
      const m = c.nullabilityMismatches.find(d => d.column === 'policy')!
      expect(m).toBeTruthy()
      expect(m.expected).toBe(true)
      expect(m.actual).toBe(false)
    })

    it('detects a dropped managed table as a missing table', async function () {
      ctx.boss = await helper.start({ ...ctx.bossConfig })
      const schema = ctx.schema

      const db = await helper.getDb()
      await db.executeSql(`DROP TABLE ${schema}.warning`)
      await db.close()

      const report = await ctx.boss.detectSchemaDrift()
      expect(report.ok).toBe(false)
      expect(report.missingTables).toContain('warning')
    })

    it('skips type/default/constraint checks on the cockroachdb backend', async function () {
      if (helper.isCockroachDb) return // this exercises the CRDB gate while running on Postgres
      const gateSchema = `${ctx.schema}_crdb_gate`
      const db = await helper.getDb()
      try {
        await db.executeSql(plans.create(gateSchema, schemaVersion, { createSchema: true }))
        // A type change that a Postgres-typed scan would flag as drift...
        await db.executeSql(`ALTER TABLE ${gateSchema}.queue ALTER COLUMN retry_limit TYPE bigint`)

        // ...is ignored when the contractor thinks it is talking to CockroachDB (INT8 typing differs).
        const crdb = new Contractor(db, { schema: gateSchema, backend: 'cockroachdb' } as any)
        const crdbReport = await crdb.detectDrift()
        expect(crdbReport.columnDrift).toHaveLength(0)

        // The same schema on the Postgres profile does flag the type drift.
        const pg = new Contractor(db, { schema: gateSchema, backend: 'postgres' } as any)
        const pgReport = await pg.detectDrift()
        expect(pgReport.columnDrift.find(c => c.table === 'queue')!.typeMismatches.map(m => m.column)).toContain('retry_limit')
      } finally {
        await db.executeSql(`DROP SCHEMA IF EXISTS ${gateSchema} CASCADE`)
        await db.close()
      }
    })

    it('detects an added enum value as enum drift', async function () {
      if (helper.isCockroachDb) return // enum probe via pg_enum not applicable
      ctx.boss = await helper.start({ ...ctx.bossConfig })
      const schema = ctx.schema

      const db = await helper.getDb()
      await db.executeSql(`ALTER TYPE ${schema}.job_state ADD VALUE 'archived'`)
      await db.close()

      const report = await ctx.boss.detectSchemaDrift()
      expect(report.ok).toBe(false)
      expect(report.enumDrift).toBeTruthy()
      expect(report.enumDrift!.actualValues).toContain('archived')
    })

    // key_strict_fifo exercises the gnarliest predicate (IN → = ANY (ARRAY[...])) on a dedicated
    // partition table, so this guards the predicate normalizer against false positives end-to-end.
    for (const policy of ['stately', 'key_strict_fifo'] as const) {
      it(`accounts for a partitioned ${policy} queue policy index without false drift`, async function () {
        if (helper.isCockroachDb) return // partitioning disabled on CockroachDB

        ctx.boss = await helper.start({ ...ctx.bossConfig, noDefault: true })
        await ctx.boss.createQueue(ctx.schema, { policy, partition: true })

        const report = await ctx.boss.detectSchemaDrift()
        expect(report.ok).toBe(true)
        expect(report.missing).toHaveLength(0)
        expect(report.mismatched).toHaveLength(0)
      })
    }
  })
})
