import { useEffect, useRef, useState } from "react";
import { fetchGithubRepos, fetchRepoBranches, fetchRepoTree } from "../api/client";
import { normalizeFolder, normalizeRepoInput, parseGithubUrl } from "../utils/repo";
import { formatDollars } from "../utils/format";
import { formatRuntime, machineLabel, planJob } from "../utils/jobPlan";

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
    folder: "",
    scriptArgs: "",
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
  const { ec2, localAllowed, machines, hasGpuMachines, runOn, selectedMachine, runtimeChoices, runtimeSeconds, estimateDollars, overBudget, nowhereToRun } = planJob({
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
      onRepoBranchChange(activeRepo, form.branch, normalizeFolder(form.folder) ?? "");
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activeRepo, form.branch, form.folder, onRepoBranchChange]);

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

  const folder = normalizeFolder(form.folder);
  const folderInvalid = folder === null;

  // Branch menu: the repo's branches, default branch first. When the repo
  // changes and the current branch is not one of them (main vs master), the
  // default branch is chosen. Free text if the list cannot be loaded.
  const [branchOptions, setBranchOptions] = useState([]);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const branchRepo = normalizeRepoInput(activeRepo);
  useEffect(() => {
    setBranchOptions([]);
    if (!branchRepo) {
      setIsLoadingBranches(false);
      return undefined;
    }
    let cancelled = false;
    setIsLoadingBranches(true);
    const timeoutId = window.setTimeout(() => {
      fetchRepoBranches(branchRepo)
        .then(({ defaultBranch, branches }) => {
          if (cancelled) {
            return;
          }
          setBranchOptions(branches || []);
          setForm((prev) => (branches?.includes(prev.branch) ? prev : { ...prev, branch: defaultBranch || prev.branch }));
        })
        .catch(() => !cancelled && setBranchOptions([]))
        .finally(() => !cancelled && setIsLoadingBranches(false));
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [branchRepo]);

  useEffect(() => {
    const normalizedRepo = normalizeRepoInput(activeRepo);
    const branch = String(form.branch ?? "").trim() || "main";

    if (!normalizedRepo || folderInvalid) {
      setScriptOptions([]);
      setIsLoadingScripts(false);
      setScriptError("");
      return;
    }

    let cancelled = false;
    setIsLoadingScripts(true);
    setScriptError("");

    // Scripts directly in the job's folder (the repo root when there is none).
    const prefix = folder ? `${folder}/` : "";
    fetchRepoTree(normalizedRepo, branch, { path: folder })
      .then((repoData) => {
        if (cancelled) {
          return;
        }

        const pythonFiles = (repoData.items || [])
          .filter((item) => item?.type === "file")
          .map((item) => String(item.path || item.rawName || item.name || "").trim())
          .filter((filePath) => filePath.startsWith(prefix) && filePath.toLowerCase().endsWith(".py"))
          .map((filePath) => filePath.slice(prefix.length))
          .filter((name) => name && !name.includes("/"));

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
        setScriptError(folder && /not found|404/i.test(error.message || "")
          ? `Folder '${folder}' was not found on this branch.`
          : error.message || "Unable to load Python scripts");
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingScripts(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeRepo, form.branch, folder, folderInvalid]);

  // A pasted github.com/.../tree/<branch>/<folder> (or /blob/.../script.py)
  // URL also fills in the branch, folder and script.
  const onPublicRepoChange = (event) => {
    const value = event.target.value;
    const parsed = parseGithubUrl(value);
    setForm((prev) => {
      const next = { ...prev, repo: value };
      if (parsed?.branch) {
        next.branch = parsed.branch;
        next.folder = parsed.folder ?? "";
        if (parsed.entryScript) {
          next.entryScript = parsed.entryScript;
        }
      }
      return next;
    });
  };

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
      const { runOn: _ignored, maxRuntimeSeconds: _chosen, ...fields } = form;
      await onSubmit({
        ...fields,
        repo: normalizedRepo,
        folder: folder ?? "",
        name: nameForSubmit,
        ...(selectedMachine ? { compute: "ec2", instanceType: runOn, maxRuntimeSeconds: Number(runtimeSeconds) } : {}),
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
        folder: prev.folder,
        entryScript: prev.entryScript,
        scriptArgs: prev.scriptArgs,
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
              <input className="form-input" value={form.repo} onChange={onPublicRepoChange} placeholder="https://github.com/owner/repo" />
              <span className="form-hint">Any public GitHub repository, as a URL or owner/repo. A link to a folder also sets the branch and folder.</span>
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
            {branchOptions.length ? (
              <select className="form-select" value={form.branch} onChange={update("branch")}>
                {!branchOptions.includes(form.branch) && form.branch ? <option value={form.branch}>{form.branch}</option> : null}
                {branchOptions.map((name, index) => (
                  <option key={name} value={name}>{name}{index === 0 ? " (default)" : ""}</option>
                ))}
              </select>
            ) : (
              <input className="form-input" value={form.branch} onChange={update("branch")} placeholder={isLoadingBranches ? "Loading..." : "main"} />
            )}
          </div>
        )}
        <div className="form-group form-group-inline">
          <label className="form-label">Folder</label>
          <input
            className="form-input"
            value={isDrive ? "" : form.folder}
            onChange={update("folder")}
            placeholder="(repository root)"
            disabled={isDrive}
          />
          <span className="form-hint">
            {folderInvalid
              ? "Use a plain path inside the repository, like mnist or src/train."
              : "The job runs from here and installs its requirements.txt."}
          </span>
        </div>
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
                  ? `Any .py file in ${folder ? `${folder}/` : "the repository root"}.`
                  : `No .py files in ${folder ? `${folder}/` : "the repository root"} on this branch. You can type one.`))}
          </span>
        </div>
        {ec2 ? (
          <>
            <div className="form-group form-group-half">
              <label className="form-label">Machine</label>
              <select className="form-select" value={runOn} onChange={update("runOn")}>
                {(hasGpuMachines ? [["cpu", "CPU"], ["gpu", "GPU"]] : [["cpu", null]]).map(([kind, groupLabel]) => {
                  const items = machines.filter((m) => m.kind === kind).map((option) => (
                    <option key={option.instanceType} value={option.instanceType} disabled={!option.affordable}>
                      {machineLabel(option)}{option.affordable ? "" : " (over budget)"}
                    </option>
                  ));
                  return groupLabel ? <optgroup key={kind} label={groupLabel}>{items}</optgroup> : items;
                })}
                {localAllowed ? <option value="local">Web server (free, no isolation)</option> : null}
              </select>
            </div>
            <div className="form-group form-group-half">
              <label className="form-label">Time limit</label>
              <select className="form-select" value={runtimeSeconds} onChange={update("maxRuntimeSeconds")} disabled={!selectedMachine}>
                {runtimeChoices.map((choice) => (
                  <option key={choice.seconds} value={choice.seconds} disabled={!choice.affordable}>
                    {formatRuntime(choice.seconds)}{choice.affordable ? "" : " (over budget)"}
                  </option>
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
                {overBudget ? ` Even the shortest time limit on this machine is more than your remaining budget (${formatDollars(budgetDollars)}): choose a smaller machine.` : ""}
              </span>
            </div>
          </>
        ) : null}
        {nowhereToRun ? (
          <div className="form-group full">
            <span className="form-hint">Jobs cannot be started on this server right now.</span>
          </div>
        ) : null}
        <div className="form-group full job-extras">
          <div className="form-group">
            <label className="form-label" htmlFor="job-script-args">Arguments</label>
            <input
              id="job-script-args"
              className="form-input mono-input"
              value={form.scriptArgs}
              onChange={update("scriptArgs")}
              placeholder="--save-model --epochs 3"
              disabled={isDrive}
              spellCheck={false}
            />
            <span className="form-hint">
              Passed to the entry script, like typing them after python {form.entryScript || "train.py"}. Quote values with spaces.
            </span>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="job-env-vars">Environment Variables</label>
            <textarea
              id="job-env-vars"
              className="form-input form-textarea mono-input"
              value={form.environmentVariables}
              onChange={update("environmentVariables")}
              placeholder={"BATCH_SIZE=32\nLEARNING_RATE=0.001\nEPOCHS=50"}
            />
            <span className="form-hint">One NAME=value per line.</span>
          </div>
        </div>
        <div className="form-group full form-actions submit-actions-row">
          <button className="btn btn-primary" type="submit" disabled={submitting || overBudget || nowhereToRun || isDrive || folderInvalid || !normalizeRepoInput(activeRepo)}>
            {submitting ? "Submitting..." : "Submit Job"}
          </button>
          {isDrive ? <span className="form-hint">Google Drive is not available yet.</span> : null}
        </div>
        {message ? <div className="form-group full"><span className="form-hint">{message}</span></div> : null}
      </form>
    </section>
  );
}
