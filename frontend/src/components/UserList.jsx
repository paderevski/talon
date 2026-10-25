import { useMemo, useState } from "react";
import BudgetCell from "./BudgetCell";

// "Ada Lovelace" sorts as "lovelace ada", so lists read alphabetically by last name.
function nameKey(user) {
  const parts = user.fullName.trim().split(/\s+/);
  return `${parts.at(-1)} ${parts.slice(0, -1).join(" ")}`.toLowerCase();
}

// The balance that matters for the list: a teacher's pool, otherwise the personal budget.
function mainBalance(user, kind) {
  return kind === "teacher" ? user.poolBalance ?? 0 : user.personalBalance;
}

const sorters = {
  name: (a, b) => nameKey(a).localeCompare(nameKey(b)),
  username: (a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase()),
  lastLogin: (a, b) => (a.lastLoginAt ? Date.parse(a.lastLoginAt) : 0) - (b.lastLoginAt ? Date.parse(b.lastLoginAt) : 0),
};

// One table of users (students, teachers or admins) with search, filters,
// sortable headers and in-place budget editing.
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
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [classId, setClassId] = useState("all");
  const [sort, setSort] = useState({ key: "name", dir: 1 });
  const hasBudget = kind !== "admin";

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
          [user.fullName, user.username, user.email || ""].some((value) => value.toLowerCase().includes(needle)),
      )
      .sort((a, b) => sort.dir * compare(a, b) || sorters.name(a, b));
  }, [users, search, status, classId, sort, kind]);

  function sortBy(key) {
    setSort((current) => ({ key, dir: current.key === key ? -current.dir : 1 }));
  }

  const header = (key, label) => (
    <th aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button type="button" className="sort-btn" onClick={() => sortBy(key)}>
        {label}
        {sort.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
      </button>
    </th>
  );

  const isFiltered = search || status !== "all" || classId !== "all";

  return (
    <section className="panel admin-section" id={id}>
      <div className="panel-head">
        <h2 className="panel-title">
          {title}
          <span className="panel-count">
            {isFiltered ? `${rows.length} of ${users.length}` : users.length}
          </span>
        </h2>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => onAdd(kind)}>
          Add {kind}
        </button>
      </div>

      <div className="list-controls">
        <input
          className="form-input"
          placeholder="Search name, username or email"
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
                {classItem.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      <div className="table-card table-scroll-region">
        <table>
          <thead>
            <tr>
              {header("name", "Name")}
              {kind !== "admin" ? <th>Classes</th> : null}
              {hasBudget ? header("budget", "Budget") : null}
              {header("lastLogin", "Last sign-in")}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((user) => {
              const isSelf = user.username.toLowerCase() === String(authUser?.username ?? "").toLowerCase();
              return (
                <tr key={user.id} className={user.status === "disabled" ? "row-disabled" : undefined}>
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
                  </td>
                  {kind !== "admin" ? (
                    <td>{user.classes.map((classItem) => classItem.name).join(", ") || "—"}</td>
                  ) : null}
                  {hasBudget ? (
                    <td>
                      {kind === "teacher" ? (
                        <>
                          <BudgetCell user={user} target="pool" balance={user.poolBalance ?? 0} label="pool" onChanged={onChanged} />
                          <div>
                            <BudgetCell user={user} target="personal" balance={user.personalBalance} label="personal" onChanged={onChanged} />
                          </div>
                        </>
                      ) : (
                        <BudgetCell user={user} target="personal" balance={user.personalBalance} onChanged={onChanged} />
                      )}
                    </td>
                  ) : null}
                  <td className="mono-sm">
                    {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString() : "never"}
                  </td>
                  <td>
                    <div className="row-actions">
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => onEdit(user)}>
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
                        onClick={() => onToggleStatus(user)}
                      >
                        {user.status === "active" ? "Disable" : "Enable"}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="form-hint">
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
