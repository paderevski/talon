import { Fragment, useEffect, useMemo, useState } from "react";
import AdminBudgetPanel from "./AdminBudgetPanel";
import { formatClassName, formatDollars } from "../utils/format";

// "Ada Lovelace" sorts as "lovelace ada", so lists read alphabetically by last name.
function nameKey(user) {
  const parts = user.fullName.trim().split(/\s+/);
  return `${parts.at(-1)} ${parts.slice(0, -1).join(" ")}`.toLowerCase();
}

// The balance that matters for the list: a teacher's pool, otherwise the personal budget.
function mainBalance(user, kind) {
  return kind === "teacher" ? user.poolBalance ?? 0 : user.personalBalance;
}

// The Class column as shown ("Calculus · Block 5, ..."), names in order; "" when none.
function classesKey(user) {
  return user.classes
    .map((classItem) => formatClassName(classItem.name, classItem.block))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .join(", ");
}

const sorters = {
  name: (a, b) => nameKey(a).localeCompare(nameKey(b)),
  // By class name then block (Block 2 before Block 10); no class sorts first.
  classes: (a, b) => classesKey(a).localeCompare(classesKey(b), undefined, { numeric: true }),
  username: (a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase()),
  lastLogin: (a, b) => (a.lastLoginAt ? Date.parse(a.lastLoginAt) : 0) - (b.lastLoginAt ? Date.parse(b.lastLoginAt) : 0),
};

