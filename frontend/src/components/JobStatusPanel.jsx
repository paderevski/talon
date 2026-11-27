import {
  isCancelableJobStatus,
  jobStatusFilters,
  statusLabel,
} from "talon-shared/status";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { getJobFileDownloadUrl } from "../api/client";
import FocusScrollRegion from "./FocusScrollRegion";
import JobLog, { DownloadLogLink, JobLogDialog } from "./JobLog";

// Under a day: "just now", "12m ago", "5h ago"; older: "Nov 7" ("Nov 7, 2025"
// in another year). The full date and time is the cell's tooltip.
function formatSubmittedValue(job) {
  const submitted = submittedMs(job);
  if (!submitted) {
    return "—";
  }
  const ageMinutes = Math.floor((Date.now() - submitted) / 60000);
  if (ageMinutes >= 0 && ageMinutes < 24 * 60) {
    if (ageMinutes < 1) return "just now";
    if (ageMinutes < 60) return `${ageMinutes}m ago`;
    return `${Math.floor(ageMinutes / 60)}h ago`;
  }
  const date = new Date(submitted);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

function submittedTitle(job) {
  const submitted = submittedMs(job);
  return submitted ? new Date(submitted).toLocaleString() : undefined;
}

// "1h 2m", "15m 40s", "48s" as seconds; "—" (not run yet) as -1 so it sorts first.
function durationSeconds(job) {
  const text = String(job?.duration ?? "");
  const units = { h: 3600, m: 60, s: 1 };
  let total = -1;
  for (const [, amount, unit] of text.matchAll(/(\d+)\s*([hms])/g)) {
    total = Math.max(total, 0) + Number(amount) * units[unit];
  }
  return total;
}

function submittedMs(job) {
  const value = Date.parse(job?.executionRef?.submittedAt || job?.submittedAt || "");
  return Number.isFinite(value) ? value : 0;
}

function computeLabel(job) {
  return job.gpu && job.gpu !== "—" ? job.gpu : "Local";
}

const text = (value) => String(value ?? "").toLowerCase();

const sorters = {
  name: (a, b) => text(a.name).localeCompare(text(b.name), undefined, { numeric: true }),
  owner: (a, b) => text(a.ownerUsername).localeCompare(text(b.ownerUsername)),
  repo: (a, b) => text(a.source?.label).localeCompare(text(b.source?.label)),
  status: (a, b) => text(a.status).localeCompare(text(b.status)),
  compute: (a, b) => computeLabel(a).localeCompare(computeLabel(b)),
  submitted: (a, b) => submittedMs(a) - submittedMs(b),
  duration: (a, b) => durationSeconds(a) - durationSeconds(b),
  cost: (a, b) => (a.costCents ?? 0) - (b.costCents ?? 0),
};

// A job's output files: live ones while it runs, else the stored result's.
function outputFiles(job, result, filesByJobId) {
  const files = filesByJobId?.[job.id] || result?.files || [];
  return files.map((file, index) => {
    const value = typeof file === "string" ? { name: file } : file || {};
    return {
      key: `${value.name || "file"}-${index}`,
      name: value.name || "unnamed",
      size: value.size || "",
      source: value.source || "output_dir",
    };
  });
}

const isLive = (job) => job.status === "queued" || job.status === "running";

// The open row: Results (files, error, how it ran) or Logs, by tab.
function JobDetail({ job, result, filesByJobId, tab, onTab, isPoppedOut, onExpand }) {
  return (
    <div className="job-detail-wrap">
      <div className="job-detail-bar">
        <div className="job-detail-tabs" role="tablist" aria-label={`${job.name} details`}>
          {[["results", "Results"], ["logs", "Logs"]].map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`view-tab${tab === id ? " active" : ""}`}
              onClick={() => onTab(id)}
            >
              {label}
              {id === "logs" && isLive(job) ? <span className="job-log-live">live</span> : null}
            </button>
          ))}
        </div>
        {tab === "logs" ? (
          <div className="job-log-tools">
            <DownloadLogLink job={job} />
            {/* Stays enabled so focus can return here when the dialog closes. */}
            <button type="button" className="btn btn-secondary btn-sm" onClick={onExpand}>
              Expand
            </button>
          </div>
        ) : null}
      </div>
      {tab === "results" ? (
        <JobResults job={job} result={result} filesByJobId={filesByJobId} />
      ) : isPoppedOut ? (
        <p className="form-hint job-log-elsewhere">This log is open in the larger view.</p>
      ) : (
        <JobLog job={job} live={isLive(job)} />
      )}
    </div>
  );
}

