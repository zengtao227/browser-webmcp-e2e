import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { extensionIdFromManifest } from './extension-id.mjs';
import { assertNativeHostsSafe } from './native-guard.mjs';
import { waitFor } from './wait.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(here, '..', 'fixtures');
const FIXTURE_HOSTS = ['fixture.test', 'mail.test'];
const FIXTURE_FILES = { '/form': 'form.html', '/mail': 'mail.html', '/popup': 'popup.html', '/second': 'second.html' };

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function makeCertificate(dir, hostnames) {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  const san = hostnames.map((host) => `DNS:${host}`).join(',');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=e2e.test', '-addext', `subjectAltName=${san}`], { stdio: 'ignore' });
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

function installFakeHosts(profileDir, names, extensionId, tmp) {
  if (names.length === 0) return;
  const wrapper = path.join(tmp, 'fake-host.sh');
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${path.join(here, 'fake-host.mjs')}"\n`);
  chmodSync(wrapper, 0o755);
  const dir = path.join(profileDir, 'NativeMessagingHosts');
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({
      name,
      description: 'Harmless host for browser-webmcp-e2e',
      path: wrapper,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${extensionId}/`],
    }));
  }
}

/**
 * Starts Chromium (Playwright's build, a temporary profile) with the unpacked extension.
 *
 * - `hosts`: origins the project mocks, `{ 'chat.deepseek.com': (request, response) => … }`. They are
 *   mapped to a local HTTPS server. The harness also serves generic fixtures on fixture.test / mail.test.
 * - Network: every hostname except those is unresolvable, and a dead proxy catches everything else
 *   (IP literals, other loopback ports). Measured, not assumed: see the self-test. This is not a firewall
 *   and is only claimed for the trusted mock and fixture pages the tests serve.
 * - Native messaging: `nativeHostNames` are registered, inside the temporary profile only, to a harmless
 *   fake host. Before starting, the system-level host directories are read; a real host with such a name
 *   there (or an unreadable directory) stops the run without calling anything.
 */
export async function launchExtension({ extensionPath, hosts = {}, nativeHostNames = [], headless = true } = {}) {
  if (!extensionPath || !existsSync(path.join(extensionPath, 'manifest.json'))) throw new Error('extensionPath must contain manifest.json.');
  assertNativeHostsSafe(nativeHostNames);

  const extensionId = extensionIdFromManifest(extensionPath);
  const manifest = JSON.parse(readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8'));
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'bwe2e-'));
  const profileDir = path.join(tmp, 'profile');
  mkdirSync(profileDir);

  const mockedHosts = Object.keys(hosts);
  const allHosts = [...mockedHosts, ...FIXTURE_HOSTS];
  const requests = [];
  const tls = makeCertificate(tmp, allHosts);
  const server = https.createServer(tls, (request, response) => {
    const host = String(request.headers.host ?? '').split(':')[0];
    const url = new URL(request.url, `https://${host}`);
    requests.push({ host, path: url.pathname, method: request.method });
    if (url.pathname.startsWith('/favicon')) {
      response.statusCode = 404;
      return response.end();
    }
    if (hosts[host]) return hosts[host](request, response, url);
    const file = FIXTURE_HOSTS.includes(host) ? FIXTURE_FILES[url.pathname] : undefined;
    if (!file) {
      response.statusCode = 404;
      return response.end('not found');
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    return response.end(readFileSync(path.join(FIXTURE_DIR, file)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const cdpPort = await freePort();

  installFakeHosts(profileDir, nativeHostNames, extensionId, tmp);

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      `--host-resolver-rules=${allHosts.map((host) => `MAP ${host} 127.0.0.1:${port}`).join(', ')}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`,
      '--ignore-certificate-errors',
      '--proxy-server=http://127.0.0.1:9',
      `--proxy-bypass-list=${allHosts.join(';')};<-loopback>`,
      `--remote-debugging-port=${cdpPort}`,
    ],
  });

  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });

  let cdpBrowser = null;
  const env = {
    context,
    worker,
    extensionId,
    requests,
    tmp,
    fixtureUrl: (pathname, host = 'fixture.test') => `https://${host}${pathname}`,

    /** Opens `url` in a new tab of the browser window the extension's panel will bind to. */
    async openPage(url) {
      const page = await context.newPage();
      await page.goto(url);
      await page.bringToFront();
      return page;
    },

    /**
     * Opens the extension's REAL Side Panel for the window of `workPage`. `sidePanel.open()` needs a user
     * gesture, so a trusted click on an extension page (the manifest's side-panel page) triggers it; that
     * helper tab is closed again, and the panel is then reached over the debugging connection.
     */
    async openSidePanel(workPage) {
      const panelPath = manifest.side_panel?.default_path;
      if (!panelPath) throw new Error('The manifest declares no side_panel.default_path.');
      const panelUrl = `chrome-extension://${extensionId}/${panelPath}`;
      await workPage.bringToFront();
      const windowId = await worker.evaluate(async () => (await chrome.windows.getLastFocused()).id);

      const gesture = await context.newPage();
      await gesture.goto(panelUrl);
      await gesture.evaluate((id) => {
        const button = document.createElement('button');
        button.id = '__e2e_open_panel';
        button.style.cssText = 'position:fixed;top:0;left:0;width:200px;height:80px;z-index:2147483647';
        button.onclick = () => chrome.sidePanel.open({ windowId: id });
        document.body.append(button);
      }, windowId);
      await gesture.click('#__e2e_open_panel');
      await gesture.close();
      await workPage.bringToFront();

      cdpBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
      return waitFor(
        () => cdpBrowser.contexts().flatMap((c) => c.pages()).find((p) => p.url() === panelUrl),
        { message: 'the Side Panel page to appear', timeout: 15_000 },
      );
    },

    /**
     * Reloads the unpacked extension the way its Reload button on chrome://extensions does, with every open
     * page (a provider window, work tabs) left open: their content scripts are orphaned and the service worker
     * and `storage.session` start fresh. (`chrome.runtime.reload()` does not work here: it leaves a flag-loaded
     * extension unloaded.) Extension pages, such as the Side Panel, close; open the panel again afterwards.
     * Resolves once the new service worker is running; `env.worker` is replaced by it.
     */
    async reloadExtension() {
      const previous = worker;
      const manager = await context.newPage();
      try {
        await manager.goto('chrome://extensions');
        // Without developer mode (this temporary profile's setting only) Chromium marks a reloaded unpacked
        // extension as `unsupportedDeveloperExtension` and leaves it disabled.
        await manager.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
        await manager.evaluate((id) => chrome.developerPrivate.reload(id, { failQuietly: true }), extensionId);
        await waitFor(() => !context.serviceWorkers().includes(previous), { message: 'the old service worker to be unloaded', timeout: 15_000 });
        // The reload call returns before the extension is loaded again; its pages are blocked until then.
        await waitFor(
          () => manager.evaluate(async (id) => (await chrome.developerPrivate.getExtensionsInfo()).some((item) => item.id === id && item.state === 'ENABLED'), extensionId),
          { message: 'the extension to be enabled again', timeout: 15_000 },
        );
      } finally {
        await manager.close();
      }
      if (context.serviceWorkers().length === 0) {
        // A reloaded worker starts on its first event; an extension page's message is one.
        const wake = await context.newPage();
        try {
          await wake.goto(`chrome-extension://${extensionId}/${manifest.side_panel.default_path}`);
          await wake.evaluate(() => chrome.runtime.sendMessage({ type: '__e2e_wake' }).catch(() => {}));
        } finally {
          await wake.close();
        }
      }
      worker = env.worker = await waitFor(() => context.serviceWorkers()[0], { message: 'the reloaded service worker', timeout: 15_000 });
      return worker;
    },

    /** Pages of the whole browser, including the ones the extension created (through the debugging connection). */
    async allPages() {
      if (!cdpBrowser) cdpBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
      return cdpBrowser.contexts().flatMap((c) => c.pages());
    },

    async close() {
      await cdpBrowser?.close().catch(() => {});
      await context.close().catch(() => {});
      await new Promise((resolve) => server.close(resolve));
      // Only the directory this launch created is removed.
      if (tmp.startsWith(path.join(os.tmpdir(), 'bwe2e-'))) rmSync(tmp, { recursive: true, force: true });
    },
  };
  return env;
}
