import type { ServerValidation, ServerVersion } from './server-config/types';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Log } from './common/logger';
import type { SSHClient } from './ssh/sshClient';
import { getServerConfig } from './server-config/get-server-config';
import { fetchRelease, IRelease } from './fetchRelease';
import { sanitizeExtensionIds } from './utils/sanitize-extension-ids';
import { RemotePlatform } from './types';

/**
 * Reads a script template from <extensionPath>/scripts/<templateName> and
 * replaces every %%KEY%% occurrence with the matching value from `variables`.
 */
function compileTemplate(templateName: string, variables: Record<string, string>, extensionPath: string): string {
    const templatePath = path.join(extensionPath, 'src', 'scripts', templateName);
    let content = fs.readFileSync(templatePath, 'utf8');
    for (const [key, value] of Object.entries(variables)) {
        content = content.replace(new RegExp(`%%${key}%%`, 'g'), value);
    }
    return content;
}

/**
 * Matches a hostname against a pattern that may contain wildcards.
 * Returns a specificity score: higher scores indicate more specific matches.
 * Returns -1 if no match.
 */
function matchHostnamePattern(hostname: string, pattern: string): number {
    // Exact match has highest priority
    if (hostname === pattern) {
        return 1000;
    }

    // Catch-all wildcard has lowest priority
    if (pattern === '*') {
        return 1;
    }

    // Convert wildcard pattern to regex
    // Escape special regex characters except *
    const regexPattern = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');

    const regex = new RegExp(`^${regexPattern}$`);

    if (regex.test(hostname)) {
        // Calculate specificity based on the number of non-wildcard characters
        // More specific patterns (more characters) get higher scores
        const nonWildcardChars = pattern.replace(/\*/g, '').length;
        return 10 + nonWildcardChars;
    }

    return -1;
}

/**
 * Finds the best matching path for a hostname from a map of patterns to paths.
 * Supports wildcards with priority: exact match > specific wildcard > general wildcard.
 */
export function findServerInstallPath(hostname: string, pathMap: Record<string, string>): string | undefined {
    let bestMatch: { pattern: string; path: string; score: number } | undefined;

    for (const [pattern, path] of Object.entries(pathMap)) {
        const score = matchHostnamePattern(hostname, pattern);

        if (score > 0) {
            if (!bestMatch || score > bestMatch.score) {
                bestMatch = { pattern, path, score };
            }
        }
    }

    return bestMatch?.path;
}

export type ServerInstallOptions = {
    id: string;
    quality: string;
    commit: string;
    version: string;
    release?: string;
    extensionIds: string[];
    envVariables: string[];
    sendEnvVars: Record<string, string>;
    useSocketPath: boolean;
    serverApplicationName: string;
    serverDataFolderName: string;
    serverDownloadUrlTemplate: string;
    customInstallPath?: string;
    serverValidation: ServerValidation;
    serverPlatform: Platform;
    serverArch: Architecture;
    /** The platform comes from the per-host cache and must be re-checked remotely. */
    verifyPlatform?: boolean;
    localArchiveMode?: LocalArchiveMode;
};

/** See LOCAL_ARCHIVE_MODE in server-setup.sh. */
export type LocalArchiveMode = '' | 'skip-remote-download' | 'use-upload';

/** `kasugai.localServerDownload` */
export type LocalServerDownload = 'auto' | 'always' | 'off';

/**
 * Client-side download used when the remote host cannot fetch the server
 * itself (no internet access, blocked by a proxy, no curl/wget).
 */
export interface LocalServerTransfer {
    mode: LocalServerDownload;
    /** Download `url` on this machine (cached) and return the local file path. */
    download(url: string): Promise<string>;
    /** Copy a local file to `remotePath` (a POSIX path, `$HOME` allowed) on the host. */
    upload(localPath: string, remotePath: string): Promise<void>;
}

/** Exit code of the install script asking for a client-side download. */
const EXIT_NEEDS_UPLOAD = 4;

export type ServerInstallResult = {
    exitCode: number;
    listeningOn: number | string;
    connectionToken: string;
    logFile: string;
    osReleaseId: string;
    arch: string;
    platform: string;
    tmpDir: string;
    [key: string]: unknown;
};

export class ServerInstallError extends Error {
    constructor(message: string) {
        super(message);
    }
}

