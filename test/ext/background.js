// Records who sent each message, so the test can tell a real Side Panel (no tab) from a panel page opened as a tab.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'hello') {
    chrome.storage.session.set({ lastHello: { hasTab: Boolean(sender.tab), url: sender.url } }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === 'native') {
    chrome.runtime.sendNativeMessage(message.host, { version: 1, id: 'self-test', control: 'status', arguments: {} })
      .then((reply) => sendResponse({ ok: true, reply }), (error) => sendResponse({ ok: false, error: String(error.message) }));
    return true;
  }
  return false;
});
