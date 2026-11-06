import type { IServerConfig, ServerValidation, ServerVersion } from './types';

import * as vscode from 'vscode';
import { getProductJson } from './get-product-json';
import { getSetting } from '../common/config';

/** VSCodium remote server releases, new (1.99+) naming scheme. */
export const VSCODIUM_DOWNLOAD_URL_TEMPLATE = 'https://github.com/VSCodium/vscodium/releases/download/${version}${release}/vscodium-reh-${os}-${arch}-${version}${release}.tar.gz';

/**
 * Kasugai always runs the VSCodium remote server. VSCodium clients get the
 * matching release. Other clients built from the same sources (VS Code,
 * Code - OSS, ...) get the closest VSCodium release with the commit check
 * relaxed, installed in a folder of its own so it never mixes with servers
 * that other SSH extensions manage in `~/.vscode-server`.
 */
export async function getServerConfig(): Promise<IServerConfig> {
    const productJson = await getProductJson();

    const template = productJson.serverDownloadUrlTemplate as string | undefined;
    const isVSCodium = productJson.nameShort === 'VSCodium' || !!template?.includes('VSCodium/vscodium');

    const customServerBinaryName = getSetting<string>('serverBinaryName', '');
    const serverValidation = getSetting<ServerValidation>('serverValidation', isVSCodium ? 'strict' : 'force');

    return {
        version: vscode.version.replace('-insider',''),
        commit: productJson.commit as string,
        quality: productJson.quality as string,
        release: productJson.release as string || '',
        serverApplicationName: customServerBinaryName || (isVSCodium ? productJson.serverApplicationName as string : 'codium-server'),
        serverDataFolderName: isVSCodium ? productJson.serverDataFolderName as string : '.kasugai-server',
        serverDownloadUrlTemplate: isVSCodium ? template : VSCODIUM_DOWNLOAD_URL_TEMPLATE,
        serverValidation,
        defaultServerVersion: (isVSCodium ? 'match' : 'closest') satisfies ServerVersion,
        isVSCodium,
    };
}
