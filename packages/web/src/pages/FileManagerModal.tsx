import {
  type DeviceAppInfo,
  type DeviceAppsResponse,
  type DeviceFileItem,
  type DeviceFileListResponse,
} from "@speedcrcpy/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import { Icon } from "../core/icons";

interface FileManagerProps {
  serial: string;
  deviceName?: string;
  mode?: "modal" | "drawer";
  initialTab?: "files" | "apps" | "install";
  onClose: () => void;
}

type TabKey = "files" | "apps" | "install";

export function FileManagerModal({
  serial,
  deviceName,
  mode = "modal",
  initialTab = "files",
  onClose,
}: FileManagerProps) {
  const [tab, setTab] = useState<TabKey>(initialTab);

  const content = (
    <div className={`fm-container ${mode === "drawer" ? "drawer-mode" : "modal-mode"}`}>
      <header className="fm-header">
        <div className="fm-title">
          <Icon name="folder" size={18} />
          <span>{deviceName ? `${deviceName} (${serial})` : serial}</span>
          <span className="fm-badge">檔案與 App 管理</span>
        </div>
        <div className="fm-tabs">
          <button
            className={`fm-tab-btn ${tab === "files" ? "active" : ""}`}
            onClick={() => setTab("files")}
          >
            <Icon name="folder" size={14} /> 檔案管理
          </button>
          <button
            className={`fm-tab-btn ${tab === "apps" ? "active" : ""}`}
            onClick={() => setTab("apps")}
          >
            <Icon name="package" size={14} /> 應用程式
          </button>
          <button
            className={`fm-tab-btn ${tab === "install" ? "active" : ""}`}
            onClick={() => setTab("install")}
          >
            <Icon name="upload" size={14} /> 安裝 APK
          </button>
        </div>
        <button className="fm-close-btn" onClick={onClose} title="關閉">
          <Icon name="close" size={16} />
        </button>
      </header>

      <div className="fm-body">
        {tab === "files" && <FilesTab serial={serial} />}
        {tab === "apps" && <AppsTab serial={serial} />}
        {tab === "install" && <InstallApkTab serial={serial} />}
      </div>
    </div>
  );

  if (mode === "drawer") {
    return <div className="fm-drawer-overlay">{content}</div>;
  }

  return (
    <div className="fm-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      {content}
    </div>
  );
}

