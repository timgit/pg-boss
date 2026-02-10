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
  triggerVariant?: 'ghost' | 'outline' | 'danger'
  trigger: React.ReactNode
  onConfirm: () => void
  disabled?: boolean
}

export function ConfirmDialog ({
  title,
  description,
  confirmLabel,
  confirmVariant = 'primary',
  triggerVariant = 'ghost',
  trigger,
  onConfirm,
  disabled,
}: ConfirmDialogProps) {
  const [isOpen, setIsOpen] = useState(false)

  const handleConfirm = () => {
    onConfirm()
    setIsOpen(false)
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <Button
        variant={triggerVariant}
        size="sm"
        disabled={disabled}
        onClick={() => setIsOpen(true)}
        className="cursor-pointer"
      >
        {trigger}
      </Button>
      <DialogContent hideCloseButton className="w-[28rem] max-w-[calc(100vw-2rem)]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="mt-2">{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-6 flex justify-end gap-3">
          <Button variant="outline" size="sm" className="cursor-pointer" onClick={() => setIsOpen(false)}>
            Cancel
          </Button>
          <Button
            variant={confirmVariant === 'danger' ? 'danger' : 'primary'}
            size="sm"
            className="cursor-pointer"
            onClick={handleConfirm}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