const DEFAULT_DOWNLOAD_URL_TEMPLATE = 'https://github.com/VSCodium/vscodium/releases/download/${version}.${release}/vscodium-reh-${os}-${arch}-${version}.${release}.tar.gz';

export type Platform = 'alpine' | 'darwin' | 'dragonfly' | 'freebsd' | 'linux' | 'windows';
export type Architecture = 'arm64' | 'armhf' | 'loong64' | 'ppc64le' | 'riscv64' | 's390x' | 'x64';
export type Shell = 'cmd' | 'powershell' | 'bash';

/** Exit code of the install script when a remembered platform is stale. */
const EXIT_PLATFORM_MISMATCH = 3;

/** Remembers the detected platform of each host between connections. */
export interface PlatformCache {
    get(): DetectedPlatform | undefined;
    set(value: DetectedPlatform | undefined): void | Thenable<void>;
}

export type DetectedPlatform = {
    detectedPlatform: Platform;
    detectedArch: Architecture;
    detectedShell: Shell;
};

export function parseKernelName(stdout: string): Platform {
    if(/MINGW|MSYS|CYGWIN/i.test(stdout)) {
        return 'windows';
    }

    switch (stdout) {
        case 'Darwin':
            return 'darwin';
        case 'Linux':
            return 'linux';
        case 'FreeBSD':
            return 'freebsd';
        case 'DragonFly':
            return 'dragonfly';
        default:
            throw new ServerInstallError(`Platform not supported: ${stdout}`);
    }
}

export function parseMachineArch(stdout: string): Architecture {
    switch (stdout) {
        case 'x86_64':
        case 'amd64':
            return 'x64';
        case 'armv7l':
        case 'armv8l':
            return 'armhf';
        case 'arm64':
        case 'aarch64':
            return 'arm64';
        case 'ppc64le':
            return 'ppc64le';
        case 'riscv64':
            return 'riscv64';
        case 'loongarch64':
            return 'loong64';
        case 's390x':
            return 's390x';
        default:
            throw new ServerInstallError(`Architecture not supported: ${stdout}`);
    }
}

export async function detectPlatform(conn: Pick<SSHClient, 'exec'>, platform: RemotePlatform | undefined, logger: Pick<Log, 'trace'>): Promise<DetectedPlatform> {
    let detectedPlatform: Platform;
    let detectedShell: Shell = 'bash';

    // detect platform and shell for windows
    if (!platform || platform === 'windows') {
        const { stdout } = await conn.exec('echo %COMSPEC%~$PSHOME');
        const [comspec, pshome = ''] = stdout.replace(/\r?\n/g, ' ').trim().split('~');

        if (comspec && comspec !== '%COMSPEC%') {
            detectedPlatform = 'windows';
            detectedShell = 'cmd';
        } else if (pshome) {
            detectedShell = 'powershell';
            detectedPlatform ||= /^[A-Za-z]:\\/.test(pshome) ? 'windows' : 'linux';
        } else if (!platform) {
            const result = await conn.exec('echo "==$(uname -s)=="');
            const uname = /==\s*(.+?)\s*==/.exec(result.stdout);

            if (uname) {
                detectedPlatform = parseKernelName(uname[1].trim());
            } else if (result.stderr) {
                throw new ServerInstallError(`Cannot execute "uname -s", yields: ${result.stderr}`);
            } else {
                throw new ServerInstallError(`Platform not found: ${result.stdout}`);
            }
        } else {
            detectedPlatform = 'windows';
        }
    } else if (platform === 'macos') {
        detectedPlatform = 'darwin';
    } else {
        detectedPlatform = 'linux';
    }

    logger.trace(`Detected platform: ${detectedPlatform}, ${detectedShell}`);

    let detectedArch: Architecture;

    if (detectedPlatform === 'windows') {
        detectedArch = 'x64';
    } else {
        const result = await conn.exec('echo "==$(uname -m)=="');
        const uname = /==\s*(.+?)\s*==/.exec(result.stdout);

        if (uname) {
            detectedArch = parseMachineArch(uname[1].trim());
        } else if (result.stderr) {
            throw new ServerInstallError(`Cannot execute "uname -m", yields: ${result.stderr}`);
        } else {
            throw new ServerInstallError(`Architecture not found: ${result.stdout}`);
        }
    }

    logger.trace(`Detected architecture: ${detectedArch}`);

    return { detectedPlatform, detectedArch, detectedShell };
}

