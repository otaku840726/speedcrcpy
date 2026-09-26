export interface DeviceFileItem {
  name: string;
  path: string;
  isDir: boolean;
  isFile: boolean;
  isLink: boolean;
  size: number;
  mtime: number;
  extension?: string;
  linkTarget?: string;
}

export interface DeviceFileListResponse {
  currentPath: string;
  parentPath: string | null;
  items: DeviceFileItem[];
}

export interface DeviceAppInfo {
  packageName: string;
  name?: string;
  versionName?: string;
  apkPath?: string;
  isSystem: boolean;
  isForeground: boolean;
  hasIcon?: boolean;
}

export interface DeviceAppsResponse {
  apps: DeviceAppInfo[];
  foreground?: string;
}

export interface InstallApkResult {
  ok: boolean;
  packageName?: string;
  output?: string;
  error?: string;
}
