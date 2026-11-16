import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BeamGlobe } from './beam-globe';

let intersect: (entries: { isIntersecting: boolean }[]) => void;
let motionChange: () => void;
let hidden = false;
const motion = { matches: false, addEventListener: vi.fn((_name, callback) => { motionChange = callback; }), removeEventListener: vi.fn() };
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const context = { setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), fillRect: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn() };

beforeEach(() => {
  hidden = false;
  motion.matches = false;
  frames.clear();
  vi.clearAllMocks();
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('matchMedia', () => motion);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [129, 775] }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof intersect) { intersect = callback; }
    observe() {} disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function step(time: number) {
  const callbacks = [...frames.values()];
  frames.clear();
  act(() => callbacks.forEach((callback) => callback(time)));
}

it('settles before drawing one route, pauses offscreen and in hidden tabs, and cleans up', async () => {
  const view = render(<BeamGlobe />);
  await act(async () => {});
  act(() => intersect([{ isIntersecting: true }]));
  step(100);
  step(150);
  expect(context.stroke).not.toHaveBeenCalled();
  for (let time = 200; time <= 1800; time += 50) step(time);
  expect(context.stroke).toHaveBeenCalled();
  context.arc.mockClear();
  step(1850);
  // One sphere, one travelling head and at most two city endpoints.
  expect(context.arc.mock.calls.length).toBeLessThanOrEqual(4);
  act(() => intersect([{ isIntersecting: false }]));
  expect(frames.size).toBe(0);
  act(() => intersect([{ isIntersecting: true }]));
  expect(frames.size).toBe(1);
  hidden = true;
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(frames.size).toBe(0);
  hidden = false;
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(frames.size).toBe(1);
  view.unmount();
  expect(frames.size).toBe(0);
});

it('renders a static reduced-motion frame and responds to a preference change without a loop', async () => {
  motion.matches = true;
  render(<BeamGlobe />);
  await act(async () => {});
  act(() => intersect([{ isIntersecting: true }]));
  expect(context.stroke).toHaveBeenCalled();
  expect(frames.size).toBe(0);
  motion.matches = false;
  act(() => motionChange());
  expect(frames.size).toBe(1);
  motion.matches = true;
  act(() => motionChange());
  expect(frames.size).toBe(0);
});
