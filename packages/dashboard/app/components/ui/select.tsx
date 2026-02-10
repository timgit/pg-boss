import { useState, useRef, useEffect, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '~/lib/utils'

interface SelectProps {
  value: string
  onValueChange: (value: string) => void
  children: ReactNode
  className?: string
}

interface SelectItemProps {
  value: string
  children: ReactNode
}

export function Select({ value, onValueChange, children, className }: SelectProps) {
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  // Extract items from children
  const items: { value: string; label: ReactNode }[] = []

  const extractItems = (children: ReactNode) => {
    if (Array.isArray(children)) {
      children.forEach(extractItems)
    } else if (children && typeof children === 'object' && 'props' in children) {
      const child = children as any
      if (child.type === SelectItem) {
        items.push({ value: child.props.value, label: child.props.children })
      } else if (child.props?.children) {
        extractItems(child.props.children)
      }
    }
  }

  extractItems(children)

  const selectedItem = items.find(item => item.value === value)

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          'flex items-center justify-between w-full px-3 py-2 text-sm rounded-lg shadow-sm',
          'bg-white border border-gray-300 text-gray-900',
          'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100',
          'hover:bg-gray-50 dark:hover:bg-gray-800',
          'focus:outline-none focus:ring-2 focus:ring-primary-600 focus:border-transparent',
          'cursor-pointer'
        )}
      >
        <span className="truncate text-left">{selectedItem?.label || 'Select...'}</span>
        <ChevronDown className="h-4 w-4 opacity-50 ml-2 shrink-0" />
      </button>

      {isOpen && items.length > 0 && (
        <div className="absolute z-10 w-full mt-1 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-md shadow-lg max-h-60 overflow-auto">
          {items.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => {
                onValueChange(item.value)
                setIsOpen(false)
              }}
              className={cn(
                'w-full text-left px-3 py-2 text-sm',
                'hover:bg-gray-100 dark:hover:bg-gray-800',
                'text-gray-900 dark:text-gray-100',
                'cursor-pointer',
                item.value === value && 'bg-gray-50 dark:bg-gray-800'
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function SelectItem({ value, children }: SelectItemProps) {
  return null // This is just a marker component for the Select to extract items from
}

export const SelectTrigger = () => null
export const SelectValue = () => null
export const SelectContent = ({ children }: { children: ReactNode }) => <>{children}</>
export const SelectGroup = ({ children }: { children: ReactNode }) => <>{children}</>
export const SelectLabel = () => null
export const SelectSeparator = () => null
