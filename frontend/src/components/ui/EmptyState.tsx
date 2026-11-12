import React from 'react';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './empty';

interface EmptyStateProps {
  icon: React.ElementType;
  title: string;
  description: string;
  children?: React.ReactNode;
}

// Body is 21st.dev shadcn Empty (5851 / 8624); props unchanged so call sites do not move.
export function EmptyState({ icon: Icon, title, description, children }: EmptyStateProps) {
  return (
    <Empty className="rounded-xl border border-dashed border-border bg-card/60">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="bg-cb-chip text-cb-accent"><Icon aria-hidden /></EmptyMedia>
        <EmptyTitle className="font-display text-foreground">{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {children && <EmptyContent>{children}</EmptyContent>}
    </Empty>
  );
}
