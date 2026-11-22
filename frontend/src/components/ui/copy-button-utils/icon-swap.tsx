"use client"

import type { AnimatePresenceProps, HTMLMotionProps } from "motion/react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"

export function IconSwap(props: React.PropsWithChildren<AnimatePresenceProps>) {
  return <AnimatePresence mode="wait" initial={false} {...props} />
}

type MotionElement = typeof motion.div | typeof motion.span

export function IconSwapItem({
  as: Component = motion.div,
  ...props
}: HTMLMotionProps<"div"> & {
  as?: MotionElement
}) {
  const reduced = useReducedMotion();
  return (
    <Component
      initial={reduced ? false : { opacity: 0, scale: 0.25 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: reduced ? 1 : 0.25 }}
      transition={{
        type: "spring",
        duration: reduced ? 0 : 0.2,
        bounce: 0,
      }}
      {...props}
    />
  )
}
