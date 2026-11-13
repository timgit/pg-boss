import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover'
import { useQueueSearch } from '~/lib/queue-search'
import { cn } from '~/lib/utils'

interface QueueSelectProps {
  id: string
  /** The form field the chosen queue posts as. */
  name: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
}

// Searchable single select for a queue name, as QueueMultiSelect is for several: it asks the server
// for the first names as it opens and for matches as the reader types, so a schema with thousands of
// queues never sends them all. The chosen queue posts with the form through a hidden field.
export function QueueSelect ({ id, name, value, onChange, placeholder = 'Choose a queue' }: QueueSelectProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const found = useQueueSearch(open, search)

  const choose = (queue: string) => {
    onChange(queue)
    setSearch('')
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <input type="hidden" name={name} value={value} />
      <PopoverTrigger
        id={id}
        className={cn(
          'flex h-10 w-full cursor-pointer items-center justify-between gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--surface-card)] px-3 text-left outline-none transition-colors',
          'focus-visible:border-[var(--border-focus)] focus-visible:shadow-[var(--shadow-focus)] data-popup-open:border-[var(--border-focus)]'
        )}
      >
        <span className={cn('truncate', value ? 'font-mono text-[13px] text-[var(--text-primary)]' : 'text-sm text-[var(--text-tertiary)]')}>
          {value || placeholder}
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
        <div className="overflow-y-auto p-1" role="listbox">
          {!found.names ? (
            <div className="px-2.5 py-1.5 text-sm text-[var(--text-tertiary)]">
              Loading…
            </div>
          ) : found.names.length === 0 ? (
            <div className="px-2.5 py-1.5 text-sm text-[var(--text-tertiary)]">
              No queues match
            </div>
          ) : (
            found.names.map(queue => (
              <button
                key={queue}
                type="button"
                role="option"
                aria-selected={queue === value}
                onClick={() => choose(queue)}
                className="grid w-full cursor-pointer grid-cols-[1rem_1fr] items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm outline-none select-none hover:bg-[var(--surface-hover)] focus-visible:bg-[var(--surface-hover)]"
              >
                <span className="col-start-1 inline-flex size-4 items-center justify-center">
                  {queue === value && <Check className="size-4 text-[var(--primary-600)] dark:text-[var(--primary-400)]" aria-hidden="true" />}
                </span>
                <span className="col-start-2 truncate font-mono text-[13px]">{queue}</span>
              </button>
            ))
          )}
        </div>
        {found.more && (
          <div className="border-t border-[var(--border-subtle)] px-3 py-2 text-xs text-[var(--text-tertiary)]">
            More queues match. Type to narrow the list.
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
