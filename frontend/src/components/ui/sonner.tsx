import { Toaster as Sonner } from "sonner"

// 21st.dev shadcn Sonner (317 / 886), themed through the --cb-* bridge.
type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = (props: ToasterProps) => (
  <Sonner
    theme="light"
    className="toaster group"
    toastOptions={{
      classNames: {
        toast: "group toast group-[.toaster]:bg-card group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg group-[.toaster]:rounded-xl group-[.toaster]:font-sans",
        description: "group-[.toast]:text-muted-foreground",
        actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
        cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        success: "group-[.toaster]:[&_[data-icon]]:text-success",
        error: "group-[.toaster]:[&_[data-icon]]:text-danger",
      },
    }}
    {...props}
  />
)

export { Toaster }
