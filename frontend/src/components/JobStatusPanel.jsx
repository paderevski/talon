import {
  isCancelableJobStatus,
  jobStatusFilters,
  statusLabel,
} from "talon-shared/status";
import { useEffect, useMemo, useRef, useState } from "react";
import FocusScrollRegion from "./FocusScrollRegion";
import JobLogsPanel from "./JobLogsPanel";

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
  const [logJobId, setLogJobId] = useState(null);
  const [search, setSearch] = useState("");
  // Newest first until a header is clicked.
  const [sort, setSort] = useState({ key: "submitted", dir: -1 });
  const counts = useMemo(() => tabCounts(allJobs), [allJobs]);
  const tabsRef = useRef(null);

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

  const header = (key, label) => (
    <th aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button type="button" className="sort-btn" onClick={() => sortBy(key)}>
        {label}
        {sort.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
      </button>
    </th>
  );
  // Also look in all jobs: the status filter switches on its own (queued,
  // running, completed) and must not close the panel of the job being watched.
  const logJob = logJobId
    ? jobs.find((job) => job.id === logJobId) || allJobs.find((job) => job.id === logJobId) || null
    : null;

  // A job just submitted: open its logs and progress, and bring them into view
  // (after the new view's scroll to the top).
  useEffect(() => {
    if (!focusJobId) {
      return undefined;
    }
    setLogJobId(focusJobId);
    const timer = setTimeout(() => {
      document.getElementById("job-logs")?.scrollIntoView({ behavior: "smooth", block: "start" });
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
                {header("name", "Job")}
                {showOwner ? header("owner", "Owner") : null}
                {header("repo", "Repo")}
                {header("status", "Status")}
                {header("compute", "Compute")}
                {header("submitted", "Submitted")}
                {header("duration", "Duration")}
                {header("cost", "Cost")}
                <th>Logs</th>
                {readOnly ? null : <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td className="empty-row" colSpan={9 + (showOwner ? 1 : 0) - (readOnly ? 1 : 0)}>
                    {search.trim() ? "No jobs match the search." : `No ${activeFilter === "all" ? "" : `${statusLabel(activeFilter).toLowerCase()} `}jobs.`}
                  </td>
                </tr>
              ) : null}
              {rows.map((job) => (
                <tr key={job.id}>
                  <td className="job-name-cell">{job.name}</td>
                  {showOwner ? <td className="mono-sm">{job.ownerUsername}</td> : null}
                  <td className="repo-cell">{job.source?.label}</td>
                  <td>
                    <span className={`status-pill ${job.status}`}>
                      <span className="sdot" />
                      {statusLabel(job.status)}
                    </span>
                  </td>
                  <td>{computeLabel(job)}</td>
                  <td className="num" title={submittedTitle(job)}>{formatSubmittedValue(job)}</td>
                  <td className="num">{job.duration}</td>
                  <td className="num">{String(job?.cost ?? "").trim() || "$0.00"}</td>
                  <td>
                    <button
                      className="btn btn-secondary btn-sm"
                      type="button"
                      onClick={() => setLogJobId(logJobId === job.id ? null : job.id)}
                    >
                      {logJobId === job.id ? "Hide logs" : "Logs"}
                    </button>
                  </td>
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
              ))}
            </tbody>
          </table>
        </FocusScrollRegion>
      </div>
      {logJob ? (
        <JobLogsPanel
          id="job-logs"
          job={logJob}
          live={logJob.status === "queued" || logJob.status === "running"}
          onClose={() => setLogJobId(null)}
        />
      ) : null}
      {jobActionError ? <div className="repo-error">{jobActionError}</div> : null}
    </section>
  );
}
