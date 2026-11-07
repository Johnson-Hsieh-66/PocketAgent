import { loadConfig } from './config.js';
import { Store } from './store.js';

const args = process.argv.slice(2);
const [command, value] = args;
const valid = (args.length === 1 && ['pair', 'devices'].includes(command)) ||
  (args.length === 2 && command === 'revoke' && !!value.trim()) ||
  (args.length === 2 && command === 'pairing' && ['on', 'off', 'status'].includes(value));

// Reject invalid or extra arguments before configuration/database creation or mutation.
if (!valid) {
  console.error('Usage: npm run pair | npm run devices | npm run revoke -- <device-id|all> | npm run pairing -- <on|off|status>');
  process.exitCode = 1;
} else {
  let store: Store | undefined;
  try {
    const config = loadConfig();
    store = new Store(config.dataDir);
    if (command === 'pair') {
      const pair = store.issuePairCode();
      console.log(`Pairing code: ${pair.code}\nExpires: ${new Date(pair.expiresAt).toISOString()}\nUse once in your PocketAgent browser. Do not share this code.`);
    } else if (command === 'devices') {
      const devices = store.devices();
      if (!devices.length) console.log('No paired devices.');
      else for (const device of devices) console.log(`${device.id}\t${device.name}\t${new Date(device.expiresAt).toISOString()}`);
    } else if (command === 'revoke') {
      store.revoke(value);
      console.log('Device access revoked.');
    } else if (command === 'pairing') {
      if (value !== 'status') store.setPairingRequired(value === 'on');
      const required = store.pairingRequired();
      console.log(`Device pairing: ${required ? 'ON' : 'OFF'}.`);
      if (value !== 'status') console.log(required
        ? 'Unpaired clients must pair. Existing device records are retained. No restart is required.'
        : 'Private-network clients can operate Codex without pairing. Existing device records are retained. No restart is required.');
    }
  } catch {
    console.error('MANAGEMENT_COMMAND_FAILED');
    process.exitCode = 1;
  } finally { store?.close(); }
}
