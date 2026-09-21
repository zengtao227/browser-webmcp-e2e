chrome.runtime.sendMessage({ type: 'hello' }).then(() => { document.getElementById('state').textContent = 'hello sent'; });
