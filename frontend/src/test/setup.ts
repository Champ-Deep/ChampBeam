import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Keep tests isolated: unmount React trees and clear persisted theme + the
// data-cb-theme attribute between cases so theme tests don't leak state.
afterEach(() => {
  cleanup();
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  document.documentElement.removeAttribute('data-cb-theme');
});
