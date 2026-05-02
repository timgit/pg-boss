import { useMemo, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from '~/components/ui/dropdown-menu'
import { cn } from '~/lib/utils'

interface QueueMultiSelectProps {
  options: string[]
  value: string[]
  onChange: (value: string[]) => void
  placeholder?: string
  className?: string
}

// Searchable multi-select for queue names. Wraps the existing dropdown-menu
// primitive so the popup styling matches the rest of the dashboard.
export function QueueMultiSelect ({
  options,
  value,
  onChange,
  placeholder = 'All Queues',
  className,
}: QueueMultiSelectProps) {
  const [search, setSearch] = useState('')
  const selected = useMemo(() => new Set(value), [value])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return options
    return options.filter(name => name.toLowerCase().includes(q))
  }, [options, search])

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
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'inline-flex items-center justify-between gap-2 px-3 py-2 text-sm rounded-lg shadow-sm min-w-[12rem]',
          'bg-white border border-gray-300 text-gray-900',
          'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100',
          'focus:outline-none focus:ring-2 focus:ring-primary-600 focus:ring-offset-2',
          'dark:focus:ring-offset-gray-900',
          'cursor-pointer',
          className
        )}
      >
        <span className={cn('truncate', value.length === 0 && 'text-gray-500 dark:text-gray-400')}>
          {triggerLabel}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-[16rem] max-h-80 overflow-hidden flex flex-col">
        <div className="p-2 border-b border-gray-200 dark:border-gray-800">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search queues..."
            className={cn(
              'w-full px-2 py-1 text-sm rounded border',
              'bg-white border-gray-300 text-gray-900 placeholder-gray-500',
              'dark:bg-gray-950 dark:border-gray-700 dark:text-gray-100 dark:placeholder-gray-400',
              'focus:outline-none focus:ring-1 focus:ring-primary-600'
            )}
          />
        </div>
        <div className="overflow-y-auto py-1" role="listbox" aria-multiselectable="true">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400 text-center">
              No queues match
            </div>
          ) : (
            filtered.map(name => {
              const isSelected = selected.has(name)
              return (
                <button
                  key={name}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => toggle(name)}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left',
                    'hover:bg-gray-100 dark:hover:bg-gray-800',
                    'cursor-pointer'
                  )}
                >
                  <span className="w-4 h-4 inline-flex items-center justify-center">
                    {isSelected && <Check className="h-4 w-4 text-primary-600" />}
                  </span>
                  <span className="truncate flex-1">{name}</span>
                </button>
              )
            })
          )}
        </div>
        {value.length > 0 && (
          <div className="border-t border-gray-200 dark:border-gray-800 p-2">
            <button
              type="button"
              onClick={() => onChange([])}
              className="text-xs text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300 cursor-pointer"
            >
              Clear selection
            </button>
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