export async function installCodeServer(
    conn: SSHClient,
    serverDownloadUrlTemplate: string | undefined,
    serverVersionSetting: ServerVersion | undefined,
    extensionIds: string[],
    envVariables: string[],
    sendEnvVars: Record<string, string>,
    platform: RemotePlatform | undefined,
    useSocketPath: boolean,
    customInstallPath: string | undefined,
    logger: Log,
    extensionPath: string,
    platformCache?: PlatformCache,
    transfer?: LocalServerTransfer,
    localArchiveMode?: LocalArchiveMode
): Promise<ServerInstallResult> {
    // Only POSIX results are cached: the bash install script can re-check them
    // for free, the Windows paths cannot.
    const cached = platform ? undefined : platformCache?.get();
    const useCache = !!cached && cached.detectedPlatform !== 'windows';
    const detected = useCache ? cached! : await detectPlatform(conn, platform, logger);
    if (useCache) {
        logger.trace(`Using remembered platform: ${detected.detectedPlatform}, ${detected.detectedArch}`);
    }
    const { detectedPlatform, detectedArch, detectedShell: shell } = detected;

    const scriptId = crypto.randomBytes(12).toString('hex');

    const vscodeServerConfig = await getServerConfig();
    const serverVersion = serverVersionSetting || vscodeServerConfig.defaultServerVersion;
    if (!vscodeServerConfig.isVSCodium) {
        logger.trace(`Client is not VSCodium: using the ${serverVersion} VSCodium server release with validation '${vscodeServerConfig.serverValidation}'`);
    }

    // Get the version and release
    const serverDownloadUrlTemplateFinal = serverDownloadUrlTemplate || vscodeServerConfig.serverDownloadUrlTemplate || DEFAULT_DOWNLOAD_URL_TEMPLATE;
    const bestRelease: IRelease = await fetchRelease(serverDownloadUrlTemplateFinal, vscodeServerConfig.version, vscodeServerConfig.release, serverVersion, logger);

    const installOptions: ServerInstallOptions = {
        id: scriptId,
        version: bestRelease.version,
        commit: vscodeServerConfig.commit,
        quality: vscodeServerConfig.quality,
        release: bestRelease.build,
        extensionIds: sanitizeExtensionIds(extensionIds),
        envVariables,
        sendEnvVars,
        useSocketPath,
        serverApplicationName: vscodeServerConfig.serverApplicationName,
        serverDataFolderName: vscodeServerConfig.serverDataFolderName,
        serverDownloadUrlTemplate: serverDownloadUrlTemplateFinal,
        customInstallPath,
        serverValidation: vscodeServerConfig.serverValidation,
        serverPlatform: detectedPlatform,
        serverArch: detectedArch,
        verifyPlatform: useCache,
        localArchiveMode: localArchiveMode ?? (transfer?.mode === 'always' ? 'skip-remote-download' : ''),
    };

    const commandOutput = await runInstallScript(conn, detectedPlatform, shell, installOptions, vscodeServerConfig, scriptId, logger, extensionPath);

    if (useCache && parseServerInstallOutput(commandOutput.stdout, scriptId)?.exitCode === String(EXIT_PLATFORM_MISMATCH)) {
        logger.info('The remembered platform of this host is out of date, detecting it again');
        await platformCache!.set(undefined);
        return installCodeServer(conn, serverDownloadUrlTemplate, serverVersionSetting, extensionIds, envVariables, sendEnvVars, platform, useSocketPath, customInstallPath, logger, extensionPath, platformCache, transfer, localArchiveMode);
    }

    const parsed = parseServerInstallOutput(commandOutput.stdout, scriptId);
    if (parsed?.exitCode === String(EXIT_NEEDS_UPLOAD) && detectedPlatform !== 'windows') {
        if (!transfer || transfer.mode === 'off' || installOptions.localArchiveMode === 'use-upload') {
            logger.trace('Server install command stdout:', commandOutput.stdout);
            throw new ServerInstallError('The remote host could not download the server. Enable "kasugai.localServerDownload" to download it on this machine instead.');
        }

        // The script reports the platform it would download for (e.g. alpine)
        const downloadUrl = expandDownloadUrl(installOptions.serverDownloadUrlTemplate, installOptions, parsed.platform || detectedPlatform);
        logger.info(`The remote host could not download the server; downloading it locally from ${downloadUrl}`);
        const started = Date.now();
        const localPath = await transfer.download(downloadUrl);
        const remotePath = `${bashServerDataDir(installOptions)}/kasugai-upload-${installOptions.commit}.tar.gz`;
        await transfer.upload(localPath, remotePath);
        logger.info(`Uploaded the server archive in ${Date.now() - started}ms`);

        return installCodeServer(conn, serverDownloadUrlTemplate, serverVersionSetting, extensionIds, envVariables, sendEnvVars, platform, useSocketPath, customInstallPath, logger, extensionPath, platformCache, transfer, 'use-upload');
    }

    const result = parseInstallOutput(commandOutput, installOptions, scriptId, envVariables, logger);
    if (!platform && !useCache && platformCache) {
        await platformCache.set(detected);
    }
    return result;
}

