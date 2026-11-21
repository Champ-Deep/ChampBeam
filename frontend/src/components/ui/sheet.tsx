import * as React from 'react';
import { Dialog } from 'radix-ui';
import { X } from 'lucide-react';

/**
 * Right-side sheet on the Radix Dialog the repo already ships. Structure from 21st.dev "Team Invite Sheet"
 * (id 26144, cnippet-dev/v-sheet-7), restyled with ChampBeam tokens; the demo's base-ui primitives are not used.
 */
export function Sheet({ open, onOpenChange, title, description, children, footer }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode;
}) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="cb-sheet-scrim" />
      <Dialog.Content className="cb-sheet">
        <header className="cb-sheet-head">
          <Dialog.Title className="cb-sheet-title">{title}</Dialog.Title>
          {description ? <Dialog.Description className="cb-sheet-desc">{description}</Dialog.Description> : <Dialog.Description className="sr-only">{title}</Dialog.Description>}
          <Dialog.Close className="cb-icon-btn cb-sheet-close" aria-label="Close"><X className="h-4 w-4" aria-hidden="true" /></Dialog.Close>
        </header>
        <div className="cb-sheet-body">{children}</div>
        {footer && <footer className="cb-sheet-foot">{footer}</footer>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

/** Centered modal on the same primitive, for short forms (create organization, confirm a move). */
export function Modal({ open, onOpenChange, title, description, children }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: React.ReactNode; children: React.ReactNode;
}) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="cb-sheet-scrim" />
      <Dialog.Content className="cb-modal">
        <Dialog.Title className="cb-sheet-title">{title}</Dialog.Title>
        {description ? <Dialog.Description className="cb-sheet-desc">{description}</Dialog.Description> : <Dialog.Description className="sr-only">{title}</Dialog.Description>}
        <Dialog.Close className="cb-icon-btn cb-sheet-close" aria-label="Close"><X className="h-4 w-4" aria-hidden="true" /></Dialog.Close>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
