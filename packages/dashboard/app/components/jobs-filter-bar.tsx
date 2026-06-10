import { useEffect, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { FilterSelect } from '~/components/ui/filter-select'
import { QueueMultiSelect } from '~/components/ui/queue-multiselect'
import {
  cn,
  JOB_STATE_OPTIONS,
  MAX_JSON_FILTER_PAIRS,
  type JobStateFilter,
  type JsonFilterPair,
} from '~/lib/utils'

export interface JobsFilters {
  state: JobStateFilter
  id: string
  queues: string[]
  minRetries: string
  data: JsonFilterPair[]
  output: JsonFilterPair[]
}

interface JobsFilterBarProps {
  filters: JobsFilters
  queueOptions: string[]
  onChange: (next: JobsFilters) => void
}

// Filter controls for the global Jobs page. Pure presentation: keeps the id /
// minRetries inputs in local state so typing is responsive, then commits via
// onChange on Enter or blur. The route owns the URL-synced state.
export function JobsFilterBar ({ filters, queueOptions, onChange }: JobsFilterBarProps) {
  const [idInput, setIdInput] = useState(filters.id)
  const [minRetriesInput, setMinRetriesInput] = useState(filters.minRetries)
  // Local pair lists so half-typed rows ({ key: '', value: '' }) can render
  // before they're complete enough to commit to the URL-backed filters.
  const [dataPairs, setDataPairs] = useState<JsonFilterPair[]>(filters.data)
  const [outputPairs, setOutputPairs] = useState<JsonFilterPair[]>(filters.output)
  const [advancedOpen, setAdvancedOpen] = useState(
    filters.data.length > 0 || filters.output.length > 0
  )

  // Track the last set of pairs WE committed to the URL so we can distinguish
  // our own echo (props === lastCommitted) from external changes like Clear All
  // or browser navigation. Without this, the moment a user clears the only
  // letter of a value the props sync back to [] and wipe their half-typed row.
  const lastCommittedDataRef = useRef<JsonFilterPair[]>(filters.data)
  const lastCommittedOutputRef = useRef<JsonFilterPair[]>(filters.output)

  // Sync local input state when filters change from the outside (e.g. URL nav,
  // "Clear all"). Without this the inputs would show stale text after a reset.
  useEffect(() => { setIdInput(filters.id) }, [filters.id])
  useEffect(() => { setMinRetriesInput(filters.minRetries) }, [filters.minRetries])
  useEffect(() => {
    if (!pairsEqual(filters.data, lastCommittedDataRef.current)) {
      setDataPairs(filters.data)
      lastCommittedDataRef.current = filters.data
    }
  }, [filters.data])
  useEffect(() => {
    if (!pairsEqual(filters.output, lastCommittedOutputRef.current)) {
      setOutputPairs(filters.output)
      lastCommittedOutputRef.current = filters.output
    }
  }, [filters.output])

  const commitId = () => {
    if (idInput === filters.id) return
    onChange({ ...filters, id: idInput.trim() })
  }

  const commitMinRetries = () => {
    if (minRetriesInput === filters.minRetries) return
    const trimmed = minRetriesInput.trim()
    const valid = trimmed === '' || (/^\d+$/.test(trimmed) && Number(trimmed) >= 0)
    onChange({ ...filters, minRetries: valid ? trimmed : '' })
    if (!valid) setMinRetriesInput('')
  }

  const handleDataChange = (next: JsonFilterPair[]) => {
    setDataPairs(next)
    const valid = next.filter(p => p.key && p.value !== '')
    // Only commit when the set of valid pairs actually changes — otherwise
    // typing an empty key would trigger an unnecessary navigation.
    if (!pairsEqual(valid, lastCommittedDataRef.current)) {
      lastCommittedDataRef.current = valid
      onChange({ ...filters, data: valid })
    }
  }

  const handleOutputChange = (next: JsonFilterPair[]) => {
    setOutputPairs(next)
    const valid = next.filter(p => p.key && p.value !== '')
    if (!pairsEqual(valid, lastCommittedOutputRef.current)) {
      lastCommittedOutputRef.current = valid
      onChange({ ...filters, output: valid })
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="flex-1">
          <div className="relative">
            <input
              type="text"
              placeholder="Filter by job ID (UUID)..."
              value={idInput}
              onChange={(e) => setIdInput(e.target.value)}
              onBlur={commitId}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitId()
                }
              }}
              className={cn(
                'w-full px-4 py-2 pl-10 rounded-lg border shadow-sm font-mono text-sm',
                'bg-white border-gray-300 text-gray-900 placeholder-gray-500',
                'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100 dark:placeholder-gray-400',
                'focus:outline-none focus:ring-2 focus:ring-primary-600 focus:border-primary-600',
                'dark:focus:ring-primary-500 dark:focus:border-primary-500'
              )}
            />
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
            {idInput && (
              <button
                type="button"
                onClick={() => {
                  setIdInput('')
                  onChange({ ...filters, id: '' })
                }}
                aria-label="Clear job id filter"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            )}
          </div>
        </div>
        <QueueMultiSelect
          options={queueOptions}
          value={filters.queues}
          onChange={(next) => onChange({ ...filters, queues: next })}
        />
        <FilterSelect
          value={filters.state}
          options={JOB_STATE_OPTIONS}
          onChange={(value) => onChange({ ...filters, state: value as JobStateFilter })}
        />
        <input
          type="number"
          min={0}
          inputMode="numeric"
          placeholder="Min retries"
          aria-label="Minimum retries"
          value={minRetriesInput}
          onChange={(e) => setMinRetriesInput(e.target.value)}
          onBlur={commitMinRetries}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitMinRetries()
            }
          }}
          className={cn(
            'w-32 px-3 py-2 text-sm rounded-lg border shadow-sm',
            'bg-white border-gray-300 text-gray-900 placeholder-gray-500',
            'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100 dark:placeholder-gray-400',
            'focus:outline-none focus:ring-2 focus:ring-primary-600 focus:border-primary-600',
            'dark:focus:ring-primary-500 dark:focus:border-primary-500'
          )}
        />
      </div>

      <div>
        <button
          type="button"
          onClick={() => setAdvancedOpen(o => !o)}
          aria-expanded={advancedOpen}
          className="text-sm text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300 cursor-pointer"
        >
          {advancedOpen ? 'Hide advanced filters' : 'Show advanced filters'}
        </button>

        {advancedOpen && (
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4">
            <PairFilterGroup
              title="Data"
              hint="key=value pairs match against the job's data column (jsonb @>)."
              pairs={dataPairs}
              onChange={handleDataChange}
            />
            <PairFilterGroup
              title="Output"
              hint="key=value pairs match against the job's output column."
              pairs={outputPairs}
              onChange={handleOutputChange}
            />
          </div>
        )}
      </div>
    </div>
  )
}

