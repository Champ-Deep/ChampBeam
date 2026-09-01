// Node 22+ ships an experimental global `localStorage` stub that lacks the
// Storage API (no clear/key/length), and it shadows jsdom's implementation.
// Install a real in-memory Storage before any test touches it.
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
  getItem(key: string): string | null { return this.map.has(key) ? (this.map.get(key) ?? null) : null; }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
  removeItem(key: string): void { this.map.delete(key); }
  setItem(key: string, value: string): void { this.map.set(key, String(value)); }
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  const existing = (globalThis as Record<string, unknown>)[name] as Partial<Storage> | undefined;
  if (typeof existing?.clear !== 'function') {
    const store = new MemoryStorage();
    Object.defineProperty(globalThis, name, { value: store, configurable: true, writable: true });
    if (typeof window !== 'undefined') {
      Object.defineProperty(window, name, { value: store, configurable: true, writable: true });
    }
  }
}
