import * as vscode from 'vscode';

/** Settings section owned by Kasugai. */
export const CONFIG_SECTION = 'kasugai';

/**
 * Settings section of the original "Remote - SSH" style extensions. Users
 * switching to Kasugai often already have these configured, so a value set
 * there is honoured whenever the matching `kasugai.*` setting is left unset.
 */
export const LEGACY_CONFIG_SECTION = 'remote.SSH';

function isExplicitlySet(config: vscode.WorkspaceConfiguration, key: string): boolean {
    if (typeof config.inspect !== 'function') {
        return false;
    }
    const info = config.inspect(key);
    return !!info && (info.globalValue !== undefined || info.workspaceValue !== undefined || info.workspaceFolderValue !== undefined);
}

/**
 * Read a Kasugai setting, falling back to the legacy `remote.SSH.*` value when
 * the user only configured that one.
 */
export function getSetting<T>(key: string, defaultValue: T): T {
    const own = vscode.workspace.getConfiguration(CONFIG_SECTION);
    if (!isExplicitlySet(own, key)) {
        const legacy = vscode.workspace.getConfiguration(LEGACY_CONFIG_SECTION);
        if (isExplicitlySet(legacy, key)) {
            return legacy.get<T>(key, defaultValue);
        }
    }
    return own.get<T>(key, defaultValue);
}

/** Whether a configuration change touches `key` in either section. */
export function affectsSetting(e: vscode.ConfigurationChangeEvent, key: string): boolean {
    return e.affectsConfiguration(`${CONFIG_SECTION}.${key}`) || e.affectsConfiguration(`${LEGACY_CONFIG_SECTION}.${key}`);
}
