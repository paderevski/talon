import { useEffect, useRef, useState } from "react";
import { fetchGithubRepos, fetchRepoTree } from "../api/client";
import { normalizeRepoInput } from "../utils/repo";
import { formatDollars } from "../utils/format";
import { formatRuntime, planJob } from "../utils/jobPlan";

const jobNameCountersStorageKey = "talon.jobNameCounters";

function toRepoKey(repo) {
  return normalizeRepoInput(repo) || "job";
}

function toRepoNameBase(repo) {
  const normalizedRepo = toRepoKey(repo);
  const rawRepoName = normalizedRepo.split("/").pop() || normalizedRepo;
  const cleaned = rawRepoName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return cleaned || "job";
}

function readJobNameCounters() {
  try {
    const raw = window.localStorage.getItem(jobNameCountersStorageKey);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    return parsed;
  } catch {
    return {};
  }
}

function writeJobNameCounters(counters) {
  window.localStorage.setItem(jobNameCountersStorageKey, JSON.stringify(counters));
}

function getNextJobName(repo) {
  const repoKey = toRepoKey(repo);
  const counters = readJobNameCounters();
  const current = Number(counters[repoKey] ?? 0);
  const next = Number.isFinite(current) ? current + 1 : 1;
  return `${toRepoNameBase(repo)}-${next}`;
}

function consumeNextJobName(repo) {
  const repoKey = toRepoKey(repo);
  const counters = readJobNameCounters();
  const current = Number(counters[repoKey] ?? 0);
  const next = Number.isFinite(current) ? current + 1 : 1;
  counters[repoKey] = next;
  writeJobNameCounters(counters);
  return `${toRepoNameBase(repo)}-${next}`;
}

// Where the job's code comes from. Only GitHub and public repos run today;
// Google Drive is a placeholder to show how the form adapts.
const codeSources = [
  { id: "github", label: "GitHub", detail: (linked, login) => (linked ? login || "connected" : "not connected") },
  { id: "public", label: "Public repository", detail: () => "any GitHub URL" },
  { id: "drive", label: "Google Drive", detail: () => "coming soon" },
];

function makeInitialForm(defaultRepo, defaultBranch) {
  const repo = String(defaultRepo ?? "").trim();
  return {
    name: getNextJobName(repo),
    repo,
    branch: defaultBranch || "main",
    entryScript: "train.py",
    runOn: "",
    maxRuntimeSeconds: 3600,
    s3DataSource: "",
    outputDestination: "Home Directory (~/$JOB_NAME/)",
    environmentVariables: ""
  };
}

