import { readdirSync } from 'node:fs';

// Chromium reads native-messaging host manifests from a user-level directory (inside the profile,
// which the harness owns) and from system-level directories. A manifest is a file named
// `<host name>.json`. Before anything starts, these system directories are read (never a host called):
// a guarded name found there, or a directory that cannot be read for a reason other than "it does not
// exist", stops the run.
export const DEFAULT_SYSTEM_HOST_DIRS = Object.freeze([
  '/Library/Google/Chrome/NativeMessagingHosts',
  '/Library/Application Support/Chromium/NativeMessagingHosts',
  '/Library/Application Support/Google/Chrome/NativeMessagingHosts',
  '/etc/opt/chrome/native-messaging-hosts',
  '/etc/chromium/native-messaging-hosts',
]);

export function assertNativeHostsSafe(guardedNames, dirs = DEFAULT_SYSTEM_HOST_DIRS) {
  for (const dir of dirs) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw new Error(`Cannot confirm that ${dir} holds no real native host (${error?.code ?? error}); stopping without calling anything.`);
    }
    for (const name of guardedNames) {
      if (entries.includes(`${name}.json`)) {
        throw new Error(`A real native host named ${name} is registered in ${dir}; stopping without calling it.`);
      }
    }
  }
}
