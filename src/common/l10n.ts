import * as vscode from 'vscode';

type Translate = (message: string, ...args: (string | number | boolean)[]) => string;

/**
 * Translate a user-facing message through the editor's localization bundle
 * (`l10n/bundle.l10n.<locale>.json`). `vscode.l10n` only exists from 1.73, so
 * older editors get the English text with the placeholders filled in.
 */
export function t(message: string, ...args: (string | number | boolean)[]): string {
    const l10n = (vscode as { l10n?: { t?: Translate } }).l10n;
    if (typeof l10n?.t === 'function') {
        return l10n.t(message, ...args);
    }
    return message.replace(/\{(\d+)\}/g, (match, index: string) => {
        const value = args[Number(index)];
        return value === undefined ? match : String(value);
    });
}
