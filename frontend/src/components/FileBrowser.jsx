import { useRef } from "react";

// A folder of a job's code source (a GitHub repo or a Google Drive folder),
// inside the New Job form. Presentational: the form loads the folder (one
// request, shared with the entry-script menu) and owns the path.
//
//   rootLabel     "owner/repo" or the Drive folder's name
//   path          folder inside it ("" = top)
//   items         [{ name, type: "dir" | "file", size?, native? }] or null while loading
//   onNavigate    (path) => open a folder (sets the job's Folder)
//   onChooseFile  (item) => a .py file was clicked (sets the entry script)
//   selectedFile  the current entry script's name
//
// Single click opens a folder or chooses a script; the breadcrumbs go back
// up. Arrow keys move between rows, Backspace goes up a level.

export function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) {
    return "";
  }
  if (n < 1024) {
    return `${n} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

// Same rule as the form's entry script menu (NewJobPanel isRunnableScript).
const isScript = (item) => item.type === "file" && !item.native && /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.py$/i.test(item.name);
const parentOf = (p) => p.split("/").slice(0, -1).join("/");

function FolderIcon() {
  return (
    <svg className="fb-icon fb-icon-dir" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1.5 3.5h4.2l1.4 1.6h7.4v8.4h-13z" fill="currentColor" />
    </svg>
  );
}

function FileIcon({ script }) {
  return (
    <svg className={`fb-icon${script ? " fb-icon-script" : ""}`} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M9.5 1.5v3h3" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export default function FileBrowser({
  rootLabel,
  path = "",
  items,
  error = "",
  onNavigate,
  onChooseFile,
  selectedFile = "",
  emptyText = "This folder is empty.",
  disabled = false,
}) {
  const listRef = useRef(null);
  const segments = path ? path.split("/") : [];
  const sorted = Array.isArray(items)
    ? [...items].sort((a, b) => (a.type === "dir" ? 0 : 1) - (b.type === "dir" ? 0 : 1) || a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }))
    : null;

  const onKeyDown = (event) => {
    const rows = [...(listRef.current?.querySelectorAll("button.fb-row:not(:disabled)") ?? [])];
    const index = rows.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = event.key === "ArrowDown" ? Math.min(rows.length - 1, index + 1) : Math.max(0, index - 1);
      rows[next]?.focus();
    } else if (event.key === "Backspace" && path && !disabled) {
      event.preventDefault();
      onNavigate(parentOf(path));
    }
  };

  return (
    <div className={`file-browser${disabled ? " disabled" : ""}`}>
      <div className="fb-head">
        <nav className="fb-crumbs" aria-label="Folder">
          <button type="button" className="fb-crumb" onClick={() => onNavigate("")} disabled={disabled || !path}>
            {rootLabel || "—"}
          </button>
          {segments.map((segment, i) => {
            const target = segments.slice(0, i + 1).join("/");
            const last = i === segments.length - 1;
            return (
              <span key={target} className="fb-crumb-part">
                <span className="fb-sep" aria-hidden="true">/</span>
                <button type="button" className="fb-crumb" onClick={() => onNavigate(target)} disabled={disabled || last} aria-current={last ? "location" : undefined}>
                  {segment}
                </button>
              </span>
            );
          })}
        </nav>
        {path ? (
          <button type="button" className="fb-up" onClick={() => onNavigate(parentOf(path))} disabled={disabled} title="Up one folder">
            ↑ Up
          </button>
        ) : null}
      </div>

      <div className="fb-list" ref={listRef} onKeyDown={onKeyDown} role="list">
        {error ? <div className="fb-message fb-error">{error}</div> : null}
        {!error && sorted === null ? <div className="fb-message">Loading...</div> : null}
        {!error && sorted && sorted.length === 0 ? <div className="fb-message">{emptyText}</div> : null}
        {!error && sorted
          ? sorted.map((item) => {
            const dir = item.type === "dir";
            const script = isScript(item);
            const selected = script && item.name === selectedFile;
            const target = path ? `${path}/${item.name}` : item.name;
            return (
              <button
                key={`${item.type}:${item.name}`}
                type="button"
                role="listitem"
                className={`fb-row${dir ? " fb-dir" : ""}${script ? " fb-script" : ""}${selected ? " selected" : ""}`}
                disabled={disabled || (!dir && !script)}
                onClick={() => (dir ? onNavigate(target) : onChooseFile?.(item))}
                title={dir ? `Open ${item.name}` : script ? `Run ${item.name}` : undefined}
              >
                {dir ? <FolderIcon /> : <FileIcon script={script} />}
                <span className="fb-name">{item.name}</span>
                {selected ? <span className="fb-tag fb-tag-run">entry script</span> : null}
                {!dir && /^requirements\.txt$/i.test(item.name) ? <span className="fb-tag">installed</span> : null}
                {item.native ? <span className="fb-tag" title="Google Docs, Sheets and Slides are not copied into jobs">Google file, not copied</span> : null}
                <span className="fb-size">{dir ? "" : formatSize(item.size)}</span>
              </button>
            );
          })
          : null}
      </div>
    </div>
  );
}