/* ========================================================================= */
/*                                檔案管理 TAB                                */
/* ========================================================================= */

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatDate(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const PREVIEWABLE_IMAGES = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp", "svg"]);
const PREVIEWABLE_TEXTS = new Set([
  "txt", "log", "json", "xml", "sh", "prop", "conf", "ini", "yaml", "yml", "csv", "md", "js", "ts", "html", "css",
]);

function FilesTab({ serial }: { serial: string }) {
  const [currentPath, setCurrentPath] = useState<string>("/sdcard");
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [items, setItems] = useState<DeviceFileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");

  const [pathInput, setPathInput] = useState<string>("/sdcard");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);

  // Preview State
  const [previewItem, setPreviewItem] = useState<DeviceFileItem | null>(null);
  const [previewContent, setPreviewContent] = useState<{ text?: string; truncated?: boolean; error?: string } | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  // New Folder / Rename modal
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [newDirName, setNewDirName] = useState("");
  const [renameItem, setRenameItem] = useState<DeviceFileItem | null>(null);
  const [renameNewName, setRenameNewName] = useState("");

  async function loadDir(path: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await api<DeviceFileListResponse>(
        `/api/devices/${encodeURIComponent(serial)}/files/list?path=${encodeURIComponent(path)}`,
      );
      setCurrentPath(res.currentPath);
      setPathInput(res.currentPath);
      setParentPath(res.parentPath);
      setItems(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "讀取資料夾失敗");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadDir(currentPath);
  }, [serial]);

  function handlePathSubmit(e: FormEvent) {
    e.preventDefault();
    if (pathInput.trim()) {
      void loadDir(pathInput.trim());
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    setUploadStatus(`準備上傳 ${files.length} 個檔案...`);

    let done = 0;
    for (const file of Array.from(files)) {
      try {
        setUploadStatus(`正在上傳: ${file.name} (${done + 1}/${files.length})...`);
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch(
          `/api/devices/${encodeURIComponent(serial)}/files/upload?path=${encodeURIComponent(currentPath)}`,
          { method: "POST", body: formData },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `上傳失敗 (${res.status})`);
        }
        done++;
      } catch (err) {
        alert(`上傳 ${file.name} 失敗: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    setUploading(false);
    setUploadStatus(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    void loadDir(currentPath);
  }

  async function handleDelete(item: DeviceFileItem) {
    if (!confirm(`確定要刪除「${item.name}」嗎？${item.isDir ? " (此目錄下所有檔案也將一併刪除)" : ""}`)) {
      return;
    }
    try {
      await api(`/api/devices/${encodeURIComponent(serial)}/files/delete`, {
        method: "POST",
        body: JSON.stringify({ path: item.path }),
      });
      void loadDir(currentPath);
    } catch (err) {
      alert(`刪除失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleMakeDir(e: FormEvent) {
    e.preventDefault();
    if (!newDirName.trim()) return;
    const target = currentPath.endsWith("/") ? currentPath + newDirName.trim() : `${currentPath}/${newDirName.trim()}`;
    try {
      await api(`/api/devices/${encodeURIComponent(serial)}/files/mkdir`, {
        method: "POST",
        body: JSON.stringify({ path: target }),
      });
      setMkdirOpen(false);
      setNewDirName("");
      void loadDir(currentPath);
    } catch (err) {
      alert(`建立資料夾失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleRename(e: FormEvent) {
    e.preventDefault();
    if (!renameItem || !renameNewName.trim()) return;
    const dir = currentPath;
    const dest = dir.endsWith("/") ? dir + renameNewName.trim() : `${dir}/${renameNewName.trim()}`;
    try {
      await api(`/api/devices/${encodeURIComponent(serial)}/files/rename`, {
        method: "POST",
        body: JSON.stringify({ src: renameItem.path, dest }),
      });
      setRenameItem(null);
      setRenameNewName("");
      void loadDir(currentPath);
    } catch (err) {
      alert(`重新命名失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function openPreview(item: DeviceFileItem) {
    setPreviewItem(item);
    setPreviewContent(null);

    const ext = item.extension?.toLowerCase() || "";
    if (PREVIEWABLE_IMAGES.has(ext)) {
      // Images preview via direct image URL
      return;
    }

    if (PREVIEWABLE_TEXTS.has(ext)) {
      setLoadingPreview(true);
      try {
        const res = await api<{ type: string; content: string; truncated: boolean; size: number }>(
          `/api/devices/${encodeURIComponent(serial)}/files/preview?path=${encodeURIComponent(item.path)}`,
        );
        setPreviewContent({ text: res.content, truncated: res.truncated });
      } catch (err) {
        setPreviewContent({ error: err instanceof Error ? err.message : "預覽載入失敗" });
      } finally {
        setLoadingPreview(false);
      }
    }
  }

  const filteredItems = items.filter((it) =>
    filterText.trim() ? it.name.toLowerCase().includes(filterText.toLowerCase()) : true,
  );

  return (
    <div className="fm-tab-content">
      {/* Quick shortcuts and path navigation */}
      <div className="fm-nav-bar">
        <div className="fm-quick-links">
          <span className="fm-quick-label">快速捷徑:</span>
          <button className="fm-chip-btn" onClick={() => void loadDir("/sdcard")}>
            內部儲存
          </button>
          <button className="fm-chip-btn" onClick={() => void loadDir("/sdcard/Download")}>
            下載
          </button>
          <button className="fm-chip-btn" onClick={() => void loadDir("/sdcard/DCIM")}>
            相簿 (DCIM)
          </button>
          <button className="fm-chip-btn" onClick={() => void loadDir("/sdcard/Pictures")}>
            圖片
          </button>
          <button className="fm-chip-btn" onClick={() => void loadDir("/data/local/tmp")}>
            暫存 (/data/local/tmp)
          </button>
        </div>

        <div className="fm-path-row">
          <button
            className="fm-icon-btn"
            disabled={!parentPath || loading}
            onClick={() => parentPath && void loadDir(parentPath)}
            title="回到上一層目錄"
          >
            <Icon name="arrowLeft" size={16} /> 上一層
          </button>

          <form className="fm-path-form" onSubmit={handlePathSubmit}>
            <input
              type="text"
              className="fm-path-input"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              placeholder="/sdcard"
            />
            <button type="submit" className="fm-btn primary" disabled={loading}>
              前往
            </button>
          </form>

          <button className="fm-icon-btn" onClick={() => void loadDir(currentPath)} disabled={loading} title="重新整理">
            <Icon name="refresh" size={15} />
          </button>
          <button className="fm-btn" onClick={() => setMkdirOpen(true)} disabled={loading} title="建立新資料夾">
            <Icon name="plus" size={14} /> 新資料夾
          </button>
          <button
            className="fm-btn primary"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || loading}
            title="上傳檔案至目前目錄"
          >
            <Icon name="upload" size={14} /> 上傳檔案
          </button>
          <input
            type="file"
            ref={fileInputRef}
            style={{ display: "none" }}
            multiple
            onChange={(e) => void handleUpload(e)}
          />
        </div>
      </div>

      {uploadStatus && <div className="fm-upload-banner">{uploadStatus}</div>}
      {error && <div className="fm-error-banner">{error}</div>}

      {/* Filter and stats */}
      <div className="fm-list-header">
        <span className="fm-count-text">
          {items.length} 個項目 (資料夾: {items.filter((i) => i.isDir).length}，檔案:{" "}
          {items.filter((i) => !i.isDir).length})
        </span>
        <div className="fm-search-wrap">
          <Icon name="search" size={14} />
          <input
            type="text"
            placeholder="搜尋檔案名稱..."
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
          />
        </div>
      </div>

      {/* Items list */}
      <div className="fm-file-table-wrap">
        <table className="fm-file-table fm-file-browser-table">
          <thead>
            <tr>
              <th className="fm-col-file-name">名稱</th>
              <th className="fm-col-file-size">大小</th>
              <th className="fm-col-file-date">修改日期</th>
              <th className="fm-col-file-actions" style={{ textAlign: "right" }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && items.length === 0 ? (
              <tr>
                <td colSpan={4} className="fm-empty-cell">
                  載入中...
                </td>
              </tr>
            ) : filteredItems.length === 0 ? (
              <tr>
                <td colSpan={4} className="fm-empty-cell">
                  {filterText ? "沒有相符的檔案" : "此目錄為空"}
                </td>
              </tr>
            ) : (
              filteredItems.map((item) => {
                const ext = item.extension?.toLowerCase() || "";
                const isImage = PREVIEWABLE_IMAGES.has(ext);
                const isText = PREVIEWABLE_TEXTS.has(ext);
                const canPreview = isImage || isText;

                return (
                  <tr key={item.path} className="fm-file-row fm-file-item-row">
                    <td className="fm-col-file-name">
                      <div
                        className="fm-file-name-cell"
                        onClick={() => {
                          if (item.isDir) void loadDir(item.path);
                          else if (canPreview) void openPreview(item);
                        }}
                      >
                        <span className={`fm-file-icon ${item.isDir ? "dir" : ext}`}>
                          <Icon name={item.isDir ? "folder" : isImage ? "image" : ext === "apk" ? "package" : "file"} size={16} />
                        </span>
                        <div className="fm-file-name-wrap">
                          <span className={`fm-item-name ${item.isDir ? "dir" : ""}`}>{item.name}</span>
                          {item.isLink && <span className="fm-link-badge">捷徑</span>}
                          {/* Mobile meta: size + date */}
                          <div className="fm-file-mobile-meta">
                            <span>{item.isDir ? "資料夾" : formatBytes(item.size)}</span>
                            <span>·</span>
                            <span>{formatDate(item.mtime)}</span>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="fm-col-file-size fm-size-cell">{item.isDir ? "—" : formatBytes(item.size)}</td>
                    <td className="fm-col-file-date fm-date-cell">{formatDate(item.mtime)}</td>
                    <td className="fm-col-file-actions" style={{ textAlign: "right" }}>
                      <div className="fm-row-actions">
                        {canPreview && (
                          <button
                            className="fm-mini-btn"
                            title="預覽"
                            onClick={() => void openPreview(item)}
                          >
                            預覽
                          </button>
                        )}
                        {!item.isDir && (
                          <a
                            className="fm-mini-btn"
                            title="下載到電腦"
                            href={`/api/devices/${encodeURIComponent(serial)}/files/download?path=${encodeURIComponent(item.path)}`}
                            download={item.name}
                          >
                            <Icon name="download" size={13} />
                          </a>
                        )}
                        <button
                          className="fm-mini-btn"
                          title="重新命名"
                          onClick={() => {
                            setRenameItem(item);
                            setRenameNewName(item.name);
                          }}
                        >
                          <Icon name="pencil" size={13} />
                        </button>
                        <button
                          className="fm-mini-btn danger"
                          title="刪除"
                          onClick={() => void handleDelete(item)}
                        >
                          <Icon name="trash" size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Make Dir Modal */}
      {mkdirOpen && (
        <div className="fm-submodal-backdrop">
          <form className="fm-submodal" onSubmit={handleMakeDir}>
            <h4>建立新資料夾</h4>
            <p className="muted" style={{ fontSize: 12 }}>
              在 {currentPath} 中建立新目錄
            </p>
            <input
              type="text"
              autoFocus
              placeholder="資料夾名稱"
              value={newDirName}
              onChange={(e) => setNewDirName(e.target.value)}
            />
            <div className="fm-submodal-actions">
              <button type="button" onClick={() => setMkdirOpen(false)}>
                取消
              </button>
              <button type="submit" className="primary" disabled={!newDirName.trim()}>
                建立
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Rename Modal */}
      {renameItem && (
        <div className="fm-submodal-backdrop">
          <form className="fm-submodal" onSubmit={handleRename}>
            <h4>重新命名</h4>
            <p className="muted" style={{ fontSize: 12 }}>
              原名稱: {renameItem.name}
            </p>
            <input
              type="text"
              autoFocus
              placeholder="新檔案名稱"
              value={renameNewName}
              onChange={(e) => setRenameNewName(e.target.value)}
            />
            <div className="fm-submodal-actions">
              <button type="button" onClick={() => setRenameItem(null)}>
                取消
              </button>
              <button type="submit" className="primary" disabled={!renameNewName.trim()}>
                儲存
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Preview Modal */}
      {previewItem && (
        <div className="fm-submodal-backdrop" onClick={(e) => e.target === e.currentTarget && setPreviewItem(null)}>
          <div className="fm-preview-modal">
            <header className="fm-preview-head">
              <div className="fm-preview-title">
                <Icon name={PREVIEWABLE_IMAGES.has(previewItem.extension || "") ? "image" : "file"} size={16} />
                <span>{previewItem.name}</span>
                <span className="muted" style={{ fontSize: 12 }}>
                  ({formatBytes(previewItem.size)})
                </span>
              </div>
              <button className="fm-close-btn" onClick={() => setPreviewItem(null)}>
                <Icon name="close" size={16} />
              </button>
            </header>

            <div className="fm-preview-body">
              {PREVIEWABLE_IMAGES.has(previewItem.extension || "") ? (
                <div className="fm-image-preview-wrap">
                  <img
                    src={`/api/devices/${encodeURIComponent(serial)}/files/preview?path=${encodeURIComponent(previewItem.path)}`}
                    alt={previewItem.name}
                    className="fm-preview-img"
                  />
                </div>
              ) : loadingPreview ? (
                <div className="fm-preview-loading">載入文字內容中...</div>
              ) : previewContent?.error ? (
                <div className="fm-error-banner">{previewContent.error}</div>
              ) : (
                <div className="fm-text-preview-wrap">
                  {previewContent?.truncated && (
                    <div className="fm-preview-notice">
                      ⚠️ 檔案過大，僅預覽前 256 KB 內容。如需完整內容請使用下載功能。
                    </div>
                  )}
                  <pre className="fm-text-preview-content">{previewContent?.text}</pre>
                </div>
              )}
            </div>

            <footer className="fm-preview-foot">
              <a
                className="fm-btn"
                href={`/api/devices/${encodeURIComponent(serial)}/files/download?path=${encodeURIComponent(previewItem.path)}`}
                download={previewItem.name}
              >
                <Icon name="download" size={14} /> 下載檔案
              </a>
              <button onClick={() => setPreviewItem(null)}>關閉</button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

/* ========================================================================= */
/*                                應用程式 TAB                                */
/* ========================================================================= */

function AppsTab({ serial }: { serial: string }) {
  const [filterType, setFilterType] = useState<"user" | "system" | "all">("user");
  const [apps, setApps] = useState<DeviceAppInfo[]>([]);
  const [foreground, setForeground] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  async function loadApps(type: "user" | "system" | "all") {
    setLoading(true);
    try {
      const res = await api<DeviceAppsResponse>(
        `/api/devices/${encodeURIComponent(serial)}/apps/list?type=${type}`,
      );
      setApps(res.apps);
      setForeground(res.foreground);
    } catch (err) {
      alert(`載入應用程式列表失敗: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadApps(filterType);
  }, [serial, filterType]);

  async function handleStart(pkg: string) {
    setActionBusy(pkg);
    try {
      await api(`/api/devices/${encodeURIComponent(serial)}/apps/start`, {
        method: "POST",
        body: JSON.stringify({ packageName: pkg }),
      });
      setForeground(pkg);
    } catch (err) {
      alert(`啟動失敗: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionBusy(null);
    }
  }

  async function handleStop(pkg: string) {
    setActionBusy(pkg);
    try {
      await api(`/api/devices/${encodeURIComponent(serial)}/apps/stop`, {
        method: "POST",
        body: JSON.stringify({ packageName: pkg }),
      });
      if (foreground === pkg) setForeground(undefined);
    } catch (err) {
      alert(`停止失敗: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionBusy(null);
    }
  }

  async function handleClear(pkg: string) {
    if (!confirm(`確定要清除「${pkg}」的應用程式資料與快取嗎？此操作不可逆。`)) return;
    setActionBusy(pkg);
    try {
      await api(`/api/devices/${encodeURIComponent(serial)}/apps/clear`, {
        method: "POST",
        body: JSON.stringify({ packageName: pkg }),
      });
      alert(`已成功清除 ${pkg} 資料`);
    } catch (err) {
      alert(`清除失敗: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionBusy(null);
    }
  }

  async function handleUninstall(pkg: string) {
    if (!confirm(`確定要從手機解除安裝「${pkg}」嗎？`)) return;
    setActionBusy(pkg);
    try {
      await api(`/api/devices/${encodeURIComponent(serial)}/apps/uninstall`, {
        method: "POST",
        body: JSON.stringify({ packageName: pkg }),
      });
      alert(`已解除安裝 ${pkg}`);
      void loadApps(filterType);
    } catch (err) {
      alert(`解除安裝失敗: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionBusy(null);
    }
  }

  const filtered = apps.filter((app) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return app.packageName.toLowerCase().includes(q) || (Boolean(app.name) && app.name!.toLowerCase().includes(q));
  });

  return (
    <div className="fm-tab-content">
      <div className="fm-apps-toolbar">
        <div className="fm-filter-group">
          <button
            className={`fm-chip-btn ${filterType === "user" ? "active" : ""}`}
            onClick={() => setFilterType("user")}
          >
            使用者應用 (已安裝)
          </button>
          <button
            className={`fm-chip-btn ${filterType === "system" ? "active" : ""}`}
            onClick={() => setFilterType("system")}
          >
            系統應用
          </button>
          <button
            className={`fm-chip-btn ${filterType === "all" ? "active" : ""}`}
            onClick={() => setFilterType("all")}
          >
            全部
          </button>
        </div>

        <div className="fm-search-wrap">
          <Icon name="search" size={14} />
          <input
            type="text"
            placeholder="搜尋名稱或 Package..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <button className="fm-icon-btn" onClick={() => void loadApps(filterType)} disabled={loading} title="重新整理">
          <Icon name="refresh" size={15} />
        </button>
      </div>

      <div className="fm-file-table-wrap">
        <table className="fm-file-table fm-app-table">
          <thead>
            <tr>
              <th className="fm-col-app-main">應用程式 (App / Package)</th>
              <th className="fm-col-app-ver">版本</th>
              <th className="fm-col-app-type">類型</th>
              <th className="fm-col-app-actions" style={{ textAlign: "right" }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={4} className="fm-empty-cell">
                  載入應用程式列表...
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={4} className="fm-empty-cell">
                  沒有相符的應用程式
                </td>
              </tr>
            ) : (
              filtered.map((app) => {
                const isFg = foreground === app.packageName;
                const isBusy = actionBusy === app.packageName;

                return (
                  <tr key={app.packageName} className={`fm-file-row fm-app-row ${isFg ? "highlight-row" : ""}`}>
                    <td className="fm-col-app-main">
                      <div className="fm-app-name-cell">
                        <div className="fm-app-icon-container">
                          <img
                            className="fm-app-icon-img"
                            src={`/api/devices/${encodeURIComponent(serial)}/apps/${encodeURIComponent(app.packageName)}/icon`}
                            alt=""
                            loading="lazy"
                            onError={(e) => {
                              (e.currentTarget as HTMLImageElement).style.display = "none";
                              const fallback = e.currentTarget.nextElementSibling as HTMLElement;
                              if (fallback) fallback.style.display = "flex";
                            }}
                          />
                          <span className="fm-app-icon-fallback" style={{ display: "none" }}>
                            <Icon name="package" size={18} />
                          </span>
                        </div>
                        <div className="fm-app-name-wrap">
                          <div className="fm-app-title-line">
                            <span className="fm-app-label">{app.name || app.packageName}</span>
                            {isFg && <span className="fm-fg-badge">前台執行中</span>}
                          </div>
                          {app.name && app.name !== app.packageName && (
                            <span className="fm-app-pkg">{app.packageName}</span>
                          )}
                          {/* Mobile metadata tags */}
                          <div className="fm-app-mobile-meta">
                            <span className={`fm-type-pill ${app.isSystem ? "system" : "user"}`}>
                              {app.isSystem ? "系統" : "第三方"}
                            </span>
                            {app.versionName && <span className="fm-app-mobile-ver">v{app.versionName}</span>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="fm-col-app-ver fm-app-version">{app.versionName || "—"}</td>
                    <td className="fm-col-app-type">
                      <span className={`fm-type-pill ${app.isSystem ? "system" : "user"}`}>
                        {app.isSystem ? "系統" : "第三方"}
                      </span>
                    </td>
                    <td className="fm-col-app-actions" style={{ textAlign: "right" }}>
                      <div className="fm-row-actions">
                        <button
                          className="fm-mini-btn"
                          title="啟動此 App"
                          disabled={isBusy}
                          onClick={() => void handleStart(app.packageName)}
                        >
                          <Icon name="play" size={13} /> 啟動
                        </button>
                        <button
                          className="fm-mini-btn"
                          title="強制停止 App"
                          disabled={isBusy}
                          onClick={() => void handleStop(app.packageName)}
                        >
                          <Icon name="stop" size={13} /> 停止
                        </button>
                        <a
                          className="fm-mini-btn"
                          title="匯出 APK 到電腦"
                          href={`/api/devices/${encodeURIComponent(serial)}/apps/export?packageName=${encodeURIComponent(app.packageName)}`}
                          download={`${app.packageName}.apk`}
                        >
                          <Icon name="download" size={13} /> 匯出 APK
                        </a>
                        <button
                          className="fm-mini-btn"
                          title="清除應用程式資料"
                          disabled={isBusy}
                          onClick={() => void handleClear(app.packageName)}
                        >
                          清除
                        </button>
                        {!app.isSystem && (
                          <button
                            className="fm-mini-btn danger"
                            title="解除安裝"
                            disabled={isBusy}
                            onClick={() => void handleUninstall(app.packageName)}
                          >
                            <Icon name="trash" size={13} /> 移除
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ========================================================================= */
/*                                安裝 APK TAB                                */
/* ========================================================================= */

function InstallApkTab({ serial }: { serial: string }) {
  const [dragOver, setDragOver] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFileDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      if (file.name.toLowerCase().endsWith(".apk")) {
        setSelectedFile(file);
        setResult(null);
      } else {
        alert("請選擇副檔名為 .apk 的檔案");
      }
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      setResult(null);
    }
  }

  async function handleInstall() {
    if (!selectedFile) return;
    setInstalling(true);
    setResult(null);

    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      const res = await fetch(`/api/devices/${encodeURIComponent(serial)}/apps/install`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setResult({ ok: true, message: `安裝成功！${data.output || ""}` });
        setSelectedFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
      } else {
        setResult({
          ok: false,
          message: data.error || data.output || `安裝失敗 (HTTP ${res.status})`,
        });
      }
    } catch (err) {
      setResult({
        ok: false,
        message: err instanceof Error ? err.message : "連線或安裝處理逾時",
      });
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div className="fm-tab-content fm-install-tab">
      <div
        className={`fm-drop-zone ${dragOver ? "drag-active" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleFileDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <div className="fm-drop-icon">
          <Icon name="upload" size={40} />
        </div>
        <h3>拖曳 APK 檔案至此處，或點擊選取</h3>
        <p className="muted" style={{ fontSize: 13 }}>
          支援任何 Android .apk 安裝檔，將自動上傳並在手機安裝
        </p>
        <input
          type="file"
          ref={fileInputRef}
          style={{ display: "none" }}
          accept=".apk"
          onChange={handleFileSelect}
        />
      </div>

      {selectedFile && (
        <div className="fm-selected-apk-card">
          <div className="fm-apk-info">
            <Icon name="package" size={24} />
            <div>
              <div className="fm-apk-filename">{selectedFile.name}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                {formatBytes(selectedFile.size)}
              </div>
            </div>
          </div>
          <button
            className="fm-btn primary"
            disabled={installing}
            onClick={() => void handleInstall()}
          >
            {installing ? "正在安裝中，請稍候..." : "開始安裝 APK"}
          </button>
        </div>
      )}

      {installing && (
        <div className="fm-install-progress-card">
          <div className="fm-spinner" />
          <div>
            <strong>正在上傳並透過 adb pm install 安裝中...</strong>
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              大型遊戲或應用可能需要數十秒完成，請勿關閉此視窗
            </p>
          </div>
        </div>
      )}

      {result && (
        <div className={`fm-result-banner ${result.ok ? "success" : "error"}`}>
          <div className="fm-result-title">{result.ok ? "🎉 安裝成功" : "❌ 安裝失敗"}</div>
          <pre className="fm-result-output">{result.message}</pre>
        </div>
      )}
    </div>
  );
}
