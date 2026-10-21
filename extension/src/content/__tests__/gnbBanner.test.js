/**
 * gnbBanner — the in-page card on fleet portal tabs. Runs against a tiny fake
 * DOM (the suite runs in node; no jsdom dependency) that records exactly what
 * the module builds.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function fakeNode(tag) {
  const node = {
    tag,
    children: [],
    attrs: {},
    styleProps: {},
    listeners: {},
    textContent: '',
    className: '',
    id: '',
    parent: null,
    shadow: null,
    style: { setProperty: (k, v) => (node.styleProps[k] = v) },
    setAttribute: (k, v) => (node.attrs[k] = String(v)),
    addEventListener: (ev, fn) => (node.listeners[ev] = fn),
    append: (...kids) => {
      for (const k of kids) {
        k.parent = node;
        node.children.push(k);
      }
    },
    remove: () => {
      if (!node.parent) return;
      node.parent.children = node.parent.children.filter((c) => c !== node);
      node.parent = null;
    },
    attachShadow: (opts) => {
      node.shadowMode = opts.mode;
      node.shadow = fakeNode('#shadow');
      return node.shadow;
    },
  };
  return node;
}

const find = (node, cls) => {
  if (node.className.split(' ').includes(cls)) return node;
  for (const c of [...node.children, ...(node.shadow ? [node.shadow] : [])]) {
    const hit = find(c, cls);
    if (hit) return hit;
  }
  return null;
};

describe('gnbBanner', () => {
  let body;
  let mod;

  beforeEach(async () => {
    body = fakeNode('body');
    vi.stubGlobal('document', { body, documentElement: body, createElement: (t) => fakeNode(t) });
    vi.useFakeTimers();
    vi.resetModules();
    mod = await import('../gnbBanner.js');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const host = () => body.children.find((c) => c.id === 'gnb-edge-banner');

  it('renders title and body as text inside a closed shadow root', () => {
    mod.showGnbBanner({ tone: 'ok', title: 'Connected', body: '<img src=x onerror=alert(1)>' });
    const h = host();
    expect(h.shadowMode).toBe('closed');
    expect(find(h, 'title').textContent).toBe('Connected');
    // Server text is never HTML: it stays a literal string in textContent.
    expect(find(h, 'body').textContent).toBe('<img src=x onerror=alert(1)>');
    expect(find(h, 'card').attrs.role).toBe('status');
    expect(find(h, 'card').styleProps['--tone']).toBe('#15803d');
  });

  it('uses role=alert for errors and falls back to the progress tone for unknown tones', () => {
    mod.showGnbBanner({ tone: 'err', title: 'Failed' });
    expect(find(host(), 'card').attrs.role).toBe('alert');
    mod.showGnbBanner({ tone: 'nope', title: 'x' });
    expect(find(host(), 'mark').className).toBe('mark spin');
  });

  it('replaces the previous card instead of stacking', () => {
    mod.showGnbBanner({ tone: 'progress', title: 'Connecting' });
    mod.showGnbBanner({ tone: 'ok', title: 'Connected' });
    expect(body.children.filter((c) => c.id === 'gnb-edge-banner')).toHaveLength(1);
    expect(find(host(), 'title').textContent).toBe('Connected');
  });

  it('the close button removes it', () => {
    mod.showGnbBanner({ tone: 'ok', title: 'Connected' });
    const close = find(host(), 'close');
    expect(close.attrs['aria-label']).toBe('Close GNB Edge message');
    close.listeners.click();
    expect(host()).toBeUndefined();
  });

  it('auto-hides after autoHideMs', () => {
    mod.showGnbBanner({ tone: 'ok', title: 'Connected', autoHideMs: 15000 });
    vi.advanceTimersByTime(14999);
    expect(host()).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(host()).toBeUndefined();
  });

  it('counts down closeAfterMs and calls onCountdownEnd exactly once', () => {
    const onEnd = vi.fn();
    mod.showGnbBanner({
      tone: 'ok',
      title: 'Connected',
      closeAfterMs: 5000,
      onCountdownEnd: onEnd,
    });
    const count = find(host(), 'count');
    expect(count.textContent).toBe('Closing in 5 s');
    vi.advanceTimersByTime(1000);
    expect(count.textContent).toBe('Closing in 4 s');
    vi.advanceTimersByTime(3999);
    expect(onEnd).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10000);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('a card closed or replaced mid-countdown never fires onCountdownEnd', () => {
    const onEnd = vi.fn();
    mod.showGnbBanner({ tone: 'ok', title: 'A', closeAfterMs: 3000, onCountdownEnd: onEnd });
    mod.hideGnbBanner();
    mod.showGnbBanner({ tone: 'ok', title: 'B', closeAfterMs: 3000, onCountdownEnd: onEnd });
    mod.showGnbBanner({ tone: 'ok', title: 'C' });
    vi.advanceTimersByTime(10000);
    expect(onEnd).not.toHaveBeenCalled();
  });
});
