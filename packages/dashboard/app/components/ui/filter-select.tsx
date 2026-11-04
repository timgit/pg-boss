import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'

interface FilterOption<T extends string | null> {
  value: T
  label: string
}

interface FilterSelectProps<T extends string | null> {
  value: T
  options: FilterOption<T>[]
  onChange: (value: T) => void
  /** Matches the fields beside it: `default` for 38px filter bars, `sm` for 34px rows, `xs` for chart controls. */
  size?: 'default' | 'sm' | 'xs'
  className?: string
  'aria-label'?: string
}

/** One choice from a short list of filter values, where a null value means no filter. */
export function FilterSelect<T extends string | null> ({
  value,
  options,
  onChange,
  size = 'default',
  className,
  'aria-label': ariaLabel,
}: FilterSelectProps<T>) {
  return (
    <Select<T>
      value={value}
      items={options}
      onValueChange={(next) => onChange(next as T)}
    >
      <SelectTrigger size={size} className={className} aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.label} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
