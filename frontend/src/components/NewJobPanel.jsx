import { useEffect, useRef, useState } from "react";
import { fetchConnectionItems, fetchDriveFolder, fetchRepoBranches, fetchRepoTree } from "../api/client";
import FileBrowser from "./FileBrowser";
import { normalizeDrivePath, normalizeFolder, normalizeRepoInput, parseGithubUrl } from "../utils/repo";
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

// Where the job's code comes from. "GitHub" and "Public repository" are
// both the github source on the server; Google Drive is the drive source
// (a folder the student chose in Connections, or a folder inside it).
const codeSources = [
  { id: "github", label: "GitHub", detail: (c) => (c.githubLinked ? c.githubLogin || "connected" : "not connected") },
  { id: "public", label: "Public repository", detail: () => "any GitHub URL" },
  { id: "drive", label: "Google Drive", detail: (c) => (c.driveLinked ? c.driveLogin || "connected" : "not connected") },
];

// A .py file that can be an entry script. The name goes into the job's run
// script, so it must be plain (the server checks the same).
export const isRunnableScript = (item) =>
  item?.type === "file" && !item.native && /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.py$/i.test(item.name);

function makeInitialForm(defaultRepo, defaultBranch) {
  const repo = String(defaultRepo ?? "").trim();
  return {
    name: getNextJobName(repo),
    repo,
    branch: defaultBranch || "main",
    entryScript: "train.py",
    folder: "",
    driveItem: "",
    scriptArgs: "",
    runOn: "",
    maxRuntimeSeconds: 3600,
    s3DataSource: "",
    outputDestination: "Home Directory (~/$JOB_NAME/)",
    environmentVariables: ""
  };
}

