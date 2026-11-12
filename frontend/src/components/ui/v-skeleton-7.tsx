// 21st.dev cnippet-dev "Data Table Skeleton" (9594 / 19002), adapted: rows and
// columns match the list it stands in for, so the layout does not jump on load.
import { Skeleton } from "@/components/ui/skeleton";

export function TableSkeleton({ rows = 5, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} className="w-full overflow-hidden rounded-xl border border-border bg-card">
      {Array.from({ length: rows }).map((_, row) => (
        <div className="flex items-center gap-4 border-b border-border px-4 py-3.5 last:border-b-0" key={row}>
          <Skeleton className="size-8 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
          <Skeleton className="hidden h-5 w-14 shrink-0 rounded-full sm:block" />
          <Skeleton className="h-3.5 w-12 shrink-0" />
        </div>
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}
