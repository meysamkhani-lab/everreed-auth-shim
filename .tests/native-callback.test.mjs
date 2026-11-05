import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../native-callback.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const path = '/native-callback.html';
const incoming = '?deeplink_scheme=everreed';
const native = 'everreed://oauth/auth?';
const probeUrl = 'https://lhzyjpbunwctxxnjniyi.supabase.co/functions/v1/auth-callback-probe';

// Run the served script with synthetic callback values and a browser that can
// ignore or refuse a custom scheme. No HTTP client or storage is available.
function openPage(suffix, { block = false, rejectScrub = false, beacon = true, initiallyHidden = false } = {}) {
  const url = new URL(path + suffix, 'https://auth.everreed.app');
  const requests = [], navigations = [], cleaned = [], logs = [], elements = new Map();
  const location = {
    host: url.host, hostname: url.hostname, pathname: url.pathname, search: url.search, hash: url.hash,
    set href(target) { navigations.push(target); if (block) throw new Error('Blocked by browser'); },
    replace(target) { navigations.push(target); },
  };
  const window = Object.assign(new EventTarget(), { location, history: {
    replaceState(_state, _title, target) {
      if (rejectScrub) throw new Error('History unavailable');
      cleaned.push(target);
      location.search = location.hash = '';
    },
  } });
  function element(id) {
    if (!elements.has(id)) elements.set(id, Object.assign(new EventTarget(), {
      hidden: id === 'returnBtn', style: {}, textContent: '',
    }));
    return elements.get(id);
  }
  const document = Object.assign(new EventTarget(), { getElementById: element, hidden: initiallyHidden });
  let now = 0;
  const timers = new Map();
  let sequence = 0;
  function later(fn, ms) { timers.set(++sequence, { fn, at: now + ms }); return sequence; }
  function advance(ms, run = true) {
    now += ms;
    if (run) for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(); }
  }
  class Xhr {
    open(method, target, async) { this.request = { method, target, async }; }
    setRequestHeader() {}
    send(body) { requests.push({ ...this.request, body }); }
  }
  runInNewContext(script, {
    window, document, URLSearchParams, Date: { now: () => now }, setTimeout: later,
    clearTimeout: id => timers.delete(id), XMLHttpRequest: Xhr, Blob,
    navigator: { sendBeacon(target, body) { if (beacon) requests.push({ target, body }); return beacon; } },
    console: { warn: (...args) => logs.push(args), log: (...args) => logs.push(args) },
  });
  const button = element('returnBtn');
  return { navigations, cleaned, requests, logs, button, elements, advance,
    click: () => button.dispatchEvent(new Event('click')),
    leave: () => window.dispatchEvent(new Event('pagehide')),
    show: () => { document.hidden = false; document.dispatchEvent(new Event('visibilitychange')); },
    hide: () => { document.hidden = true; document.dispatchEvent(new Event('visibilitychange')); },
  };
}

test('implicit callback forwards the complete encoded pair only to the native app', async () => {
  const page = openPage(incoming + '#access_token=fixture%2B%2F%3D&refresh_token=fixture%26refresh&provider_token=discard-me');
  assert.deepEqual(page.cleaned, [path]);
  assert.deepEqual(page.navigations, [native + 'access_token=fixture%2B%2F%3D&refresh_token=fixture%26refresh']);
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].target, probeUrl);
  assert.deepEqual(JSON.parse(await page.requests[0].body.text()), {
    stage: 'pre_deeplink', source: 'native-callback.html', host: 'auth.everreed.app', pathname: path,
    deeplink_path: 'oauth/auth', search_key_count: 1, hash_key_count: 3, has_access_token: true,
    has_refresh_token: true, has_code: false, has_error: false,
  });
  assert.deepEqual(page.logs, []);
  assert.doesNotMatch(Array.from(page.elements.values(), el => el.textContent).join(' '), /fixture|discard-me/);
});

for (const block of [false, true]) test('manual return survives an ' + (block ? 'exception' : 'ignored automatic attempt'), () => {
  const page = openPage(incoming + '&code=fixture%2Bcode', { block });
  const target = native + 'code=fixture%2Bcode';
  page.advance(4500);
  assert.deepEqual(page.navigations, [target]);
  assert.equal(page.button.hidden, false);
  page.click(); page.click(); page.advance(60000); page.click();
  assert.deepEqual(page.navigations, [target, target]);
  assert.equal(page.button.hidden, true);
});

for (const lifecycle of ['hide', 'leave']) test(lifecycle + ' clears a used or backgrounded handoff', () => {
  const page = openPage(incoming + '&code=fixture');
  page[lifecycle](); page.advance(4500); page.click();
  assert.deepEqual(page.navigations, [native + 'code=fixture']);
  assert.equal(page.button.hidden, true);
});

test('initially hidden callback offers the manual return when first shown', () => {
  const page = openPage(incoming + '&code=fixture', { initiallyHidden: true });
  page.advance(4500); page.show();
  assert.equal(page.button.hidden, false);
  page.click();
  assert.deepEqual(page.navigations, [native + 'code=fixture', native + 'code=fixture']);
});

test('retry expires even while timers are suspended', () => {
  const page = openPage(incoming + '&code=fixture');
  page.advance(4500); page.advance(61000, false); page.click();
  assert.deepEqual(page.navigations, [native + 'code=fixture']);
  assert.equal(page.button.hidden, true);
});

test('scrubs and refuses a missing, unapproved or ambiguous scheme', () => {
  for (const prefix of ['?', '?deeplink_scheme=another&', '?deeplink_scheme=EVERREED&', incoming + '&deeplink_scheme=other&']) {
    const page = openPage(prefix + 'code=fixture');
    page.advance(5000); page.click();
    assert.deepEqual(page.cleaned, [path]); assert.deepEqual(page.navigations, []);
    assert.deepEqual(page.requests, []); assert.equal(page.button.hidden, true);
  }
});

test('unavailable history fails closed without forwarding the callback', () => {
  const page = openPage(incoming + '&code=fixture', { rejectScrub: true });
  page.advance(5000); page.click();
  assert.deepEqual(page.navigations, []); assert.deepEqual(page.requests, []);
});

test('malformed callbacks and provider errors yield only a fixed outcome', () => {
  for (const [params, error] of [
    ['', 'no_token_or_code'], ['#access_token=fixture', 'no_token_or_code'],
    ['#refresh_token=fixture', 'no_token_or_code'],
    ['&code=a&code=b', 'no_token_or_code'], ['&code=a#access_token=b&refresh_token=c', 'no_token_or_code'],
    ['&access_token=a#refresh_token=b', 'no_token_or_code'],
    ['#error=access_denied&error_description=private', 'access_denied'],
    ['&code=fixture#error=server_error&error_description=private', 'callback_failed'],
    ['&error_code=provider_detail', 'callback_failed'], ['#error_description=private', 'callback_failed'],
  ]) {
    const page = openPage(incoming + params);
    page.advance(5000);
    assert.deepEqual(page.navigations, [native + 'error=' + error]);
  }
});

test('a refused beacon falls back to a nonblocking, value-free probe', () => {
  const page = openPage(incoming + '&code=fixture', { beacon: false });
  assert.equal(page.requests.length, 1);
  const [request] = page.requests;
  assert.deepEqual([request.method, request.target, request.async], ['POST', probeUrl, true]);
  assert.equal(JSON.parse(request.body).has_code, true);
  assert.doesNotMatch(request.body, /fixture/);
});