export default function NewJobPanel({ onSubmit, defaultRepo, defaultBranch, githubLinked = false, githubLogin = "", driveLinked = false, driveLogin = "", compute = null, budgetDollars = null }) {
  const [form, setForm] = useState(makeInitialForm(defaultRepo, defaultBranch));
  const [isAutoName, setIsAutoName] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [repoOptions, setRepoOptions] = useState([]);
  const [isLoadingRepos, setIsLoadingRepos] = useState(false);
  const [repoError, setRepoError] = useState("");
  const [source, setSource] = useState(githubLinked ? "github" : "public");
  const isDrive = source === "drive";
  // The repo the rest of the form (scripts, file browser) works from.
  const activeRepo = isDrive ? "" : form.repo;
  // Drive: what the student chose in Connections (folders and files).
  const [driveItems, setDriveItems] = useState(null);
  const [driveError, setDriveError] = useState("");
  const driveItem = (driveItems || []).find((item) => item.id === form.driveItem) || null;
  const driveIsFile = driveItem?.kind === "file";
  // What job names are made from: the repo, or the Drive item's name.
  const nameBase = isDrive ? (driveItem?.label || "drive") : form.repo;

  // Default to GitHub once the link status arrives.
  useEffect(() => {
    setSource((current) => (current === "drive" ? current : githubLinked ? "github" : "public"));
  }, [githubLinked]);

  // Each source keeps its own repo and folder, so switching back and forth
  // does not put a private GitHub repo into the public URL box (or the
  // reverse), or a Drive path into a repo.
  const stateBySource = useRef({});
  const chooseSource = (next) => {
    if (next === source) {
      return;
    }
    stateBySource.current[source] = { repo: form.repo, folder: form.folder };
    setSource(next);
    const saved = stateBySource.current[next] ?? {};
    let repo = saved.repo ?? "";
    if (next === "github" && !repoOptions.some((r) => r.fullName === normalizeRepoInput(repo))) {
      repo = repoOptions[0]?.fullName ?? "";
    }
    setForm((prev) => ({ ...prev, repo: next === "drive" ? prev.repo : repo, folder: saved.folder ?? "" }));
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

      const nextName = getNextJobName(nameBase);
      if (nextName === prev.name) {
        return prev;
      }

      return {
        ...prev,
        name: nextName,
      };
    });
  }, [nameBase, isAutoName]);

  // Drive items, once Drive is linked.
  useEffect(() => {
    setDriveItems(null);
    setDriveError("");
    if (!driveLinked) {
      return undefined;
    }
    let cancelled = false;
    fetchConnectionItems("google_drive")
      .then((items) => {
        if (cancelled) {
          return;
        }
        setDriveItems(items);
        setForm((prev) => (items.some((i) => i.id === prev.driveItem) ? prev : { ...prev, driveItem: items[0]?.id ?? "" }));
      })
      .catch((error) => {
        if (!cancelled) {
          setDriveItems([]);
          setDriveError(error.message || "Could not load your Drive items");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [driveLinked]);

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

    fetchConnectionItems("github")
      .then((list) => list.map((item) => ({ fullName: item.id, private: item.private })))
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

  // Drive paths may have spaces; repo folders go into the run script, so stricter.
  const folder = isDrive ? normalizeDrivePath(form.folder) : normalizeFolder(form.folder);
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

  // The job's folder, loaded once for both the file browser and the entry
  // script menu: a repo folder on a branch, or a folder inside a Drive item.
  // { key, rootLabel, items, error }; items null while loading.
  const [listing, setListing] = useState({ key: "", rootLabel: "", items: null, error: "" });
  const listingRepo = normalizeRepoInput(activeRepo);
  const listingBranch = String(form.branch ?? "").trim() || "main";
  const listingFolder = driveIsFile ? "" : folder;
  const listingKey = folderInvalid
    ? ""
    : isDrive
      ? (form.driveItem ? `drive:${form.driveItem}:${listingFolder}` : "")
      : (listingRepo ? `git:${listingRepo}@${listingBranch}:${listingFolder}` : "");
  useEffect(() => {
    if (!listingKey) {
      setListing({ key: "", rootLabel: "", items: [], error: "" });
      return undefined;
    }
    let cancelled = false;
    setListing((prev) => ({ key: listingKey, rootLabel: prev.key && prev.rootLabel, items: null, error: "" }));
    // Typed folders: wait for a pause before asking.
    const timeoutId = window.setTimeout(() => {
      const request = isDrive
        ? fetchDriveFolder(form.driveItem, listingFolder).then((data) => ({ rootLabel: data.root?.label || driveItem?.label || "", items: data.items || [] }))
        : fetchRepoTree(listingRepo, listingBranch, { path: listingFolder }).then((data) => ({
          rootLabel: listingRepo,
          // GitHub items carry full paths; the browser wants names in this folder.
          items: (data.items || [])
            .filter((item) => item?.type === "dir" || item?.type === "file")
            .map((item) => ({ name: String(item.path || item.name || "").split("/").pop(), type: item.type, size: item.size })),
        }));
      request
        .then((data) => {
          if (cancelled) {
            return;
          }
          setListing({ key: listingKey, rootLabel: data.rootLabel, items: data.items, error: "" });
          const scripts = data.items.filter(isRunnableScript).map((item) => item.name);
          setForm((prev) => (!scripts.length || scripts.includes(prev.entryScript) ? prev : { ...prev, entryScript: scripts[0] }));
        })
        .catch((error) => {
          if (cancelled) {
            return;
          }
          const notFound = /not found|404/i.test(error.message || "");
          setListing({
            key: listingKey,
            rootLabel: isDrive ? driveItem?.label || "" : listingRepo,
            items: [],
            error: notFound && listingFolder
              ? `Folder '${listingFolder}' was not found${isDrive ? "" : " on this branch"}.`
              : error.message || "Unable to load this folder",
          });
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [listingKey]);

  const scriptOptions = (listing.items || []).filter(isRunnableScript).map((item) => item.name);
  const isLoadingScripts = Boolean(listingKey) && listing.items === null;
  const scriptError = listing.error;

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
    const generatedName = shouldUseAutoName ? getNextJobName(nameBase) : "";
    const nameForSubmit = shouldUseAutoName ? generatedName : trimmedName;

    try {
      const { runOn: _ignored, maxRuntimeSeconds: _chosen, repo: _repo, branch: _branch, driveItem: _item, folder: _folder, ...fields } = form;
      // Drive: only the chosen folder is copied and the job runs from its
      // top, so the folder is part of the source, not the job's folder.
      await onSubmit({
        ...fields,
        source: isDrive
          ? { type: "drive", itemId: form.driveItem, path: driveIsFile ? "" : folder ?? "" }
          : { type: "github", repo: normalizedRepo, branch: form.branch },
        folder: isDrive ? "" : folder ?? "",
        name: nameForSubmit,
        ...(selectedMachine ? { compute: "ec2", instanceType: runOn, maxRuntimeSeconds: Number(runtimeSeconds) } : {}),
      });

      if (shouldUseAutoName) {
        consumeNextJobName(nameBase);
      }

      setMessage("Job submitted to queue.");
      setForm((prev) => ({
        ...makeInitialForm(defaultRepo, defaultBranch),
        name: getNextJobName(nameBase),
        repo: prev.repo,
        branch: prev.branch,
        folder: prev.folder,
        driveItem: prev.driveItem,
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
                <span className="source-option-detail">{option.detail({ githubLinked, githubLogin, driveLinked, driveLogin })}</span>
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
                <a className="source-placeholder" href="#connections">Connect GitHub to choose a repository →</a>
              )}
              <span className="form-hint">
                {repoError
                  || (!githubLinked
                    ? "Or use Public repository for a public repo."
                    : (!isLoadingRepos && !repoOptions.length
                      ? "Choose repositories in Connections."
                      : "Repositories the Talon app can read. Add more in Connections."))}
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
              {driveLinked ? (
                <select className="form-select" value={form.driveItem} onChange={(event) => setForm((prev) => ({ ...prev, driveItem: event.target.value, folder: "" }))} disabled={driveItems === null || !driveItems.length}>
                  {driveItems === null ? <option>Loading...</option> : null}
                  {driveItems && !driveItems.length ? <option value="">Nothing chosen yet</option> : null}
                  {[["folder", "Folders"], ["file", "Files"]].map(([kind, groupLabel]) => {
                    const options = (driveItems || []).filter((item) => (kind === "folder" ? item.kind === "folder" : item.kind !== "folder"));
                    return options.length ? (
                      <optgroup key={kind} label={groupLabel}>
                        {options.map((item) => (
                          <option key={item.id} value={item.id} disabled={item.kind === "google-doc"}>{item.label}</option>
                        ))}
                      </optgroup>
                    ) : null;
                  })}
                </select>
              ) : (
                <a className="source-placeholder" href="#connections">Connect Google Drive to choose a folder →</a>
              )}
              <span className="form-hint">
                {driveError
                  || (!driveLinked
                    ? "Connect Google Drive in Connections and choose the folders Talon may use."
                    : (driveItems && !driveItems.length ? "Choose folders in Connections." : "Folders and files you chose in Connections."))}
              </span>
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
            value={driveIsFile ? "" : form.folder}
            onChange={update("folder")}
            placeholder={isDrive ? (driveIsFile ? "(a single file)" : "(top of the Drive folder)") : "(repository root)"}
            disabled={isDrive && (driveIsFile || !driveItem)}
          />
          <span className="form-hint">
            {folderInvalid
              ? (isDrive ? "That is not a folder path inside the Drive folder." : "Use a plain path inside the repository, like mnist or src/train.")
              : isDrive
                ? "Talon copies this folder and everything in it; files outside it are not available to the job. Its requirements.txt is installed."
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
            {scriptError
              ? scriptError
              : (isLoadingScripts
                ? "Loading Python files..."
                : (scriptOptions.length
                  ? "Or click a .py file below."
                  : `No .py files in ${listingFolder ? `${listingFolder}/` : `the ${isDrive ? "Drive folder" : "repository root"}`}. You can type one.`))}
          </span>
        </div>
        {listingKey ? (
          <div className="form-group full">
            <FileBrowser
              rootLabel={listing.rootLabel || (isDrive ? driveItem?.label : listingRepo)}
              path={listingFolder}
              items={listing.items}
              error={listing.error}
              onNavigate={(next) => setForm((prev) => ({ ...prev, folder: next }))}
              onChooseFile={(item) => setForm((prev) => ({ ...prev, entryScript: item.name }))}
              selectedFile={form.entryScript}
              emptyText={isDrive ? "This folder is empty." : "No files in this folder on this branch."}
              disabled={isDrive && driveIsFile}
            />
          </div>
        ) : null}
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
          <button className="btn btn-primary" type="submit" disabled={submitting || overBudget || nowhereToRun || folderInvalid || (isDrive ? !driveItem || driveItem.kind === "google-doc" : !normalizeRepoInput(activeRepo))}>
            {submitting ? "Submitting..." : "Submit Job"}
          </button>
        </div>
        {message ? <div className="form-group full"><span className="form-hint">{message}</span></div> : null}
      </form>
    </section>
  );
}
