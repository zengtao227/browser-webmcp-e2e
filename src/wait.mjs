// Waits by observing state, never by sleeping for a fixed time.
export async function waitFor(check, { timeout = 10_000, interval = 100, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Timed out after ${timeout} ms waiting for ${message}.`);
}
