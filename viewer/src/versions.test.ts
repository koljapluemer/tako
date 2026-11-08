import { describe, expect, it, vi } from 'vitest';
import type { LoadedModel } from './model';
import { formatAge, ModelCache } from './versions';

const model = (bytes = 1) => ({ bytes }) as unknown as LoadedModel;

describe('ModelCache', () => {
  it('evicts the least recently used model but never the current one', () => {
    const dispose = vi.fn();
    const cache = new ModelCache(dispose, 2, 100);
    const [a, b, c] = [model(), model(), model()];
    cache.put('p', 0, a, a);
    cache.put('p', 1, b, a);
    cache.put('p', 2, c, a);
    expect(cache.get('p', 0)).toBe(a);
    expect(cache.get('p', 1)).toBeNull();
    expect(dispose).toHaveBeenCalledExactlyOnceWith(b);
  });

  it('honours the byte budget', () => {
    const dispose = vi.fn();
    const cache = new ModelCache(dispose, 5, 10);
    const [a, b] = [model(8), model(8)];
    cache.put('p', 0, a, null);
    cache.put('p', 1, b, b);
    expect(dispose).toHaveBeenCalledExactlyOnceWith(a);
  });

  it('forgets revisions an edit overwrites, keeping earlier ones', () => {
    const dispose = vi.fn();
    const cache = new ModelCache(dispose);
    const [a, b, c] = [model(), model(), model()];
    cache.put('p', 0, a, null);
    cache.put('p', 1, b, null);
    cache.put('q', 1, c, null);
    cache.dropAfter('p', 1, null);
    expect(cache.get('p', 0)).toBe(a);
    expect(cache.get('p', 1)).toBeNull();
    expect(cache.get('q', 1)).toBe(c);
  });
});

describe('formatAge', () => {
  const now = Date.parse('2026-01-10T12:00:00Z');

  it('uses the largest sensible unit', () => {
    expect(formatAge('2026-01-10T11:59:40Z', now)).toBe('just now');
    expect(formatAge('2026-01-10T11:15:00Z', now)).toBe('45 min ago');
    expect(formatAge('2026-01-10T09:00:00Z', now)).toBe('3 h ago');
    expect(formatAge('2026-01-07T12:00:00Z', now)).toBe('3 d ago');
  });

  it('has nothing to say about entries without a time', () => {
    expect(formatAge(null, now)).toBe('');
  });
});
