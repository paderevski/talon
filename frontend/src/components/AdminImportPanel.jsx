import { useState } from "react";
import { importRoster } from "../api/client";
import { formatDollars } from "../utils/format";

const template = [
  "username,name,email,role,class,budget",
  "student_one,Student One,,student,Intro to ML,10",
  "teacher_one,Teacher One,teacher.one@example.org,teacher,Intro to ML,100",
  "",
].join("\n");

// Quote a CSV field if it has a comma, quote or newline.
const csvField = (value) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export default function AdminImportPanel({ onChanged }) {
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [defaultRole, setDefaultRole] = useState("student");
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  function reset() {
    setPreview(null);
    setResult(null);
    setError("");
  }

  async function onFile(event) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    setCsv(await file.text());
    setFileName(file.name);
    reset();
  }

  async function run(dryRun) {
    setIsBusy(true);
    setError("");
    try {
      const response = await importRoster(csv, { defaultRole, dryRun });
      if (dryRun) {
        setPreview(response);
        setResult(null);
      } else {
        setResult(response);
        setPreview(null);
        setCsv("");
        setFileName("");
        onChanged();
      }
    } catch (nextError) {
      setError(nextError.message || "Import failed");
    } finally {
      setIsBusy(false);
    }
  }

  const passwordsCsv = result
    ? `${["username,name,password", ...result.credentials.map((c) => [c.username, c.fullName, c.password].map(csvField).join(","))].join("\n")}\n`
    : "";

  return (
    <section className="panel admin-section" id="admin-import">
      <div className="panel-head">
        <h2 className="panel-title">Import users</h2>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => download("talon-import-template.csv", template)}>
          Download template
        </button>
      </div>

      <div className="form-hint" style={{ marginBottom: 10 }}>
        CSV with a header row. Only <strong>username</strong> is required; optional columns are name, email, role
        (student, teacher or admin; <code>teacher;student</code> for several), class (created if new) and budget
        (dollars; a teacher&apos;s goes to their pool). New users get a generated password. Existing usernames are
        left alone, but still added to the class. Up to 500 rows; nothing is written until you confirm.
      </div>

      {error ? <div className="repo-error">{error}</div> : null}

      {result ? (
        <div className="credentials-notice" role="status" style={{ flexDirection: "column", alignItems: "flex-start" }}>
          <strong>
            Imported {result.credentials.length} new user{result.credentials.length === 1 ? "" : "s"}
            {result.summary.exists ? `; ${result.summary.exists} already existed` : ""}.
          </strong>
          {result.credentials.length > 0 ? (
            <>
              <span>
                Passwords are shown <strong>once</strong> and cannot be looked up later. Download them now and hand them out
                securely.
              </span>
              <div className="row-actions">
                <button type="button" className="btn btn-primary btn-sm" onClick={() => download("talon-new-passwords.csv", passwordsCsv)}>
                  Download passwords (CSV)
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setResult(null)}>
                  I saved them, dismiss
                </button>
              </div>
            </>
          ) : (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setResult(null)}>
              Dismiss
            </button>
          )}
        </div>
      ) : null}

      <div className="inline-form">
        <div className="form-group">
          <label className="form-label" htmlFor="import-file">CSV file</label>
          <input id="import-file" className="form-input" type="file" accept=".csv,text/csv,text/plain" onChange={onFile} />
          {fileName ? <span className="form-hint">{fileName}</span> : null}
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="import-role">Role when the file has none</label>
          <select
            id="import-role"
            className="form-select"
            value={defaultRole}
            onChange={(event) => {
              setDefaultRole(event.target.value);
              reset();
            }}
          >
            <option value="student">student</option>
            <option value="teacher">teacher</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <div className="form-group full">
          <label className="form-label" htmlFor="import-text">…or paste CSV</label>
          <textarea
            id="import-text"
            className="form-input form-textarea mono-sm"
            rows={6}
            placeholder={template}
            value={csv}
            onChange={(event) => {
              setCsv(event.target.value);
              setFileName("");
              reset();
            }}
          />
        </div>
        <div className="form-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={isBusy || !csv.trim()} onClick={() => run(true)}>
            Preview
          </button>
        </div>
      </div>

      {preview ? (
        <>
          <div className={preview.summary.errors > 0 ? "repo-error" : "notice-ok"}>
            {preview.summary.create} to create, {preview.summary.exists} already exist
            {preview.summary.newClasses.length > 0 ? `, new classes: ${preview.summary.newClasses.join(", ")}` : ""}
            {preview.summary.errors > 0 ? `. ${preview.summary.errors} row(s) need fixing; nothing will be imported until they are.` : "."}
          </div>
          <div className="table-card table-scroll-region">
            <table>
              <thead>
                <tr>
                  <th>Line</th>
                  <th>User</th>
                  <th>Role</th>
                  <th>Class</th>
                  <th>Budget</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.line} className={row.action === "exists" ? "row-disabled" : undefined}>
                    <td className="mono-sm">{row.line}</td>
                    <td>
                      {row.fullName}
                      <div className="form-hint mono-sm">{row.username}</div>
                    </td>
                    <td>{row.roles.join(", ")}</td>
                    <td>{row.className || "—"}</td>
                    <td>{row.budget > 0 ? formatDollars(row.budget) : "—"}</td>
                    <td>
                      {row.action === "error" ? (
                        row.errors.map((message) => (
                          <div key={message} className="form-hint" style={{ color: "var(--accent-red)" }}>{message}</div>
                        ))
                      ) : row.action === "exists" ? (
                        "Already exists"
                      ) : (
                        <span style={{ color: "var(--accent-green)" }}>Will create</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="form-actions" style={{ marginTop: 10 }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={isBusy || preview.summary.errors > 0 || preview.summary.total === 0}
              onClick={() => run(false)}
            >
              Import {preview.summary.create} user{preview.summary.create === 1 ? "" : "s"}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={reset}>
              Cancel
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
