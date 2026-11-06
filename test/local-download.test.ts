import { randomUUID } from 'node:crypto';
import fse from '@zokugun/fs-extra-plus/sync';
import { vol } from 'memfs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { RemoteSSHResolver, getRemoteAuthority } from './rewires/remote';
import { Log } from './mocks/logger';
import * as vscode from './mocks/vscode';
import { runDocker } from './utils/run-docker';
import { getMappedPort } from './utils/get-mapped-port';
import { waitForSSHReady } from './utils/wait-for-ssh-ready';

/*
 * Hosts without internet access: Kasugai downloads the server on the client
 * and uploads it over the SSH session.
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
const containerName = `kasugai-local-download-test-${randomUUID()}`;

let hostPort: number;

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
}, 120_000);

afterAll(() => {
  runDocker(['rm', '-f', containerName], true);
  vscode.workspace.resetConfiguration();
});

it('installs the server from an archive uploaded by the client', async () => {
  vol.fromJSON({
    '/etc/ssh/ssh_config': ['Host test', '  HostName 127.0.0.1', `  Port ${hostPort}`, `  User ${USERNAME}`].join('\n'),
    '/bin/vscodium/app/product.json': PRODUCT_JSON,
    '/data/vscodium/extensions/open-remote-ssh/src/scripts/server-setup.sh': SERVER_SETUP,
  });
  vscode.window.setPassword(PASSWORD);
  vscode.workspace.setConfiguration('localServerDownload', 'always');

  const logger = new Log('Kasugai');
  logger.capture();
  const resolver = new RemoteSSHResolver(new vscode.ExtensionContext(), logger);
  try {
    const result = await resolver.resolve(getRemoteAuthority('test'), new vscode.RemoteAuthorityResolverContext());
    expect(result.host).toBe('127.0.0.1');

    const messages = logger.messages();
    expect(messages).toContain('downloading it locally');
    expect(messages).toContain('Uploaded the server archive');
    expect(messages).toContain('Using the server archive uploaded by the client');

    // Nothing left behind on the host
    const leftovers = runDocker(['exec', containerName, 'sh', '-c', `ls -a /home/${USERNAME}/.vscodium-server/ /config/.vscodium-server/ 2>/dev/null | grep kasugai-upload || true`]);
    expect(leftovers).toBe('');
  } finally {
    resolver.dispose();
  }
}, 300_000);
