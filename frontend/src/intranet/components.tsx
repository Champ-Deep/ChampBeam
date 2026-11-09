import { errorText } from './shared';

export function PageHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <header>
      <h1>{title}</h1>
      {children}
    </header>
  );
}

export function QueryState({ isLoading, error, label }: { isLoading: boolean; error: unknown; label: string }) {
  if (isLoading) return <p role="status">Loading {label}…</p>;
  if (error) return <p role="alert">{errorText(error, `Could not load ${label}.`)}</p>;
  return null;
}
