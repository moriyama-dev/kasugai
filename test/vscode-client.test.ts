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
 * A client that is not VSCodium (VS Code, Code - OSS): Kasugai installs the
 * closest VSCodium server into its own folder and aligns the commit.
 */

const SERVER_SETUP = fse.readFile('./src/scripts/server-setup.sh', 'utf8').value!;

// Shaped like VS Code's product.json: no server download template
const PRODUCT_JSON = JSON.stringify({
  nameShort: 'Code',
  nameLong: 'Visual Studio Code',
  applicationName: 'code',
  quality: 'stable',
  commit: '0123456789abcdef0123456789abcdef01234567',
  serverApplicationName: 'code-server',
  serverDataFolderName: '.vscode-server',
});

const IMAGE = 'local-ubuntu-bash';
const USERNAME = 'openremotessh';
const PASSWORD = 'openremotessh';
const containerName = `kasugai-vscode-client-test-${randomUUID()}`;

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
  vscode.setVersion('1.126.04524');
});

it('runs the closest VSCodium server for a VS Code client, in its own folder', async () => {
  vol.fromJSON({
    '/etc/ssh/ssh_config': ['Host test', '  HostName 127.0.0.1', `  Port ${hostPort}`, `  User ${USERNAME}`].join('\n'),
    '/bin/vscodium/app/product.json': PRODUCT_JSON,
    '/data/vscodium/extensions/open-remote-ssh/src/scripts/server-setup.sh': SERVER_SETUP,
  });
  vscode.window.setPassword(PASSWORD);
  vscode.setVersion('1.126.0');

  const logger = new Log('Kasugai');
  logger.capture();
  const resolver = new RemoteSSHResolver(new vscode.ExtensionContext(), logger);
  try {
    const result = await resolver.resolve(getRemoteAuthority('test'), new vscode.RemoteAuthorityResolverContext());
    expect(result.host).toBe('127.0.0.1');
    expect(logger.messages()).toContain('Client is not VSCodium');

    const home = runDocker(['exec', '-u', USERNAME, containerName, 'sh', '-c', 'echo $HOME']);
    const listing = runDocker(['exec', containerName, 'sh', '-c', `ls -a ${home}`]);
    expect(listing).toContain('.kasugai-server');
    expect(listing).not.toContain('.vscode-server');
  } finally {
    resolver.dispose();
  }
}, 300_000);
