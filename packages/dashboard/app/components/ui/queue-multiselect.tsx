import { useEffect, useMemo, useState } from 'react'
import { useFetcher, useSearchParams } from 'react-router'
import { Check, ChevronDown } from 'lucide-react'
import { resolveDbHref } from '~/components/db-link'
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover'
import { cn } from '~/lib/utils'
import type { QueueNamesResult } from '~/routes/queue-names'

interface QueueMultiSelectProps {
  value: string[]
  onChange: (value: string[]) => void
  placeholder?: string
  className?: string
}

// Searchable multi-select for queue names. A popover rather than a menu, so the search field
// takes focus as it opens and typing goes to it, as in Pro's audit log filters.
// It asks the server for the first names as it opens and for matches as the reader types, so a
// schema with thousands of queues never sends them all.
export function QueueMultiSelect ({
  value,
  onChange,
  placeholder = 'All Queues',
  className,
}: QueueMultiSelectProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const selected = useMemo(() => new Set(value), [value])
  const [searchParams] = useSearchParams()
  const names = useFetcher<QueueNamesResult>()
  const q = search.trim()
  const href = open ? resolveDbHref(`/queue-names?${new URLSearchParams({ q })}`, searchParams.get('db')) : null

  useEffect(() => {
    if (!href) return
    // At once as the menu opens, then a pause after typing, so each key is not a request.
    const timer = setTimeout(() => names.load(href), q ? 150 : 0)
    return () => clearTimeout(timer)
    // `names` is a new object each render; the request depends only on the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [href])

  // The chosen queues stay first, matching or not, so they can be cleared; the matches follow.
  const shown = useMemo(() => {
    const matches = (names.data?.names ?? []).filter(name => !selected.has(name))
    return [...value, ...matches]
  }, [names.data, selected, value])

  const toggle = (name: string) => {
    if (selected.has(name)) {
      onChange(value.filter(v => v !== name))
    } else {
      onChange([...value, name])
    }
  }

  const triggerLabel = value.length === 0
    ? placeholder
    : value.length === 1
      ? value[0]
      : `${value.length} queues`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          // The select trigger's filter look, so this sits with the filter bar's other dropdowns.
          'inline-flex h-[38px] min-w-[12rem] cursor-pointer items-center justify-between gap-2 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-card)] px-3 text-sm text-[var(--text-primary)] shadow-sm outline-none transition-colors',
          'focus-visible:border-[var(--border-focus)] focus-visible:shadow-[var(--shadow-focus)] data-popup-open:border-[var(--border-focus)]',
          className
        )}
      >
        <span className={cn('truncate', value.length === 0 && 'text-[var(--text-tertiary)]')}>
          {triggerLabel}
        </span>
        <ChevronDown className="size-4 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="max-h-80 w-auto min-w-[max(16rem,var(--anchor-width))] gap-0 overflow-hidden border-[var(--border-strong)] p-0">
        <div className="border-b border-[var(--border-subtle)] p-1.5">
          <input
            type="text"
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search queues..."
            aria-label="Search queues"
            className={cn(
              'h-8 w-full rounded-md border border-[var(--border-default)] bg-[var(--surface-card)] px-2.5 text-sm',
              'text-[var(--text-primary)] placeholder-[var(--text-tertiary)]',
              'focus:border-[var(--border-focus)] focus:outline-none'
            )}
          />
        </div>
        <div className="overflow-y-auto p-1" role="listbox" aria-multiselectable="true">
          {!names.data ? (
            <div className="px-2.5 py-1.5 text-sm text-[var(--text-tertiary)]">
              Loading…
            </div>
          ) : shown.length === 0 ? (
            <div className="px-2.5 py-1.5 text-sm text-[var(--text-tertiary)]">
              No queues match
            </div>
          ) : (
            shown.map(name => {
              const isSelected = selected.has(name)
              return (
                <button
                  key={name}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => toggle(name)}
                  className="grid w-full cursor-pointer grid-cols-[1rem_1fr] items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm outline-none select-none hover:bg-[var(--surface-hover)] focus-visible:bg-[var(--surface-hover)]"
                >
                  <span className="col-start-1 inline-flex size-4 items-center justify-center">
                    {isSelected && <Check className="size-4 text-[var(--primary-600)] dark:text-[var(--primary-400)]" aria-hidden="true" />}
                  </span>
                  <span className="col-start-2 truncate">{name}</span>
                </button>
              )
            })
          )}
        </div>
        {names.data?.more && (
          <div className="border-t border-[var(--border-subtle)] px-3 py-2 text-xs text-[var(--text-tertiary)]">
            More queues match. Type to narrow the list.
          </div>
        )}
        {value.length > 0 && (
          <div className="border-t border-[var(--border-subtle)] px-3 py-2">
            <button
              type="button"
              onClick={() => onChange([])}
              className="text-xs text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300 cursor-pointer"
            >
              Clear selection
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
