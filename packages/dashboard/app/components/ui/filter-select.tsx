import { cn } from '~/lib/utils'

interface FilterOption<T extends string | null> {
  value: T
  label: string
}

interface FilterSelectProps<T extends string | null> {
  value: T
  options: FilterOption<T>[]
  onChange: (value: T) => void
  className?: string
}

export function FilterSelect<T extends string | null> ({
  value,
  options,
  onChange,
  className,
}: FilterSelectProps<T>) {
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange((e.target.value || null) as T)}
      className={cn(
        'px-3 py-2 text-sm rounded-lg shadow-sm',
        'bg-white border border-gray-300 text-gray-900',
        'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100',
        'focus:outline-none focus:ring-2 focus:ring-primary-600 focus:ring-offset-2',
        'dark:focus:ring-offset-gray-900',
        className
      )}
    >
      {options.map((option) => (
        <option key={option.label} value={option.value ?? ''}>
          {option.label}
        </option>
      ))}
    </select>
  )
}
