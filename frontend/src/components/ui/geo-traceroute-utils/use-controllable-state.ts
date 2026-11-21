/**
 * LumeSec Elements: state that a component owns or its parent controls, and form reset support for controls
 * that keep their own state.
 */
import * as React from "react";

/** Options of {@link useControllableState}. */
export interface ControllableStateOptions<T> {
  /** The controlled value. When defined, the component renders it and only reports changes. */
  value?: T;
  /** The initial value when uncontrolled. */
  defaultValue: T;
  /** Called with every new value, controlled or not. */
  onChange?: (value: T) => void;
}

type SetState<T> = (next: T | ((previous: T) => T)) => void;

/**
 * State that can be controlled (`value` + `onChange`) or uncontrolled (`defaultValue`), like a native
 * input. `onChange` fires only when the value actually changes. A controlled value changes only when the
 * parent renders the new one: a change the parent ignores or rejects is not remembered, so the next update
 * starts from the value on screen. The setter keeps its identity across renders.
 */
export function useControllableState<T>({
  value,
  defaultValue,
  onChange,
}: ControllableStateOptions<T>): [T, SetState<T>] {
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue);
  const controlled = value !== undefined;
  const current = controlled ? value : uncontrolled;

  const currentRef = React.useRef(current);
  const onChangeRef = React.useRef(onChange);
  React.useEffect(() => {
    currentRef.current = current;
    onChangeRef.current = onChange;
  });

  const setValue = React.useCallback<SetState<T>>(
    (next) => {
      const previous = currentRef.current;
      const resolved = typeof next === "function" ? (next as (previous: T) => T)(previous) : next;
      if (Object.is(resolved, previous)) return;
      if (!controlled) {
        // several updates in one event build on each other, like React state
        currentRef.current = resolved;
        setUncontrolled(resolved);
      }
      onChangeRef.current?.(resolved);
    },
    [controlled],
  );

  return [current, setValue];
}

/**
 * Calls `onReset` when the form around `ref`'s element is reset, so a control that keeps its own state
 * (or submits through a hidden input) can restore its defaults like a native input. The element can be
 * anything inside the form; an input associated through its `form` attribute works too. The reset event
 * fires before the browser resets native controls.
 */
export function useFormReset(ref: React.RefObject<Element | null>, onReset: () => void) {
  const onResetRef = React.useRef(onReset);
  React.useEffect(() => {
    onResetRef.current = onReset;
  });
  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const owner = "form" in element && element.form instanceof HTMLFormElement ? element.form : element.closest("form");
    if (!owner) return;
    const handleReset = () => onResetRef.current();
    owner.addEventListener("reset", handleReset);
    return () => owner.removeEventListener("reset", handleReset);
  }, [ref]);
}
