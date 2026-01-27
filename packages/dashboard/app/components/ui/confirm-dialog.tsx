import { useState } from "react";
import {
  Dialog,
  DialogTrigger,
  Modal,
  ModalOverlay,
  Heading,
} from "react-aria-components";
import { Button } from "./button";

interface ConfirmDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  confirmVariant?: "primary" | "danger";
  trigger: React.ReactNode;
  onConfirm: () => void;
  isDisabled?: boolean;
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  confirmVariant = "primary",
  trigger,
  onConfirm,
  isDisabled,
}: ConfirmDialogProps) {
  const [isOpen, setIsOpen] = useState(false);

  const handleConfirm = () => {
    onConfirm();
    setIsOpen(false);
  };

  return (
    <DialogTrigger isOpen={isOpen} onOpenChange={setIsOpen}>
      <Button
        variant="ghost"
        size="sm"
        isDisabled={isDisabled}
        className={confirmVariant === "danger" ? "text-error-600 hover:text-error-700 hover:bg-error-50" : ""}
      >
        {trigger}
      </Button>
      <ModalOverlay className="fixed inset-0 z-50 bg-gray-900/50 flex items-center justify-center p-4">
        <Modal>
          <Dialog className="outline-none">
            <div className="bg-white rounded-lg shadow-xl p-6 w-[28rem] max-w-[calc(100vw-2rem)]">
              <Heading slot="title" className="text-lg font-semibold text-gray-900 mb-2">
                {title}
              </Heading>
              <p className="text-sm text-gray-600 mb-6">{description}</p>
              <div className="flex justify-end gap-3">
                <Button variant="outline" size="sm" onPress={() => setIsOpen(false)}>
                  Cancel
                </Button>
                <Button
                  variant={confirmVariant === "danger" ? "danger" : "primary"}
                  size="sm"
                  onPress={handleConfirm}
                >
                  {confirmLabel}
                </Button>
              </div>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}
