import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog'
import { Button } from './button'

interface ConfirmDialogProps {
  title: string
  description: string
  confirmLabel: string
  confirmVariant?: 'primary' | 'danger'
  trigger: React.ReactNode
  onConfirm: () => void
  isDisabled?: boolean
}

export function ConfirmDialog ({
  title,
  description,
  confirmLabel,
  confirmVariant = 'primary',
  trigger,
  onConfirm,
  isDisabled,
}: ConfirmDialogProps) {
  const [isOpen, setIsOpen] = useState(false)

  const handleConfirm = () => {
    onConfirm()
    setIsOpen(false)
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <Button
        variant="ghost"
        size="sm"
        disabled={isDisabled}
        onClick={() => setIsOpen(true)}
        className={confirmVariant === 'danger' ? 'text-error-600 hover:text-error-700 hover:bg-error-50 dark:text-error-400 dark:hover:text-error-300 dark:hover:bg-error-950' : ''}
      >
        {trigger}
      </Button>
      <DialogContent hideCloseButton className="w-[28rem] max-w-[calc(100vw-2rem)]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="mt-2">{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-6 flex justify-end gap-3">
          <Button variant="outline" size="sm" onClick={() => setIsOpen(false)}>
            Cancel
          </Button>
          <Button
            variant={confirmVariant === 'danger' ? 'danger' : 'primary'}
            size="sm"
            onClick={handleConfirm}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