interface PairFilterGroupProps {
  title: string
  hint: string
  pairs: JsonFilterPair[]
  onChange: (pairs: JsonFilterPair[]) => void
}

function PairFilterGroup ({ title, hint, pairs, onChange }: PairFilterGroupProps) {
  const updatePair = (index: number, patch: Partial<JsonFilterPair>) => {
    onChange(pairs.map((p, i) => i === index ? { ...p, ...patch } : p))
  }
  const removePair = (index: number) => {
    onChange(pairs.filter((_, i) => i !== index))
  }
  const addPair = () => {
    if (pairs.length >= MAX_JSON_FILTER_PAIRS) return
    onChange([...pairs, { key: '', value: '' }])
  }

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-3 space-y-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">{title}</h3>
        <span className="text-xs text-gray-500 dark:text-gray-400">{hint}</span>
      </div>
      {pairs.length === 0 && (
        <p className="text-xs text-gray-500 dark:text-gray-400 italic">No {title.toLowerCase()} filters</p>
      )}
      {pairs.map((pair, index) => (
        <div key={index} className="flex items-center gap-2">
          <input
            type="text"
            placeholder="key"
            aria-label={`${title} filter key ${index + 1}`}
            value={pair.key}
            onChange={(e) => updatePair(index, { key: e.target.value })}
            className={cn(
              'flex-1 px-2 py-1 text-sm rounded border font-mono',
              'bg-white border-gray-300 text-gray-900 placeholder-gray-500',
              'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100 dark:placeholder-gray-400',
              'focus:outline-none focus:ring-1 focus:ring-primary-600'
            )}
          />
          <span className="text-gray-400">=</span>
          <input
            type="text"
            placeholder="value"
            aria-label={`${title} filter value ${index + 1}`}
            value={pair.value}
            onChange={(e) => updatePair(index, { value: e.target.value })}
            className={cn(
              'flex-1 px-2 py-1 text-sm rounded border font-mono',
              'bg-white border-gray-300 text-gray-900 placeholder-gray-500',
              'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100 dark:placeholder-gray-400',
              'focus:outline-none focus:ring-1 focus:ring-primary-600'
            )}
          />
          <button
            type="button"
            onClick={() => removePair(index)}
            aria-label={`Remove ${title.toLowerCase()} filter ${index + 1}`}
            className="p-1 text-gray-400 hover:text-red-600 cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={addPair}
        disabled={pairs.length >= MAX_JSON_FILTER_PAIRS}
      >
        <Plus className="h-4 w-4 mr-1" /> Add {title.toLowerCase()} filter
      </Button>
    </div>
  )
}

function pairsEqual (a: JsonFilterPair[], b: JsonFilterPair[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].key !== b[i].key || a[i].value !== b[i].value) return false
  }
  return true
}

function SearchIcon ({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
      />
    </svg>
  )
}