export default function NewJobPanel({ onSubmit, defaultRepo, defaultBranch, githubLinked = false, githubLogin = "", onRepoBranchChange, compute = null, budgetDollars = null }) {
  const [form, setForm] = useState(makeInitialForm(defaultRepo, defaultBranch));
  const [isAutoName, setIsAutoName] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [repoOptions, setRepoOptions] = useState([]);
  const [isLoadingRepos, setIsLoadingRepos] = useState(false);
  const [repoError, setRepoError] = useState("");
  const [scriptOptions, setScriptOptions] = useState([]);
  const [isLoadingScripts, setIsLoadingScripts] = useState(false);
  const [scriptError, setScriptError] = useState("");
  const [source, setSource] = useState(githubLinked ? "github" : "public");
  const isDrive = source === "drive";
  // The repo the rest of the form (scripts, repo browser) works from.
  const activeRepo = isDrive ? "" : form.repo;

  // Default to GitHub once the link status arrives.
  useEffect(() => {
    setSource((current) => (current === "drive" ? current : githubLinked ? "github" : "public"));
  }, [githubLinked]);

  // Each source keeps its own repo, so switching back and forth does not put
  // a private GitHub repo into the public URL box (or the reverse).
  const repoBySource = useRef({});
  const chooseSource = (next) => {
    if (next === source) {
      return;
    }
    repoBySource.current[source] = form.repo;
    setSource(next);
    if (next === "drive") {
      return;
    }
    let repo = repoBySource.current[next] ?? "";
    if (next === "github" && !repoOptions.some((r) => r.fullName === normalizeRepoInput(repo))) {
      repo = repoOptions[0]?.fullName ?? "";
    }
    setForm((prev) => ({ ...prev, repo }));
  };

  // Machines come from the server; see utils/jobPlan.js.
  const { ec2, localAllowed, runOn, selectedMachine, estimateDollars, overBudget, nowhereToRun } = planJob({
    compute,
    runOn: form.runOn,
    maxRuntimeSeconds: form.maxRuntimeSeconds,
    budgetDollars,
  });

  useEffect(() => {
    setForm((prev) => ({
      ...prev,
      repo: String(defaultRepo ?? "").trim(),
      branch: defaultBranch || "main",
    }));
  }, [defaultRepo, defaultBranch]);

  useEffect(() => {
    setForm((prev) => {
      const currentName = String(prev.name ?? "").trim();
      if (!isAutoName && currentName) {
        return prev;
      }

      const nextName = getNextJobName(prev.repo);
      if (nextName === prev.name) {
        return prev;
      }

      return {
        ...prev,
        name: nextName,
      };
    });
  }, [form.repo, isAutoName]);

  useEffect(() => {
    if (typeof onRepoBranchChange !== "function") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      onRepoBranchChange(activeRepo, form.branch);
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activeRepo, form.branch, onRepoBranchChange]);

  const update = (field) => (event) => {
    setForm((prev) => ({ ...prev, [field]: event.target.value }));
  };

  const onJobNameChange = (event) => {
    const nextName = event.target.value;
    setForm((prev) => ({ ...prev, name: nextName }));
    setIsAutoName(!nextName.trim());
  };

  useEffect(() => {
    if (!githubLinked) {
      setRepoOptions([]);
      setIsLoadingRepos(false);
      setRepoError("");
      return;
    }

    let cancelled = false;
    setIsLoadingRepos(true);
    setRepoError("");

    fetchGithubRepos()
      .then((items) => {
        const repos = items.map((item) => item.fullName);
        if (cancelled) {
          return;
        }

        setRepoOptions(items);
        setForm((prev) => {
          const normalizedCurrentRepo = normalizeRepoInput(prev.repo);
          // Keep whatever is already chosen (it stays in the menu even if
          // it is a public repo the app was not given).
          if (!repos.length || normalizedCurrentRepo) {
            return prev;
          }

          return {
            ...prev,
            repo: repos[0],
          };
        });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        setRepoOptions([]);
        setRepoError(error.message || "Unable to load repositories");
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingRepos(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [githubLinked]);

  useEffect(() => {
    const normalizedRepo = normalizeRepoInput(activeRepo);
    const branch = String(form.branch ?? "").trim() || "main";

    if (!normalizedRepo) {
      setScriptOptions([]);
      setIsLoadingScripts(false);
      setScriptError("");
      return;
    }

    let cancelled = false;
    setIsLoadingScripts(true);
    setScriptError("");

    fetchRepoTree(normalizedRepo, branch)
      .then((repoData) => {
        if (cancelled) {
          return;
        }

        const pythonFiles = (repoData.items || [])
          .filter((item) => item?.type === "file")
          .map((item) => String(item.path || item.rawName || item.name || "").trim())
          .filter((filePath) => filePath && !filePath.includes("/") && filePath.toLowerCase().endsWith(".py"));

        setScriptOptions(pythonFiles);
        setForm((prev) => {
          if (!pythonFiles.length || (prev.entryScript && pythonFiles.includes(prev.entryScript))) {
            return prev;
          }

          return {
            ...prev,
            entryScript: pythonFiles[0],
          };
        });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        setScriptOptions([]);
        setScriptError(error.message || "Unable to load Python scripts");
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingScripts(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeRepo, form.branch]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setMessage("");

    const normalizedRepo = normalizeRepoInput(form.repo) || form.repo;
    const trimmedName = String(form.name ?? "").trim();
    const shouldUseAutoName = isAutoName || !trimmedName;
    const generatedName = shouldUseAutoName ? getNextJobName(normalizedRepo) : "";
    const nameForSubmit = shouldUseAutoName ? generatedName : trimmedName;

    try {
      const { runOn: _ignored, maxRuntimeSeconds, ...fields } = form;
      await onSubmit({
        ...fields,
        repo: normalizedRepo,
        name: nameForSubmit,
        ...(selectedMachine ? { compute: "ec2", instanceType: runOn, maxRuntimeSeconds: Number(maxRuntimeSeconds) } : {}),
      });

      if (shouldUseAutoName) {
        consumeNextJobName(normalizedRepo);
      }

      setMessage("Job submitted to queue.");
      setForm((prev) => ({
        ...makeInitialForm(defaultRepo, defaultBranch),
        name: getNextJobName(prev.repo),
        repo: prev.repo,
        branch: prev.branch,
      }));
      setIsAutoName(true);
    } catch (error) {
      setMessage(error?.message || "Unable to submit job.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="panel" id="new-job">
      <div className="panel-head">
        <h2 className="panel-title">Submit New Job</h2>
      </div>
      <form className="new-job-grid new-job-grid-submit" onSubmit={handleSubmit}>
        <div className="form-group full">
          <span className="form-label" id="code-source-label">Code source</span>
          <div className="source-picker" role="radiogroup" aria-labelledby="code-source-label">
            {codeSources.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={source === option.id}
                className={`source-option${source === option.id ? " selected" : ""}`}
                onClick={() => chooseSource(option.id)}
              >
                <span className="source-option-label">{option.label}</span>
                <span className="source-option-detail">{option.detail(githubLinked, githubLogin)}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="form-group form-group-inline">
          <label className="form-label">Job Name</label>
          <input className="form-input" value={form.name} onChange={onJobNameChange} placeholder="e.g. bert-nlp-7" />
        </div>
        <div className="form-group form-group-inline">
          {source === "github" ? (
            <>
              <label className="form-label">Repository</label>
              {githubLinked ? (
                <select className="form-select" value={normalizeRepoInput(form.repo)} onChange={update("repo")} disabled={isLoadingRepos || !repoOptions.length}>
                  {isLoadingRepos ? <option>Loading repositories...</option> : null}
                  {!isLoadingRepos && !repoOptions.length ? <option value="">No repositories yet</option> : null}
                  {repoOptions.map((repo) => (
                    <option key={repo.fullName} value={repo.fullName}>{repo.fullName}{repo.private ? " (private)" : ""}</option>
                  ))}
                </select>
              ) : (
                <a className="source-placeholder" href="#github">Connect GitHub to choose a repository →</a>
              )}
              <span className="form-hint">
                {repoError
                  || (!githubLinked
                    ? "Or use Public repository for a public repo."
                    : (!isLoadingRepos && !repoOptions.length
                      ? "Choose repositories in the GitHub panel."
                      : "Repositories the Talon app can read. Add more in the GitHub panel."))}
              </span>
            </>
          ) : null}
          {source === "public" ? (
            <>
              <label className="form-label">Repository URL</label>
              <input className="form-input" value={form.repo} onChange={update("repo")} placeholder="https://github.com/owner/repo" />
              <span className="form-hint">Any public GitHub repository, as a URL or owner/repo. No sign-in needed.</span>
            </>
          ) : null}
          {isDrive ? (
            <>
              <label className="form-label">Google Drive folder</label>
              <button type="button" className="source-placeholder" disabled>Choose a folder…</button>
              <span className="form-hint">Coming soon: run a script or notebook from a Google Drive folder.</span>
            </>
          ) : null}
        </div>
        {isDrive ? (
          <div className="form-group form-group-inline">
            <label className="form-label">Branch</label>
            <input className="form-input" value="Not used for Drive" disabled />
          </div>
        ) : (
          <div className="form-group form-group-inline">
            <label className="form-label">Branch</label>
            <input className="form-input" value={form.branch} onChange={update("branch")} />
          </div>
        )}
        <div className="form-group form-group-inline">
          <label className="form-label">Entry Script</label>
          {scriptOptions.length ? (
            <select className="form-select" value={form.entryScript} onChange={update("entryScript")} disabled={isLoadingScripts}>
              {scriptOptions.map((script) => (
                <option key={script} value={script}>{script}</option>
              ))}
            </select>
          ) : (
            <input className="form-input" value={form.entryScript} onChange={update("entryScript")} placeholder="train.py" />
          )}
          <span className="form-hint">
            {isDrive
              ? "Path to the script inside the folder."
              : scriptError
              ? scriptError
              : (isLoadingScripts
                ? "Loading top-level Python files..."
                : (scriptOptions.length
                  ? "Select any top-level .py file from this repo and branch."
                  : "No top-level .py files found on this branch. You can enter one manually."))}
          </span>
        </div>
        {ec2 ? (
          <>
            <div className="form-group form-group-half">
              <label className="form-label">Machine</label>
              <select className="form-select" value={runOn} onChange={update("runOn")}>
                {ec2.options.map((option) => (
                  <option key={option.instanceType} value={option.instanceType}>
                    {option.memoryGb} GB memory, {option.vcpus} CPUs ({option.instanceType}) - ${(option.hourlyRateCents / 100).toFixed(3)}/hour
                  </option>
                ))}
                {localAllowed ? <option value="local">Web server (free, no isolation)</option> : null}
              </select>
            </div>
            <div className="form-group form-group-half">
              <label className="form-label">Time limit</label>
              <select className="form-select" value={form.maxRuntimeSeconds} onChange={update("maxRuntimeSeconds")} disabled={!selectedMachine}>
                {ec2.runtimeSeconds.map((seconds) => (
                  <option key={seconds} value={seconds}>{formatRuntime(seconds)}</option>
                ))}
              </select>
              <span className="form-hint">Includes installing requirements.txt. The job stops when it is reached.</span>
            </div>
            <div className="form-group full">
              <span className="form-hint">
                {selectedMachine
                  ? `This job can cost up to ${formatDollars(estimateDollars)}. That is set aside when it starts; you are charged per second for the time it actually runs and the rest is returned. `
                  : "Runs on the web server itself: free, but not isolated. "}
                {ec2.maxJobsPerUser === 1 ? "One job at a time." : ""}
                {overBudget ? ` That is more than your remaining budget (${formatDollars(budgetDollars)}): choose a smaller machine or a shorter time limit.` : ""}
              </span>
            </div>
          </>
        ) : null}
        {nowhereToRun ? (
          <div className="form-group full">
            <span className="form-hint">Jobs cannot be started on this server right now.</span>
          </div>
        ) : null}
        <div className="form-group full">
          <label className="form-label">Environment Variables</label>
          <textarea
            className="form-input form-textarea"
            value={form.environmentVariables}
            onChange={update("environmentVariables")}
            placeholder={"BATCH_SIZE=32\nLEARNING_RATE=0.001\nEPOCHS=50"}
          />
        </div>
        <div className="form-group full form-actions submit-actions-row">
          <button className="btn btn-primary" type="submit" disabled={submitting || overBudget || nowhereToRun || isDrive || !normalizeRepoInput(activeRepo)}>
            {submitting ? "Submitting..." : "Submit Job"}
          </button>
          {isDrive ? <span className="form-hint">Google Drive is not available yet.</span> : null}
        </div>
        {message ? <div className="form-group full"><span className="form-hint">{message}</span></div> : null}
      </form>
    </section>
  );
}
