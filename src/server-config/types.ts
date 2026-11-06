export type ServerVersion = 'closest' | 'latest' | 'match' | string;
export type ServerValidation = 'force' | 'skip' | 'strict';

export type IServerConfig = {
    version: string;
    commit: string;
    quality: string;
    release: string;
    serverApplicationName: string;
    serverDataFolderName: string;
    serverDownloadUrlTemplate?: string;
    serverValidation: ServerValidation;
    /** Server version to use when `kasugai.serverVersion` is not set. */
    defaultServerVersion: ServerVersion;
    /** The client is VSCodium itself, so its own server release can be used as is. */
    isVSCodium: boolean;
};
