import { cn } from "@/lib/utils"

// 21st.dev shadcn Skeleton (25973 / 44951). Pulse only when motion is allowed.
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("motion-safe:animate-pulse rounded-md bg-muted", className)} {...props} />
}

export { Skeleton }
