import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR, ROOT } from '../server/config.ts';

const LABEL = 'dev.docket';
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const DOMAIN = `gui/${process.getuid!()}`;
const LOG = join(DATA_DIR, 'server.log');

const launchctl = (...args: string[]) => execFileSync('/bin/launchctl', args, { stdio: 'inherit' });

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${join(ROOT, 'server', 'main.ts')}</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
`;

function uninstall() {
  try {
    launchctl('bootout', `${DOMAIN}/${LABEL}`);
  } catch {
    // not loaded
  }
  rmSync(PLIST, { force: true });
}

switch (process.argv[2]) {
  case 'install':
    uninstall();
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(PLIST, plist);
    launchctl('bootstrap', DOMAIN, PLIST);
    console.log(`installed ${PLIST}\nnode: ${process.execPath}\nlog: ${LOG}`);
    break;
  case 'uninstall':
    uninstall();
    console.log('uninstalled');
    break;
  case 'restart':
    launchctl('kickstart', '-k', `${DOMAIN}/${LABEL}`);
    break;
  default:
    console.error('usage: service.ts install | uninstall | restart');
    process.exit(1);
}
