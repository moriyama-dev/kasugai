import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { getProductJson } from './server-config/get-product-json';
import type { Log } from './common/logger';

const ARGV_KEY = 'enable-proposed-api';

/**
 * Remote connections rely on a proposed editor API. VSCodium and VS Code only
 * grant it to extensions listed under `enable-proposed-api` in argv.json, so
 * Kasugai offers to add itself there the first time it is missing.
 */
export async function offerProposedApiSetup(extensionId: string, logger: Log) {
    const enable = 'Enable Kasugai';
    const howTo = 'Show Me How';
    const answer = await vscode.window.showWarningMessage(
        'Kasugai needs a one-time permission to open SSH remote windows. Add it to this editor\'s runtime arguments (argv.json)? A restart of the editor is needed afterwards.',
        enable,
        howTo
    );

    if (answer === enable) {
        try {
            const file = await argvJsonPath();
            await addToArgvJson(file, extensionId);
            logger.info(`Added ${extensionId} to ${ARGV_KEY} in ${file}`);
            void vscode.window.showInformationMessage(`Kasugai was added to ${file}. Quit and restart the editor to finish (reloading the window is not enough).`);
        } catch (e) {
            logger.error('Could not update argv.json', e);
            await showManualSetup(extensionId);
        }
    } else if (answer === howTo) {
        await showManualSetup(extensionId);
    }
}

async function showManualSetup(extensionId: string) {
    await vscode.env.clipboard.writeText(`"${ARGV_KEY}": ["${extensionId}"]`);
    void vscode.window.showInformationMessage(`Add "${ARGV_KEY}": ["${extensionId}"] to the file that opens now (copied to the clipboard), save it and restart the editor.`);
    await vscode.commands.executeCommand('workbench.action.configureRuntimeArguments');
}

async function argvJsonPath(): Promise<string> {
    const product = await getProductJson();
    const dataFolderName = typeof product.dataFolderName === 'string' ? product.dataFolderName : '.vscode-oss';
    const portable = process.env['VSCODE_PORTABLE'];
    return portable ? path.join(portable, 'argv.json') : path.join(os.homedir(), dataFolderName, 'argv.json');
}

/** Add the extension to `enable-proposed-api`, keeping comments and formatting. */
export async function addToArgvJson(file: string, extensionId: string) {
    let text = '{\n}\n';
    try {
        text = await fs.promises.readFile(file, 'utf8');
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw e;
        }
    }

    const current = (parse(text) ?? {}) as Record<string, unknown>;
    const list = Array.isArray(current[ARGV_KEY]) ? current[ARGV_KEY] as unknown[] : [];
    if (list.some(id => typeof id === 'string' && id.toLowerCase() === extensionId.toLowerCase())) {
        return;
    }

    const edits = modify(text, [ARGV_KEY], [...list, extensionId], { formattingOptions: { insertSpaces: true, tabSize: 4 } });
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, applyEdits(text, edits), 'utf8');
}