// What the job produced (files, or why it failed) and how it ran.
function JobResults({ job, result, filesByJobId }) {
  const files = outputFiles(job, result, filesByJobId);
  const error = result?.error || job.error || "";
  const isActive = isLive(job);
  const branch = job.source?.ref?.branch;
  const facts = [
    ["Source", job.source?.label, "mono"],
    branch ? ["Branch", branch, "mono"] : null,
    job.folder ? ["Folder", job.folder, "mono"] : null,
    job.entryScript ? ["Entry script", [job.entryScript, job.scriptArgs].filter(Boolean).join(" "), "mono"] : null,
    ["Submitted", submittedTitle(job) || "—", "num"],
  ].filter(Boolean);

  return (
    <div className="job-detail">
      {error ? <p className="job-detail-error">{error}</p> : null}
      <div className="job-detail-files">
        <h3 className="job-detail-title">Output files</h3>
        {files.length ? (
          <ul className="job-file-list">
            {files.map((file) => (
              <li key={file.key}>
                <a className="job-file-name" href={getJobFileDownloadUrl(job.id, file.name, file.source)}>
                  {file.name}
                </a>
                <span className="job-file-size num">{file.size}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="form-hint">
            {isActive ? "Files appear here as the job writes them." : "This job saved no output files."}
          </p>
        )}
      </div>
      <dl className="job-detail-facts">
        {facts.map(([label, value, className]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd className={className}>{value}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

// Count per tab from the full list (hidden jobs are not in it, so Hidden has no count).
function tabCounts(allJobs) {
  const counts = { all: allJobs.length };
  for (const job of allJobs) {
    counts[job.status] = (counts[job.status] || 0) + 1;
  }
  return counts;
}

export default function JobStatusPanel({
  jobs,
  allJobs = [],
  results = [],
  filesByJobId = {},
  focusJobId = null,
  activeFilter,
  setActiveFilter,
  statusAvailability,
  onCancelJob,
  onHideJob,
  onUnhideJob,
  jobActionError,
  readOnly = false,
  showOwner = false,
  title = "Jobs",
}) {
  const [search, setSearch] = useState("");
  // Newest first until a header is clicked.
  const [sort, setSort] = useState({ key: "submitted", dir: -1 });
  const counts = useMemo(() => tabCounts(allJobs), [allJobs]);
  const tabsRef = useRef(null);
  // Open rows and the tab each shows (jobId -> "results" | "logs"); several may be open.
  const [openRows, setOpenRows] = useState(() => new Map());
  // The job whose log is in the large view (Expand), if any.
  const [poppedOutJobId, setPoppedOutJobId] = useState(null);
  const resultsByJobId = useMemo(
    () => new Map(results.filter((result) => result?.jobId).map((result) => [result.jobId, result])),
    [results],
  );
  const columnCount = 8 + (showOwner ? 1 : 0) - (readOnly ? 1 : 0);

  // A running or queued job opens on its log; a finished one on its results.
  function toggleOpen(job) {
    setOpenRows((current) => {
      const next = new Map(current);
      if (next.has(job.id)) next.delete(job.id);
      else next.set(job.id, isLive(job) ? "logs" : "results");
      return next;
    });
  }

  function setRowTab(jobId, tab) {
    setOpenRows((current) => new Map(current).set(jobId, tab));
  }

  // On a phone the tab strip scrolls sideways: keep the selected tab in view.
  useEffect(() => {
    tabsRef.current?.querySelector(".view-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeFilter]);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return jobs
      .filter(
        (job) =>
          !needle ||
          [job.name, job.source?.label, showOwner ? job.ownerUsername : ""].some((value) => text(value).includes(needle)),
      )
      .sort((a, b) => sort.dir * sorters[sort.key](a, b) || submittedMs(b) - submittedMs(a));
  }, [jobs, search, sort, showOwner]);

  function sortBy(key) {
    // Times, durations and money start high-to-low; names A to Z.
    const firstDir = ["submitted", "duration", "cost"].includes(key) ? -1 : 1;
    setSort((current) => ({ key, dir: current.key === key ? -current.dir : firstDir }));
  }

  const header = (key, label, className) => (
    <th className={className} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button type="button" className="sort-btn" onClick={() => sortBy(key)}>
        {label}
        {sort.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
      </button>
    </th>
  );
  // Also look in all jobs: the status filter switches on its own (queued,
  // running, completed) and must not close the large log view.
  const poppedOutJob = poppedOutJobId
    ? jobs.find((job) => job.id === poppedOutJobId) || allJobs.find((job) => job.id === poppedOutJobId) || null
    : null;

  // A job just submitted: open its row on the log and bring it into view
  // (after the new view's scroll to the top).
  useEffect(() => {
    if (!focusJobId) {
      return undefined;
    }
    setOpenRows((current) => new Map(current).set(focusJobId, "logs"));
    const timer = setTimeout(() => {
      document.getElementById(`job-row-${focusJobId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 300);
    return () => clearTimeout(timer);
  }, [focusJobId]);

  const isFilterDisabled = (filter) => {
    if (filter === "running") {
      return !statusAvailability?.hasRunning;
    }

    if (filter === "queued") {
      return !statusAvailability?.hasQueued;
    }

    return false;
  };

  return (
    <section className="panel" id="job-status">
      <div className="panel-head panel-head-tabbed">
        <h2 className="panel-title">{title}</h2>
      </div>
      <div className="view-tabs" role="tablist" aria-label="Job status" ref={tabsRef}>
        {jobStatusFilters.map((filter) => (
          <button
            key={filter}
            type="button"
            role="tab"
            aria-selected={activeFilter === filter}
            className={`view-tab${activeFilter === filter ? " active" : ""}`}
            disabled={isFilterDisabled(filter)}
            onClick={() => setActiveFilter(filter)}
          >
            {statusLabel(filter)}
            {filter === "hidden" ? null : <span className="view-tab-count">{counts[filter] || 0}</span>}
          </button>
        ))}
      </div>
      <div className="list-controls">
        <input
          className="form-input list-search"
          placeholder={showOwner ? "Search job, repo or owner" : "Search job or repo"}
          aria-label="Search jobs"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {search.trim() ? (
          <span className="list-match-count" aria-live="polite">
            {rows.length} of {jobs.length}
          </span>
        ) : null}
      </div>
      <div className="table-card">
        <FocusScrollRegion className="job-status-scroll-region" ariaLabel="Job status table">
          <table>
            <thead>
              <tr>
                {/* col-optional: hidden on phones. */}
                {header("name", "Job")}
                {showOwner ? header("owner", "Owner", "col-optional") : null}
                {header("repo", "Repo", "col-optional")}
                {header("status", "Status")}
                {header("compute", "Compute", "col-optional")}
                {header("submitted", "Submitted")}
                {header("duration", "Duration", "col-optional")}
                {header("cost", "Cost", "col-optional")}
                {readOnly ? null : <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td className="empty-row" colSpan={columnCount}>
                    {search.trim() ? "No jobs match the search." : `No ${activeFilter === "all" ? "" : `${statusLabel(activeFilter).toLowerCase()} `}jobs.`}
                  </td>
                </tr>
              ) : null}
              {rows.map((job) => {
                const tab = openRows.get(job.id);
                const isOpen = Boolean(tab);
                return (
                <Fragment key={job.id}>
                <tr className={isOpen ? "row-open" : undefined} id={`job-row-${job.id}`}>
                  <td className="job-name-cell">
                    <button
                      type="button"
                      className="job-toggle"
                      aria-expanded={isOpen}
                      aria-controls={`job-detail-${job.id}`}
                      onClick={() => toggleOpen(job)}
                    >
                      <span className="job-toggle-icon" aria-hidden="true">▸</span>
                      {job.name}
                    </button>
                  </td>
                  {showOwner ? <td className="mono-sm col-optional">{job.ownerUsername}</td> : null}
                  <td className="repo-cell col-optional">{job.source?.label}</td>
                  <td>
                    <span className={`status-pill ${job.status}`}>
                      <span className="sdot" />
                      {statusLabel(job.status)}
                    </span>
                  </td>
                  <td className="col-optional">{computeLabel(job)}</td>
                  <td className="num" title={submittedTitle(job)}>{formatSubmittedValue(job)}</td>
                  <td className="num col-optional">{job.duration}</td>
                  <td className="num col-optional">{String(job?.cost ?? "").trim() || "$0.00"}</td>
                  {readOnly ? null : (
                  <td>
                      <>
                    {isCancelableJobStatus(job.status) ? (
                      <button className="btn btn-secondary btn-sm" type="button" onClick={() => onCancelJob(job.id)}>
                        Cancel
                      </button>
                    ) : null}
                    {job.hidden ? (
                      <button className="btn btn-secondary btn-sm" type="button" onClick={() => onUnhideJob(job.id)}>
                        Unhide
                      </button>
                    ) : (
                      <button className="btn btn-secondary btn-sm" type="button" onClick={() => onHideJob(job.id)}>
                        Hide
                      </button>
                    )}
                      </>
                  </td>
                  )}
                </tr>
                {isOpen ? (
                  <tr className="job-detail-row" id={`job-detail-${job.id}`}>
                    <td colSpan={columnCount}>
                      <JobDetail
                        job={job}
                        result={resultsByJobId.get(job.id)}
                        filesByJobId={filesByJobId}
                        tab={tab}
                        onTab={(next) => setRowTab(job.id, next)}
                        isPoppedOut={poppedOutJobId === job.id}
                        onExpand={() => setPoppedOutJobId(job.id)}
                      />
                    </td>
                  </tr>
                ) : null}
                </Fragment>
                );
              })}
            </tbody>
          </table>
        </FocusScrollRegion>
      </div>
      {poppedOutJob ? (
        <JobLogDialog job={poppedOutJob} live={isLive(poppedOutJob)} onClose={() => setPoppedOutJobId(null)} />
      ) : null}
      {jobActionError ? <div className="repo-error">{jobActionError}</div> : null}
    </section>
  );
}
