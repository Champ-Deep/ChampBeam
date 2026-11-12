"use client";

import type { ComponentProps } from "react";
import { CheckIcon, CircleXIcon, CopyIcon } from "lucide-react";
import { motion } from "motion/react";

import { cn } from "@/lib/utils";
import type { CopyState } from "@/components/ui/copy-button-utils/use-copy-to-clipboard";
import { useCopyToClipboard } from "@/components/ui/copy-button-utils/use-copy-to-clipboard";
import { Button } from './Button';
import {
  IconSwap,
  IconSwapItem,
} from "@/components/ui/copy-button-utils/icon-swap";

export type CopyStateIconProps = {
  state: CopyState;
  /** Custom icon for idle state. */
  idleIcon?: React.ReactNode;
  /** Custom icon for done state. */
  doneIcon?: React.ReactNode;
  /** Custom icon for error state. */
  errorIcon?: React.ReactNode;
};

export function CopyStateIcon({
  state,
  idleIcon,
  doneIcon,
  errorIcon,
}: CopyStateIconProps) {
  return (
    <IconSwap>
      <IconSwapItem key={state} as={motion.span}>
        {state === "idle" && (idleIcon ?? <CopyIcon data-slot="idle-icon" />)}

        {state === "done" && (doneIcon ?? <CheckIcon data-slot="done-icon" />)}

        {state === "error" &&
          (errorIcon ?? <CircleXIcon data-slot="error-icon" />)}
      </IconSwapItem>
    </IconSwap>
  );
}

export type CopyButtonProps = ComponentProps<typeof Button> & {
  /** The text to copy, or a function that returns the text. */
  text: string | (() => string);
  /** Called with the copied text on successful copy. */
  onCopySuccess?: (text: string) => void;
  /** Called with the error if the copy operation fails. */
  onCopyError?: (error: Error) => void;
} & Omit<CopyStateIconProps, "state">;

export function CopyButton({
  className,
  size = "sm",
  children,
  text,
  idleIcon,
  doneIcon,
  errorIcon,
  onClick,
  onCopySuccess,
  onCopyError,
  ...props
}: CopyButtonProps) {
  const { state, copy } = useCopyToClipboard({
    onCopySuccess,
    onCopyError,
  });

  return (
    <Button
      type="button"
      variant="ghost"
      className={cn("cb-dns-copy", className)}
      size={size}
      onClick={(e) => {
        void copy(text);
        onClick?.(e);
      }}
      aria-label="Copy"
      {...props}
    >
      <CopyStateIcon
        state={state}
        idleIcon={idleIcon}
        doneIcon={doneIcon}
        errorIcon={errorIcon}
      />
      <span role="status">{state === "done" ? "Copied" : state === "error" ? "Retry copy" : children ?? "Copy"}</span>
    </Button>
  );
}

export default CopyButton;
