import { useEffect, useId, useRef, useState } from 'react'
import { Settings2, Link2, Check, Plus, Trash2, ChevronDown } from 'lucide-react'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { cn } from '~/lib/utils'
import {
  DEFAULT_JOB_COLUMNS,
  JOB_COLUMN_SOURCE_OPTIONS,
  createJobColumn,
  defaultJobColumnName,
  type JobColumn,
} from '~/lib/job-columns'

interface JobColumnsEditorProps {
  columns: JobColumn[]
  defaultColumns?: JobColumn[]
  getShareUrl: (columns: JobColumn[]) => string
  onColumnsChange: (columns: JobColumn[]) => void
}

export function JobColumnsEditor ({
  columns,
  defaultColumns = DEFAULT_JOB_COLUMNS,
  getShareUrl,
  onColumnsChange,
}: JobColumnsEditorProps) {
  const [manageOpen, setManageOpen] = useState(false)
  const [pendingColumns, setPendingColumns] = useState<ColumnMapping[]>([])
  const [copied, setCopied] = useState(false)

  const handleCopyLink = async () => {
    const url = getShareUrl(columns)
    await navigator.clipboard.writeText(url)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  const openViewEditor = () => {
    setPendingColumns(columns.map(toColumnMapping))
    setManageOpen(true)
  }

  const handleApplyColumns = () => {
    const next = pendingColumns
      .map(mapping => createJobColumn(mapping.path, mapping.name))
      .filter((column): column is JobColumn => column != null)

    onColumnsChange(next.length > 0 ? next : defaultColumns)
    setManageOpen(false)
  }

  const handleResetColumns = () => {
    onColumnsChange(defaultColumns)
    setManageOpen(false)
  }

  return (
    <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-[var(--text-tertiary)]">
          Columns: {columns.map(column => column.name).join(', ')}
        </p>
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleCopyLink}
        >
          {copied
            ? <Check className="h-4 w-4 mr-1" />
            : <Link2 className="h-4 w-4 mr-1" />}
          {copied ? 'Copied' : 'Copy link'}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={openViewEditor}>
          <Settings2 className="h-4 w-4 mr-1" />
          Manage view
        </Button>
      </div>

      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Configure columns</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Columns</span>
                <span className="text-xs text-[var(--text-tertiary)]">
                  Path examples: id, state, data.tenantId, output.status
                </span>
              </div>

              {pendingColumns.map((col, index) => (
                <ColumnMappingItem
                  key={index}
                  column={col}
                  onChange={(next) => {
                    setPendingColumns(pendingColumns.map((c, i) => i === index ? next : c))
                  }}
                  onRemove={() => {
                    setPendingColumns(pendingColumns.filter((_, i) => i !== index))
                  }}
                />
              ))}

              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setPendingColumns([...pendingColumns, emptyColumnMapping()])}
              >
                <Plus className="h-4 w-4 mr-1" /> Add column
              </Button>
            </div>

            <div className="flex justify-between gap-2 pt-2">
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={handleResetColumns}
              >
                <Trash2 className="h-4 w-4 mr-1" /> Reset columns
              </Button>

              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setManageOpen(false)}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={handleApplyColumns}
                >
                  Apply columns
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

interface ColumnMapping {
  path: string
  name: string
}

function ColumnMappingItem ({
  column,
  onChange,
  onRemove,
}: {
  column: ColumnMapping
  onChange: (col: ColumnMapping) => void
  onRemove: () => void
}) {
  const [path, setPath] = useState(column.path)
  const [name, setName] = useState(column.name)

  useEffect(() => {
    setPath(column.path)
    setName(column.name)
  }, [column])

  const updatePath = (nextPath: string) => {
    setPath(nextPath)
    const shouldRefreshName = !name.trim() || name === defaultJobColumnName(column.path)
    onChange({
      path: nextPath,
      name: shouldRefreshName ? defaultJobColumnName(nextPath) : name,
    })
  }

  return (
    <div className="space-y-2 rounded-lg border border-[var(--border-default)] p-2">
      <div className="grid grid-cols-1 md:grid-cols-[1fr_1.4fr_auto] gap-2 items-end">
        <label className="block">
          <span className="block text-xs font-medium mb-1">Name</span>
          <input
            type="text"
            placeholder="Column name"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              onChange({ path, name: e.target.value })
            }}
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="block text-xs font-medium mb-1">Source</span>
          <SourceInput
            value={path}
            onChange={updatePath}
          />
        </label>
        <button
          type="button"
          onClick={onRemove}
          className="p-2 text-[var(--text-tertiary)] hover:text-red-600 cursor-pointer"
          aria-label="Remove column"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

function SourceInput ({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const listboxId = useId()
  const inputRef = useRef<HTMLInputElement>(null)

  const selectSource = (source: string) => {
    onChange(source)
    setOpen(false)
    inputRef.current?.focus()
  }

  return (
    <div
      className="relative"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOpen(false)
        }
      }}
    >
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          placeholder="id, data.tenantId, output.status"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cn(inputClass, 'pr-8')}
          aria-label="Column source"
          aria-expanded={open}
          aria-controls={listboxId}
        />
        <button
          type="button"
          className="absolute inset-y-0 right-0 flex items-center px-2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
          aria-label="Show source options"
          onClick={() => {
            setOpen(current => !current)
            inputRef.current?.focus()
          }}
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>

      {open && (
        <div
          id={listboxId}
          role="listbox"
          className={cn(
            'absolute z-50 mt-1 w-full max-h-56 overflow-y-auto rounded-lg border shadow-lg',
            'bg-white border-gray-200 dark:bg-gray-900 dark:border-gray-700'
          )}
        >
          {JOB_COLUMN_SOURCE_OPTIONS.map(source => (
            <button
              key={source}
              type="button"
              role="option"
              aria-selected={source === value}
              className={cn(
                'block w-full px-3 py-2 text-left text-sm font-mono',
                'hover:bg-gray-100 dark:hover:bg-gray-800',
                source === value && 'bg-gray-100 dark:bg-gray-800'
              )}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => selectSource(source)}
            >
              {source}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function toColumnMapping (column: JobColumn): ColumnMapping {
  return {
    path: column.path,
    name: column.name,
  }
}

function emptyColumnMapping (): ColumnMapping {
  return {
    path: 'data.myField',
    name: 'My field',
  }
}

const inputClass = cn(
  'w-full px-2 py-1.5 text-sm rounded-lg border font-mono',
  'bg-white border-gray-300 text-gray-900 placeholder-gray-500',
  'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100 dark:placeholder-gray-400',
  'focus:outline-none focus:ring-1 focus:ring-primary-600'
)
