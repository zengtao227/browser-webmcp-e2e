import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// An unpacked extension with a manifest `key` has a fixed id: the first 128 bits of the SHA-256 of
// the public key, written with the letters a-p. The harness needs it before the browser starts, to
// register the harmless native host for exactly that extension.
export function extensionIdFromManifest(extensionPath) {
  const manifest = JSON.parse(readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8'));
  if (typeof manifest.key !== 'string') throw new Error('The extension manifest needs a "key" so its id is fixed.');
  const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  return [...digest].map((nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16))).join('');
}
