# browser-webmcp-e2e

A small end-to-end harness for browser extensions in the Browser WebMCP family (DeepSeek WebMCP today; the ChatGPT Embedded Panel, Prism and others can use it). It starts a real Chromium with the unpacked extension, opens the **real Side Panel**, serves the pages the tests need from a local HTTPS server, and keeps the test browser away from the network and from your real native-messaging host.

It is deliberately small: launcher, side-panel connection, local fixtures, guards, cleanup. Mock provider pages, real-DOM samples and scenarios stay in each project's own `e2e/` directory. There is no plugin system, scenario DSL or test platform here.

## Use

```js
import { launchExtension } from 'browser-webmcp-e2e';

const env = await launchExtension({
  extensionPath: '/path/to/extension',            // manifest.json needs a "key" (fixed id)
  hosts: { 'chat.deepseek.com': (req, res) => {/* serve the project's mock page */} },
  nativeHostNames: ['com.example.native'],        // harmless fake host under these names, in the temp profile only
});
const work = await env.openPage(env.fixtureUrl('/form'));   // fixture.test / mail.test: /form /mail /popup /second
const panel = await env.openSidePanel(work);                // the extension's real Side Panel
// env.context (Playwright), env.worker, env.requests, env.allPages(), await env.close()
```

Projects depend on it as a dev dependency (`file:../browser-webmcp-e2e` while developing; a tagged GitHub dependency once stable).

## One-time browser install

```sh
npm run install-browser        # PLAYWRIGHT_SKIP_BROWSER_GC=1 playwright-core install chromium
```

`playwright-core` is pinned to one exact version together with its matching Chromium build. `PLAYWRIGHT_SKIP_BROWSER_GC=1` matters: without it, Playwright deletes cached browser builds that other projects still use. Extensions need Playwright's Chromium in a persistent context; branded Chrome/Edge no longer accept command-line side-loading. macOS is the tested platform.

## What is guaranteed, and what is not

Measured by `npm test` (the self-test drives a tiny extension in `test/ext/`):

- Mocked and fixture hostnames map to the local server, **including windows created by the extension itself** (a Playwright `route` did not cover those; the first spike hit the real site).
- Every other hostname is unresolvable, and a dead proxy catches everything else. For the probe set (unmapped host, unroutable IP literal, another loopback port, `localhost` on another port) nothing left the test server, and the log of what the server received is in `env.requests`. **This is not a firewall**: host rules and a dead proxy are not a sandbox, WebRTC/UDP and similar were not tested, and it is only claimed for the trusted mock and fixture pages the tests serve.
- Native messaging: before launch the system-level host directories are **read** (never a host called); a real host with a guarded name there, or a directory that cannot be read, stops the run. The guarded names are then registered in the profile's own `NativeMessagingHosts/` to a harmless fake host, which answers instead of anything else.
- The real Side Panel is opened from a trusted click on an extension page and reached over a loopback debugging connection (`--remote-debugging-port`, a free port, this browser only). Its messages have no `sender.tab`; a panel page opened as an ordinary tab does, and the extension may reject it.
- Everything is removed on `close()`: the temporary profile, certificate and server.

Not covered: a real service-worker restart (`chrome.runtime.reload()` unloads a flag-loaded extension), real DeepSeek/ChatGPT sites, macOS window occlusion and dialogs, the toolbar-icon click itself.

## Requirements

Node 22+, `openssl` on the PATH (a short-lived test certificate is generated per run), Chromium from the install step.