// One table of users (students, teachers or admins) with search, filters,
// sortable headers. editingId/editor: the user being edited and the edit
// form, shown as an expanded row under that user; Adjust opens that user's
// budget panel the same way (one expanded row at a time: onCloseEditor).
export default function UserList({
  id,
  title,
  kind,
  users,
  classes,
  authUser,
  isBusy,
  onAdd,
  onEdit,
  onResetPassword,
  onToggleStatus,
  onChanged,
  editingId = null,
  editor = null,
  onCloseEditor,
}) {
  const [budgetUserId, setBudgetUserId] = useState(null);
  // Why the budget panel opened, when Disable sent the admin there first.
  const [budgetNotice, setBudgetNotice] = useState(null);
  // Opening Edit closes the budget panel; opening the budget panel closes Edit.
  useEffect(() => {
    if (editingId) {
      setBudgetUserId(null);
    }
  }, [editingId]);
  function toggleBudget(user) {
    setBudgetNotice(null);
    if (budgetUserId === user.id) {
      setBudgetUserId(null);
      return;
    }
    onCloseEditor?.();
    setBudgetUserId(user.id);
  }

  // Disabling with money left would strand it (the server refuses too): open
  // the budget panel instead, on the account that still holds money.
  function disableOrExplain(user) {
    const own = user.personalBalance ?? 0;
    const pool = user.roles.includes("teacher") ? user.poolBalance ?? 0 : 0;
    if (user.status !== "active" || (own <= 0 && pool <= 0)) {
      onToggleStatus(user);
      return;
    }
    const parts = [
      own > 0 ? `${formatDollars(own)} in their own budget` : "",
      pool > 0 ? `${formatDollars(pool)} in their pool` : "",
    ].filter(Boolean);
    onCloseEditor?.();
    setBudgetUserId(user.id);
    setBudgetNotice({
      account: own > 0 ? "personal" : "pool",
      text: `${user.fullName} still has ${parts.join(" and ")}. Take it back first, then disable the account.`,
    });
  }
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [classId, setClassId] = useState("all");
  const [sort, setSort] = useState({ key: "name", dir: 1 });
  // Everyone has a personal budget, admins too (funded from School like anyone's).
  const hasBudget = true;
  // Budget is two cells: the amount (right-aligned) and its Adjust button.
  const columnCount = 3 + (kind !== "admin" ? 1 : 0) + (hasBudget ? 2 : 0);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const compare =
      sort.key === "budget"
        ? (a, b) => mainBalance(a, kind) - mainBalance(b, kind)
        : sorters[sort.key];

    return users
      .filter((user) => status === "all" || user.status === status)
      .filter((user) => {
        if (classId === "all") return true;
        if (classId === "none") return user.classes.length === 0;
        return user.classes.some((classItem) => String(classItem.id) === classId);
      })
      .filter(
        (user) =>
          !needle ||
          [user.fullName, user.username, user.email || "", user.githubLogin || ""].some((value) => value.toLowerCase().includes(needle)),
      )
      .sort((a, b) => sort.dir * compare(a, b) || sorters.name(a, b));
  }, [users, search, status, classId, sort, kind]);

  function sortBy(key) {
    setSort((current) => ({ key, dir: current.key === key ? -current.dir : 1 }));
  }

  const header = (key, label, className) => (
    <th className={className} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button type="button" className="sort-btn" onClick={() => sortBy(key)}>
        {label}
        {sort.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
      </button>
    </th>
  );

  const isFiltered = search || status !== "all" || classId !== "all";

  // Admin add/subtract in the row: a teacher's pool or anyone's own budget.
  // Add moves money from the School account, subtract moves it back there.
  // Errors are shown by the control; success reloads the lists.

  return (
    <section className="panel admin-section" id={id}>
      <div className="list-controls">
        <input
          className="form-input"
          placeholder="Search name, username, email or GitHub"
          aria-label={`Search ${title.toLowerCase()}`}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select className="form-select" aria-label="Filter by status" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="all">Active and disabled</option>
          <option value="active">Active only</option>
          <option value="disabled">Disabled only</option>
        </select>
        {kind !== "admin" ? (
          <select className="form-select" aria-label="Filter by class" value={classId} onChange={(event) => setClassId(event.target.value)}>
            <option value="all">All classes</option>
            <option value="none">No class</option>
            {classes.map((classItem) => (
              <option key={classItem.id} value={String(classItem.id)}>
                {formatClassName(classItem.name, classItem.block)}
                {classItem.teacher ? ` (${classItem.teacher.fullName})` : ""}
              </option>
            ))}
          </select>
        ) : null}
        <div className="list-controls-end">
          {isFiltered ? (
            <span className="list-match-count" aria-live="polite">
              {rows.length} of {users.length}
            </span>
          ) : null}
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onAdd(kind)}>
            Add {kind}
          </button>
        </div>
      </div>

      <div className="table-card table-scroll-region">
        <table>
          <thead>
            <tr>
              {header("name", "Name")}
              {/* Students usually have one class, teachers several. */}
              {kind !== "admin" ? header("classes", kind === "student" ? "Class" : "Classes") : null}
              {hasBudget ? header("budget", "Budget", "cell-num") : null}
              {hasBudget ? <th className="budget-adjust-cell" aria-label="Adjust budget" /> : null}
              {header("lastLogin", "Last sign-in")}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((user) => {
              const isSelf = user.username.toLowerCase() === String(authUser?.username ?? "").toLowerCase();
              const isEditing = editor && user.id === editingId;
              const isBudgetOpen = !isEditing && user.id === budgetUserId;
              const rowClass = [user.status === "disabled" ? "row-disabled" : "", isEditing || isBudgetOpen ? "row-editing" : ""].filter(Boolean).join(" ");
              return (
                <Fragment key={user.id}>
                <tr className={rowClass || undefined}>
                  <td>
                    {user.fullName}
                    <div className="form-hint mono-sm">{user.username}</div>
                    {user.roles.length > 1 ? (
                      <div>
                        {user.roles.map((role) => (
                          <span key={role} className={`role-chip ${role}`}>{role}</span>
                        ))}
                      </div>
                    ) : null}
                    {user.status === "disabled" ? <div className="form-hint">Disabled</div> : null}
                    {user.canRunJobsOverride === false ? <div className="form-hint">Job running off</div> : null}
                    {user.canRunJobsOverride === true && !user.roles.includes("student") && !user.roles.includes("admin") ? (
                      <div className="form-hint">Can run jobs</div>
                    ) : null}
                  </td>
                  {kind !== "admin" ? (
                    <td>{classesKey(user) || "—"}</td>
                  ) : null}
                  {hasBudget ? (
                    <td className="cell-num">
                      {kind === "teacher" ? (
                        <span className="budget-cell-figures">
                          <span className="form-hint">Pool</span>
                          <span>{formatDollars(user.poolBalance ?? 0)}</span>
                          <span className="form-hint">Own</span>
                          <span>{formatDollars(user.personalBalance ?? 0)}</span>
                        </span>
                      ) : (
                        formatDollars(user.personalBalance ?? 0)
                      )}
                    </td>
                  ) : null}
                  {hasBudget ? (
                    <td className="budget-adjust-cell">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        aria-expanded={isBudgetOpen}
                        onClick={() => toggleBudget(user)}
                      >
                        Adjust
                      </button>
                    </td>
                  ) : null}
                  <td className="mono-sm">
                    {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString() : "never"}
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        aria-expanded={Boolean(isEditing)}
                        onClick={() => onEdit(user)}
                      >
                        Edit
                      </button>
                      <button type="button" className="btn btn-secondary btn-sm" disabled={isBusy} onClick={() => onResetPassword(user)}>
                        Reset password
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={isBusy || isSelf}
                        title={isSelf ? "You cannot disable your own account" : undefined}
                        onClick={() => disableOrExplain(user)}
                      >
                        {user.status === "active" ? "Disable" : "Enable"}
                      </button>
                    </div>
                  </td>
                </tr>
                {isEditing ? (
                  <tr className="row-editor">
                    <td colSpan={columnCount}>{editor}</td>
                  </tr>
                ) : null}
                {isBudgetOpen ? (
                  <tr className="row-editor">
                    <td colSpan={columnCount}>
                      <AdminBudgetPanel
                        key={budgetNotice ? "disable" : "adjust"}
                        user={user}
                        initialAccount={budgetNotice?.account ?? (kind === "teacher" ? "pool" : "personal")}
                        notice={budgetNotice?.text}
                        onClose={() => {
                          setBudgetUserId(null);
                          setBudgetNotice(null);
                        }} onChanged={onChanged} />
                    </td>
                  </tr>
                ) : null}
                </Fragment>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columnCount} className="form-hint">
                  {users.length === 0 ? `No ${title.toLowerCase()} yet.` : "Nothing matches these filters."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
