// A harmless native-messaging host: answers every request with a marker and touches nothing.
// Registered by the harness under the real host's name inside the test profile only.
let pending = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
    const length = pending.readUInt32LE(0);
    const message = JSON.parse(pending.subarray(4, 4 + length).toString('utf8'));
    pending = pending.subarray(4 + length);
    const reply = Buffer.from(JSON.stringify({ version: 1, id: message.id, ok: true, result: { marker: 'E2E_FAKE_HOST' } }));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(reply.length, 0);
    process.stdout.write(Buffer.concat([head, reply]));
  }
});
