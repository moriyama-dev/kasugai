import { randomUUID } from 'node:crypto';
import * as net from 'node:net';
import fse from '@zokugun/fs-extra-plus/sync';
import { vol } from 'memfs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RemoteSSHResolver, getRemoteAuthority } from './rewires/remote';
import { Log } from './mocks/logger';
import * as vscode from './mocks/vscode';
import { runDocker } from './utils/run-docker';
import { getMappedPort } from './utils/get-mapped-port';
import { waitForSSHReady } from './utils/wait-for-ssh-ready';
import { sleep } from './utils/sleep';

/*
 * Kasugai's core promise: when the SSH session drops while a window is open,
 * the connection comes back by itself and leads to the *same* remote server,
 * so the editor can resume its session instead of starting over.
 */

const SERVER_SETUP = fse.readFile('./src/scripts/server-setup.sh', 'utf8').value!;

const PRODUCT_JSON = JSON.stringify({
  nameShort: 'VSCodium',
  nameLong: 'VSCodium',
  applicationName: 'codium',
  quality: 'stable',
  commit: '4c0b0c6cc561d2d3636d1ec250935431876ce4dc',
  version: '1.126.04524',
  serverApplicationName: 'codium-server',
  serverDataFolderName: '.vscodium-server',
  serverDownloadUrlTemplate: 'https://github.com/VSCodium/vscodium/releases/download/1.126.04524/vscodium-reh-${os}-${arch}-1.126.04524.tar.gz',
});

const IMAGE = 'local-ubuntu-bash';
const USERNAME = 'openremotessh';
const PASSWORD = 'openremotessh';

const containerName = `kasugai-reconnect-test-${randomUUID()}`;

let hostPort: number;

/** Send a bare HTTP request through the local tunnel and return the status line. */
function probeServer(port: number, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no answer from the tunnel within ${timeoutMs}ms`));
    }, timeoutMs);
    socket.on('connect', () => socket.write('GET /version HTTP/1.0\r\nHost: localhost\r\n\r\n'));
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\r\n')) {
        clearTimeout(timer);
        socket.destroy();
        resolve(data.split('\r\n')[0]);
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (!data) {
        reject(new Error('tunnel closed without an answer'));
      }
    });
  });
}

async function waitFor(check: () => boolean, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('reconnect', () => {
  let logger: Log;
  let resolver: InstanceType<typeof RemoteSSHResolver>;
  let localPort: number;
  let token: string | undefined;
  let extContext: InstanceType<typeof vscode.ExtensionContext>;

  beforeAll(async () => {
    vol.reset();
    runDocker(['rm', '-f', containerName], true);
    runDocker([
      'run', '--detach', '--rm', '--name', containerName, '--publish', '2222',
      '--env', `USER_NAME=${USERNAME}`, '--env', `USER_PASSWORD=${PASSWORD}`,
      '--env', 'PASSWORD_ACCESS=true', '--env', 'SUDO_ACCESS=false', '--env', 'LOG_STDOUT=true',
      IMAGE,
    ]);
    hostPort = getMappedPort(containerName);
    await waitForSSHReady(USERNAME, PASSWORD, hostPort, 60_000, containerName);

    vol.fromJSON({
      '/etc/ssh/ssh_config': [
        'Host test',
        '  HostName 127.0.0.1',
        `  Port ${hostPort}`,
        `  User ${USERNAME}`,
      ].join('\n'),
      '/bin/vscodium/app/product.json': PRODUCT_JSON,
      '/data/vscodium/extensions/open-remote-ssh/src/scripts/server-setup.sh': SERVER_SETUP,
    });
    vscode.window.setPassword(PASSWORD);
    // Detect a black-holed link within ~3 s and keep each attempt short
    vscode.workspace.setConfiguration('keepAliveInterval', 1);
    vscode.workspace.setConfiguration('keepAliveCountMax', 2);
    vscode.workspace.setConfiguration('connectTimeout', 5);

    logger = new Log('Kasugai');
    logger.capture();
    extContext = new vscode.ExtensionContext();
    resolver = new RemoteSSHResolver(extContext, logger);

    const result = await resolver.resolve(getRemoteAuthority('test'), new vscode.RemoteAuthorityResolverContext());
    localPort = result.port;
    token = result.connectionToken;
  }, 180_000);

  afterAll(() => {
    resolver?.dispose();
    runDocker(['unpause', containerName], true);
    runDocker(['rm', '-f', containerName], true);
    vscode.workspace.resetConfiguration();
  });

  it('reaches the remote server through the tunnel', async () => {
    expect(await probeServer(localPort)).toMatch(/^HTTP\/1\.[01] \d{3}/);
  }, 30_000);

  it('comes back by itself after the SSH session is killed', async () => {
    runDocker(['exec', containerName, 'pkill', '-KILL', '-f', `sshd: ${USERNAME}`]);

    await waitFor(() => logger.messages().includes('Reconnected to test'), 30_000, 'the reconnect');

    // Same local port, same remote server
    expect(await probeServer(localPort)).toMatch(/^HTTP\/1\.[01] \d{3}/);
  }, 60_000);

  it('comes back by itself after the link goes silent', async () => {
    const before = (logger.messages().match(/Reconnected to test/g) ?? []).length;

    // A paused container answers nothing: only keepalives can notice
    runDocker(['pause', containerName]);
    await waitFor(() => logger.messages().includes('SSH connection to test dropped'), 20_000, 'the drop to be detected');
    await sleep(3_000);
    runDocker(['unpause', containerName]);

    await waitFor(() => (logger.messages().match(/Reconnected to test/g) ?? []).length > before, 60_000, 'the reconnect');
    expect(await probeServer(localPort)).toMatch(/^HTTP\/1\.[01] \d{3}/);
  }, 120_000);

  it('reuses the session and the running server when resolved again', async () => {
    const context = new vscode.RemoteAuthorityResolverContext();
    context.resolveAttempt = 2;
    const started = Date.now();
    const result = await resolver.resolve(getRemoteAuthority('test'), context);

    expect(logger.messages()).toContain('Reusing the open SSH connection to test');
    expect(logger.messages()).toContain('Using remembered platform: linux');
    // The token is only regenerated when a new server process is started
    expect(result.connectionToken).toBe(token);
    expect(await probeServer(result.port)).toMatch(/^HTTP\/1\.[01] \d{3}/);
    console.log(`re-resolve took ${Date.now() - started}ms`);
  }, 60_000);

  it('detects the platform again when the remembered one is stale', async () => {
    await extContext.globalState.update('kasugai.platform.test', { detectedPlatform: 'linux', detectedArch: 's390x', detectedShell: 'bash' });
    const fresh = new RemoteSSHResolver(extContext, logger);
    try {
      const result = await fresh.resolve(getRemoteAuthority('test'), new vscode.RemoteAuthorityResolverContext());
      expect(logger.messages()).toContain('The remembered platform of this host is out of date');
      expect(result.connectionToken).toBe(token);
      expect(extContext.globalState.get<{ detectedArch: string }>('kasugai.platform.test')?.detectedArch).not.toBe('s390x');
    } finally {
      fresh.dispose();
    }
  }, 60_000);
});
