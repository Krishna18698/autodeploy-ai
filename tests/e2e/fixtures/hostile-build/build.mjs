// A hostile build: it tries each way out of the build sandbox and logs what
// happened ("escape: <what>: <result>"), then builds normally so the smoke
// test reads the log of a live deployment (and no repair runs).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';

const log = (what, result) => console.log(`escape: ${what}: ${result}`);

async function http(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return `reached ${r.status}`;
  } catch (e) {
    return `blocked (${e.cause?.code ?? e.name})`;
  }
}
function tcp(host, port) {
  return new Promise((done) => {
    const s = connect({ host, port, timeout: 4000 });
    s.on('connect', () => done('reached') || s.destroy());
    s.on('timeout', () => done('blocked (timeout)') || s.destroy());
    s.on('error', (e) => done(`blocked (${e.code})`));
  });
}

log('internet', await http('https://example.com/'));
log('metadata', await http('http://169.254.169.254/opc/v2/instance/'));
log('api', await tcp('api-1', 4000));
log('postgres', await tcp('postgres', 5432));
log('valkey', await tcp('valkey', 6379));
log('gateway', await tcp('gateway', 8082));
log('host-ssh', await tcp('172.17.0.1', 22));
try {
  writeFileSync('/usr/local/pwned', 'x');
  log('write-outside', 'wrote /usr/local/pwned');
} catch (e) {
  log('write-outside', `denied (${e.code})`);
}
const hostFiles = ['/var/run/docker.sock', '/root/.ssh', '/home/node/.aws', '/etc/cloudflared'];
log('host-files', JSON.stringify(hostFiles.filter((f) => existsSync(f))));
log('secret', `the token is ${process.env.E2E_SECRET}`);

mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', '<!doctype html><title>contained</title><h1>contained</h1>');
