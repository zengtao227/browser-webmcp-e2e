import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertNativeHostsSafe, extensionIdFromManifest, launchExtension, waitFor } from '../src/index.mjs';

const EXT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ext');
const GUARDED = 'com.example.guarded';

// One browser for the whole file: launching is the slow part.
const env = await launchExtension({
  extensionPath: EXT,
  hosts: { 'mock.test': (request, response) => { response.setHeader('content-type', 'text/html'); response.end('<title>Mock</title>mock'); } },
  nativeHostNames: [GUARDED],
});
test.after(() => env.close());

test('the extension loads with its fixed id and a live service worker', async () => {
  assert.equal(new URL(env.worker.url()).host, env.extensionId);
  assert.equal(env.extensionId, extensionIdFromManifest(EXT));
  assert.equal(await env.worker.evaluate(() => chrome.runtime.id), env.extensionId);
});

test('mocked and fixture hosts are served locally over HTTPS, and every request is logged', async () => {
  const page = await env.openPage(env.fixtureUrl('/form'));
  assert.equal(await page.title(), 'Fixture Form');
  const mock = await env.openPage('https://mock.test/');
  assert.equal(await mock.title(), 'Mock');
  assert.ok(env.requests.some((r) => r.host === 'fixture.test' && r.path === '/form'));
  assert.ok(env.requests.some((r) => r.host === 'mock.test'));
});

test('a window created by the extension itself also gets the mock (host mapping is browser-wide)', async () => {
  const id = await env.worker.evaluate(async () => (await chrome.windows.create({ url: 'https://mock.test/', focused: false })).tabs[0].id);
  assert.ok(id);
  await waitFor(async () => (await env.allPages()).some((p) => p.url() === 'https://mock.test/'), { message: 'the extension-created window' });
});

test('measured network boundary: unmapped hosts, IP literals and other local ports are not reachable', async () => {
  let otherHits = 0;
  const other = http.createServer((req, res) => { otherHits += 1; res.end('x'); });
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
  const otherPort = other.address().port;
  const page = await env.openPage(env.fixtureUrl('/second'));
  const reach = (url) => page.evaluate(async (u) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 3000);
    try { await fetch(u, { mode: 'no-cors', signal: abort.signal }); return 'reached'; } catch { return 'blocked'; } finally { clearTimeout(timer); }
  }, url);
  try {
    assert.equal(await reach('https://fixture.test/second'), 'reached');
    assert.equal(await reach('https://example.com/'), 'blocked');
    assert.equal(await reach('http://192.0.2.1/'), 'blocked');
    assert.equal(await reach(`http://127.0.0.1:${otherPort}/`), 'blocked');
    assert.equal(await reach(`http://localhost:${otherPort}/`), 'blocked');
    assert.equal(otherHits, 0, 'another local server must see nothing');
  } finally {
    other.close();
  }
});

test('native messaging under a guarded name reaches only the harmless fake host', async () => {
  const reply = await env.worker.evaluate((host) => chrome.runtime.sendNativeMessage(host, { version: 1, id: 'p', control: 'status' }), GUARDED);
  assert.equal(reply.result.marker, 'E2E_FAKE_HOST');
});

test('the native-host preflight stops on a real host, and on a directory it cannot read', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bwe2e-guard-'));
  assert.doesNotThrow(() => assertNativeHostsSafe([GUARDED], [dir, path.join(dir, 'does-not-exist')]));
  writeFileSync(path.join(dir, `${GUARDED}.json`), '{}');
  assert.throws(() => assertNativeHostsSafe([GUARDED], [dir]), /stopping without calling it/);
  const notADirectory = path.join(dir, 'file');
  writeFileSync(notADirectory, 'x');
  assert.throws(() => assertNativeHostsSafe(['other'], [notADirectory]), /Cannot confirm/);
  mkdirSync(path.join(dir, 'sub'));
});

test('the real Side Panel is opened and reached; its messages carry no tab, and the helper tab is gone', async () => {
  const work = await env.openPage(env.fixtureUrl('/form'));
  const panel = await env.openSidePanel(work);
  assert.equal(await panel.evaluate(() => document.getElementById('state').textContent), 'hello sent');
  const hello = await env.worker.evaluate(async () => (await chrome.storage.session.get('lastHello')).lastHello);
  assert.equal(hello.hasTab, false, 'a real Side Panel has no sender.tab');
  const panelPages = (await env.allPages()).filter((p) => p.url().endsWith('/panel.html'));
  assert.equal(panelPages.length, 1);
});

test('reloadExtension: a fresh service worker and empty session storage, local storage kept, open pages left open', async () => {
  await env.worker.evaluate(() => Promise.all([chrome.storage.session.set({ marker: 1 }), chrome.storage.local.set({ marker: 1 })]));
  const page = await env.openPage(env.fixtureUrl('/second'));
  const before = env.worker;
  const after = await env.reloadExtension();
  assert.notEqual(after, before);
  assert.equal(env.worker, after);
  assert.equal(await env.worker.evaluate(() => chrome.runtime.id), env.extensionId);
  assert.deepEqual(await env.worker.evaluate(() => chrome.storage.session.get('marker')), {});
  assert.deepEqual(await env.worker.evaluate(() => chrome.storage.local.get('marker')), { marker: 1 });
  assert.equal(page.isClosed(), false);
  assert.ok((await env.allPages()).some((p) => p.url() === env.fixtureUrl('/second')));
});

test('close removes the temporary directory', async () => {
  const other = await launchExtension({ extensionPath: EXT });
  const tmp = other.tmp;
  assert.ok(existsSync(tmp));
  await other.close();
  assert.equal(existsSync(tmp), false);
});
