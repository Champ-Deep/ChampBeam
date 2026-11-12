import { TableSkeleton } from './v-skeleton-7';

// Lists load as skeleton rows of the same shape, never a full-page spinner.
export function LoadingSpinner() {
  return <TableSkeleton rows={5} />;
}