async function runInstallScript(
    conn: SSHClient,
    platform: string | undefined,
    shell: string,
    installOptions: ServerInstallOptions,
    vscodeServerConfig: { serverDataFolderName: string; commit: string },
    scriptId: string,
    logger: Log,
    extensionPath: string
): Promise<{ stdout: string; stderr: string }> {
    if (platform === 'windows') {
        const installServerScript = generatePowerShellInstallScript(installOptions, extensionPath);

        logger.trace('Server install command:', installServerScript);

        const installDir = `$HOME\\${vscodeServerConfig.serverDataFolderName}\\install`;
        const installScript = `${installDir}\\${vscodeServerConfig.commit}.ps1`;
        const endRegex = new RegExp(`${scriptId}: end`);

        // investigate if it's possible to use `-EncodedCommand` flag
        // https://devblogs.microsoft.com/powershell/invoking-powershell-with-complex-expressions-using-scriptblocks/
        // eslint-disable-next-line no-useless-assignment
        let command = '';

        if (shell === 'powershell') {
            command = `md -Force ${installDir}; echo @'\n${installServerScript}\n'@ | Set-Content ${installScript}; powershell -ExecutionPolicy ByPass -File "${installScript}"`;
        } else if (shell === 'bash') {
            command = `mkdir -p ${installDir.replace(/\\/g, '/')} && echo '\n${installServerScript.replace(/'/g, '\'"\'"\'')}\n' > ${installScript.replace(/\\/g, '/')} && powershell -ExecutionPolicy ByPass -File "${installScript}"`;
        } else if (shell === 'cmd') {
            const script = installServerScript.trim()
                // remove comments
                .replace(/^#.*$/gm, '')
                // remove empty lines
                .replace(/\n{2,}/gm, '\n')
                // remove leading spaces
                .replace(/^\s*/gm, '')
                // escape double quotes (from powershell/cmd)
                .replace(/"/g, '"""')
                // escape single quotes (from cmd)
                .replace(/'/g, `''`)
                // escape redirect (from cmd)
                .replace(/>/g, `^>`)
                // escape new lines (from powershell/cmd)
                .replace(/\n/g, '\'`n\'');

            command = `powershell "md -Force ${installDir}" && powershell "echo '${script}'" > ${installScript.replace('$HOME', '%USERPROFILE%')} && powershell -ExecutionPolicy ByPass -File "${installScript.replace('$HOME', '%USERPROFILE%')}"`;

            logger.trace('Command length (8191 max):', command.length);

            if (command.length > 8191) {
                throw new ServerInstallError(`Command line too long`);
            }
        } else {
            throw new ServerInstallError(`Not supported shell: ${shell}`);
        }

        return await conn.execPartial(command, (stdout: string) => endRegex.test(stdout));
    } else {
        const installServerScript = generateBashInstallScript(installOptions, extensionPath);

        logger.trace('Server install command:', installServerScript);
        // Use base64 encoding to avoid shell quoting issues across different login shells (bash, csh, tcsh, fish).
        // csh cannot handle multi-line strings inside single quotes with -c, so piping via base64 is the most portable approach.
        const base64Script = Buffer.from(installServerScript).toString('base64');
        return await conn.exec(`echo ${base64Script} | base64 -d | bash -l`);
    }
}

function parseInstallOutput(
    commandOutput: { stdout: string; stderr: string },
    installOptions: ServerInstallOptions,
    scriptId: string,
    envVariables: string[],
    logger: Log
): ServerInstallResult {
    if (commandOutput.stderr) {
        logger.trace('Server install command stderr:', commandOutput.stderr);
    }
    logger.trace('Server install command stdout:', commandOutput.stdout);

    const resultMap = parseServerInstallOutput(commandOutput.stdout, scriptId);
    if (!resultMap) {
        throw new ServerInstallError(`Failed parsing install script output`);
    }

    const exitCode = parseInt(resultMap.exitCode, 10);
    if (exitCode !== 0) {
        throw new ServerInstallError(`Couldn't install vscode server on remote server, install script returned non-zero exit status`);
    }

    const listeningOn = resultMap.listeningOn.match(/^\d+$/)
        ? parseInt(resultMap.listeningOn, 10)
        : resultMap.listeningOn;

    const { serverArch } = installOptions;
    const remoteEnvVars = Object.fromEntries(Object.entries(resultMap).filter(([key,]) => envVariables.includes(key)));

    return {
        exitCode,
        listeningOn,
        connectionToken: resultMap.connectionToken,
        logFile: resultMap.logFile,
        osReleaseId: resultMap.osReleaseId,
        arch: resultMap.arch || serverArch,
        platform: resultMap.platform,
        tmpDir: resultMap.tmpDir,
        ...remoteEnvVars
    };
}

function parseServerInstallOutput(str: string, scriptId: string): { [k: string]: string } | undefined {
    const startResultStr = `${scriptId}: start`;
    const endResultStr = `${scriptId}: end`;

    const startResultIdx = str.indexOf(startResultStr);
    if (startResultIdx < 0) {
        return undefined;
    }

    const endResultIdx = str.indexOf(endResultStr, startResultIdx + startResultStr.length);
    if (endResultIdx < 0) {
        return undefined;
    }

    const installResult = str.substring(startResultIdx + startResultStr.length, endResultIdx);

    const resultMap: { [k: string]: string } = {};
    const resultArr = installResult.split(/\r?\n/);
    for (const line of resultArr) {
        const [key, value] = line.split('==');
        resultMap[key] = value;
    }

    return resultMap;
}

/** Same substitution as the install script performs remotely. */
export function expandDownloadUrl(template: string, options: Pick<ServerInstallOptions, 'quality' | 'version' | 'commit' | 'release' | 'serverArch'>, os: string): string {
    return template
        .replace(/\$\{quality\}/g, options.quality)
        .replace(/\$\{version\}/g, options.version)
        .replace(/\$\{commit\}/g, options.commit)
        .replace(/\$\{os\}/g, os)
        .replace(/\$\{arch\}/g, options.serverArch)
        .replace(/\$\{release\}/g, options.release ?? '');
}

/** SERVER_DATA_DIR of the bash install script, as a shell expression. */
function bashServerDataDir({ customInstallPath, serverDataFolderName }: Pick<ServerInstallOptions, 'customInstallPath' | 'serverDataFolderName'>): string {
    return customInstallPath
        ? customInstallPath.replace(/^~(?=\/|$)/, '$HOME')
        : `$HOME/${serverDataFolderName}`;
}

function generateBashInstallScript({ id, quality, version, commit, release, extensionIds, envVariables, sendEnvVars, useSocketPath, serverApplicationName, serverDataFolderName, serverDownloadUrlTemplate, customInstallPath, serverValidation, serverPlatform, serverArch, verifyPlatform, localArchiveMode }: ServerInstallOptions, extensionPath: string): string {
    const extensions = extensionIds.map(extId => '--install-extension ' + extId).join(' ');
    const serverDataDir = bashServerDataDir({ customInstallPath, serverDataFolderName });
    const listenFlag = useSocketPath
        ? `--socket-path="$TMP_DIR/vscode-server-sock-${crypto.randomUUID()}"`
        : '--port=0';
    const envVarLines = envVariables.map(envVar => `  echo "${envVar}==$${envVar}=="`).join('\n');
    const sendEnvVarLines = Object.entries(sendEnvVars).map(([key, value]) => `export ${key}="${value.replace(/"/g, '\\"')}"`).join('\n');

    return compileTemplate('server-setup.sh', {
        DISTRO_VERSION: version,
        DISTRO_COMMIT: commit,
        DISTRO_QUALITY: quality,
        DISTRO_VSCODIUM_RELEASE: release ?? '',
        SERVER_APP_NAME: serverApplicationName,
        SERVER_INITIAL_EXTENSIONS: extensions,
        SERVER_LISTEN_FLAG: listenFlag,
        SERVER_DATA_DIR: serverDataDir,
        SERVER_DATA_DIR_FLAG: customInstallPath ? '--server-data-dir="$SERVER_DATA_DIR"' : '',
        SERVER_VALIDATION_FLAG: serverValidation === 'skip' ? '--disable-client-validation' : '',
        SERVER_DOWNLOAD_URL_TEMPLATE: serverDownloadUrlTemplate.replace(/\$\{/g, '\\${'),
        SCRIPT_ID: id,
        ENV_VAR_LINES: envVarLines,
        SEND_ENV_VAR_LINES: sendEnvVarLines,
        MODIFY_PRODUCT_JSON: serverValidation === 'force' ? 'true' : 'false',
        SERVER_CONNECTION_TOKEN: crypto.randomUUID(),
        SERVER_PLATFORM: serverPlatform,
        SERVER_ARCH: serverArch,
        VERIFY_PLATFORM: verifyPlatform ? 'true' : 'false',
        LOCAL_ARCHIVE_MODE: localArchiveMode ?? '',
    }, extensionPath);
}

function generatePowerShellInstallScript({ id, quality, version, commit, release, extensionIds, envVariables, sendEnvVars, useSocketPath, serverApplicationName, serverDataFolderName, serverDownloadUrlTemplate, customInstallPath, serverValidation }: ServerInstallOptions, extensionPath: string): string {
    const extensions = extensionIds.map(extId => '--install-extension ' + extId).join(' ');
    const downloadUrl = serverDownloadUrlTemplate
        .replace(/\$\{quality\}/g, quality)
        .replace(/\$\{version\}/g, version)
        .replace(/\$\{commit\}/g, commit)
        .replace(/\$\{os\}/g, 'win32')
        .replace(/\$\{arch\}/g, 'x64')
        .replace(/\$\{release\}/g, release ?? '');
    const serverDataDir = customInstallPath
        ? customInstallPath.replace(/^~(?=[\\/]|$)/, '$(Resolve-Path ~)')
        : `$(Resolve-Path ~)\\${serverDataFolderName}`;
    const listenFlag = useSocketPath
        ? `--socket-path="$TMP_DIR/vscode-server-sock-${crypto.randomUUID()}"`
        : '--port=0';
    const envVarLines = envVariables.map(envVar => `    "$${envVar}==$${envVar}=="`).join('\n');
    const sendEnvVarLines = Object.entries(sendEnvVars).map(([key, value]) => `$env:${key}="${value.replace(/"/g, '`"')}"`).join('\n');

    return compileTemplate('server-setup.ps1', {
        DISTRO_VERSION: version,
        DISTRO_COMMIT: commit,
        DISTRO_QUALITY: quality,
        DISTRO_VSCODIUM_RELEASE: release ?? '',
        SERVER_APP_NAME: serverApplicationName,
        SERVER_INITIAL_EXTENSIONS: extensions,
        SERVER_LISTEN_FLAG: listenFlag,
        SERVER_DATA_DIR: serverDataDir,
        SERVER_DATA_DIR_FLAG: customInstallPath ? '--server-data-dir=""$SERVER_DATA_DIR""' : '',
        SERVER_VALIDATION_FLAG: serverValidation === 'skip' ? '--disable-client-validation' : '',
        SERVER_DOWNLOAD_URL: downloadUrl,
        SCRIPT_ID: id,
        ENV_VAR_LINES: envVarLines,
        SEND_ENV_VAR_LINES: sendEnvVarLines,
        MODIFY_PRODUCT_JSON: serverValidation === 'force' ? '$true' : '$false',
        SERVER_CONNECTION_TOKEN: crypto.randomUUID(),
    }, extensionPath);
}
