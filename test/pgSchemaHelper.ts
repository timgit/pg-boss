import { serializeArrayParam } from '../src/plans.ts'

export function getColumns (schemas: string[]) {
  return `
    select (row_to_json(cols)::jsonb - 'ordinal_position' - 'dtd_identifier')::text
    from information_schema.columns cols
      join information_schema.tables tables on 
        cols.table_schema = tables.table_schema
          and cols.table_name = tables.table_name
    where tables.table_schema = ANY(${serializeArrayParam(schemas)})
      and tables.table_type = 'BASE TABLE'
    order by
      cols.table_name, 
      column_name
  `
}

export function getIndexes (schemas: string[]) {
  return `
    select row_to_json(pg_indexes)::text
    from pg_indexes
    where schemaname = ANY(${serializeArrayParam(schemas)})
    order by tablename,
      indexname
  `
}

export function getConstraints (schemas: string[]) {
  return `
    with constraints as (
    select
      kcu.table_name,
      tco.constraint_type,
      tco.constraint_name,
      kcu.ordinal_position,
      kcu.column_name
    from information_schema.table_constraints tco
      join information_schema.key_column_usage kcu
      on kcu.constraint_name = tco.constraint_name
      and kcu.constraint_schema = tco.constraint_schema
      and kcu.constraint_name = tco.constraint_name
    where kcu.table_schema = ANY(${serializeArrayParam(schemas)})
    )
    select row_to_json(constraints)::text
    from constraints
    order by table_name,
      constraint_name,
      ordinal_position
  `
}

export function getFunctions (schemas: string[]) {
  return `
    select (
      row_to_json(routines)::jsonb
      - 'specific_name'
      - 'specific_catalog'
      - 'routine_definition'
      || jsonb_build_object(
        'routine_definition_normalized',
        regexp_replace(routines.routine_definition, '\\s+', ' ', 'g')
      )
    )::text as row_to_json
    from information_schema.routines
    where routines.routine_schema = ANY(${serializeArrayParam(schemas)})
      and routines.routine_type = 'FUNCTION'
    order by routines.routine_name
  `
}
