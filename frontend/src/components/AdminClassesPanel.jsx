import { Fragment, useMemo, useState } from "react";
import {
  addAdminClassMember,
  createAdminClass,
  removeAdminClassMember,
  updateAdminClass,
} from "../api/client";
import { formatDollars } from "../utils/format";

function MemberAdder({ label, role, candidates, onAdd, disabled }) {
  const [userId, setUserId] = useState("");

  return (
    <div className="class-member-add">
      <select
        className="form-select"
        aria-label={label}
        value={userId}
        onChange={(event) => setUserId(event.target.value)}
      >
        <option value="">{label}</option>
        {candidates.map((user) => (
          <option key={user.id} value={user.id}>
            {user.fullName} ({user.username})
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={!userId || disabled}
        onClick={async () => {
          await onAdd(userId, role);
          setUserId("");
        }}
      >
        Add
      </button>
    </div>
  );
}

// Everything you can change about one class: members, name/term, archive.
// Kept separate from the table so the drill-down style can change freely.
function ClassMembers({ classItem, users, run, isBusy }) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [name, setName] = useState(classItem.name);
  const [term, setTerm] = useState(classItem.term || "");

  const memberIds = new Set([...classItem.teachers, ...classItem.students].map((member) => member.id));
  const usersWithRole = (role) =>
    users.filter((user) => user.status === "active" && user.roles.includes(role) && !memberIds.has(user.id));

  const removeButton = (member) => (
    <button
      type="button"
      className="btn btn-secondary btn-sm"
      disabled={isBusy}
      onClick={() =>
        run(() => removeAdminClassMember(classItem.id, member.id), `Removed ${member.username} from ${classItem.name}`)
      }
    >
      Remove
    </button>
  );

  const memberRow = (member, extra) => (
    <tr key={member.id}>
      <td>
        {member.fullName}
        <div className="form-hint mono-sm">{member.username}</div>
      </td>
      {extra}
      <td className="cell-actions">{removeButton(member)}</td>
    </tr>
  );

  return (
    <div className="class-detail">
      <div className="class-detail-col">
        <h3 className="class-detail-title">Teachers</h3>
        <table>
          <tbody>
            {classItem.teachers.map((teacher) => memberRow(teacher))}
            {classItem.teachers.length === 0 ? (
              <tr><td className="form-hint">No teacher yet.</td></tr>
            ) : null}
          </tbody>
        </table>
        <MemberAdder
          label="Add a teacher..."
          role="teacher"
          candidates={usersWithRole("teacher")}
          disabled={isBusy}
          onAdd={(userId, role) => run(() => addAdminClassMember(classItem.id, userId, role), "Teacher added")}
        />

        <h3 className="class-detail-title">Class</h3>
        {isRenaming ? (
          <div className="class-member-add">
            <input className="form-input" aria-label="Class name" value={name} onChange={(event) => setName(event.target.value)} />
            <input className="form-input" aria-label="Term" placeholder="Term" value={term} onChange={(event) => setTerm(event.target.value)} />
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={isBusy || !name.trim()}
              onClick={async () => {
                const saved = await run(() => updateAdminClass(classItem.id, { name, term }), `Saved ${name}`);
                if (saved) {
                  setIsRenaming(false);
                }
              }}
            >
              Save
            </button>
          </div>
        ) : null}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setIsRenaming((current) => !current)}>
            {isRenaming ? "Cancel rename" : "Rename"}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={isBusy}
            onClick={() => {
              if (window.confirm(`Archive ${classItem.name}? Its teachers will stop seeing it.`)) {
                run(() => updateAdminClass(classItem.id, { archived: true }), `Archived ${classItem.name}`);
              }
            }}
          >
            Archive
          </button>
        </div>
      </div>

      <div className="class-detail-col">
        <h3 className="class-detail-title">Students ({classItem.students.length})</h3>
        <table>
          <tbody>
            {classItem.students.map((student) =>
              memberRow(student, <td className="cell-num">{formatDollars(student.balance)}</td>),
            )}
            {classItem.students.length === 0 ? (
              <tr><td className="form-hint">No students yet.</td></tr>
            ) : null}
          </tbody>
        </table>
        <MemberAdder
          label="Add a student..."
          role="student"
          candidates={usersWithRole("student")}
          disabled={isBusy}
          onAdd={(userId, role) => run(() => addAdminClassMember(classItem.id, userId, role), "Student added")}
        />
      </div>
    </div>
  );
}

const textCompare = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

const sorters = {
  className: (a, b) => textCompare(a.classItem.name, b.classItem.name),
  term: (a, b) => textCompare(a.classItem.term || "", b.classItem.term || ""),
  teacher: (a, b) => textCompare(a.teacher?.fullName || "￿", b.teacher?.fullName || "￿"),
  students: (a, b) => a.classItem.students.length - b.classItem.students.length,
  remaining: (a, b) => a.remaining - b.remaining,
};

// One row per (class, teacher). A class without a teacher still gets one row.
function toRows(classes) {
  return classes.flatMap((classItem) => {
    const remaining = classItem.students.reduce((sum, student) => sum + (student.balance || 0), 0);
    const teachers = classItem.teachers.length ? classItem.teachers : [null];
    return teachers.map((teacher) => ({
      key: `${classItem.id}:${teacher?.id ?? "none"}`,
      classItem,
      teacher,
      remaining,
    }));
  });
}

export default function AdminClassesPanel({ classes, users, onChanged }) {
  const [form, setForm] = useState({ name: "", term: "", teacherId: "" });
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [termFilter, setTermFilter] = useState("all");
  const [teacherFilter, setTeacherFilter] = useState("all");
  const [sort, setSort] = useState({ key: "className", dir: 1 });
  const [openKey, setOpenKey] = useState(null);

  async function run(action, successMessage) {
    setIsBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await action();
      setMessage(successMessage);
      onChanged();
      return result;
    } catch (nextError) {
      setError(nextError.message || "Request failed");
      return null;
    } finally {
      setIsBusy(false);
    }
  }

  async function onCreate(event) {
    event.preventDefault();
    const created = await run(
      () => createAdminClass({ name: form.name, term: form.term, teacherId: form.teacherId || undefined }),
      `Created ${form.name}`,
    );
    if (created) {
      setForm({ name: "", term: "", teacherId: "" });
      setIsFormOpen(false);
    }
  }

  const teachers = users.filter((user) => user.status === "active" && user.roles.includes("teacher"));
  const allRows = useMemo(() => toRows(classes), [classes]);
  const terms = useMemo(
    () => [...new Set(classes.map((classItem) => classItem.term || ""))].sort(textCompare),
    [classes],
  );
  const rowTeachers = useMemo(() => {
    const byId = new Map();
    allRows.forEach((row) => row.teacher && byId.set(row.teacher.id, row.teacher));
    return [...byId.values()].sort((a, b) => textCompare(a.fullName, b.fullName));
  }, [allRows]);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return allRows
      .filter((row) => termFilter === "all" || (row.classItem.term || "") === termFilter)
      .filter((row) => {
        if (teacherFilter === "all") return true;
        if (teacherFilter === "none") return !row.teacher;
        return String(row.teacher?.id) === teacherFilter;
      })
      .filter(
        (row) =>
          !needle ||
          [row.classItem.name, row.teacher?.fullName || "", row.teacher?.username || ""].some((value) =>
            value.toLowerCase().includes(needle),
          ),
      )
      .sort((a, b) => sort.dir * sorters[sort.key](a, b) || sorters.className(a, b) || sorters.teacher(a, b));
  }, [allRows, search, termFilter, teacherFilter, sort]);

  const isFiltered = search || termFilter !== "all" || teacherFilter !== "all";

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

  return (
    <section className="panel admin-section" id="admin-classes">
      <div className="panel-head">
        <h2 className="panel-title">
          Classes
          <span className="panel-count">{classes.length}</span>
        </h2>
      </div>

      {message ? <div className="notice-ok">{message}</div> : null}
      {error ? <div className="repo-error">{error}</div> : null}

      {isFormOpen ? (
        <form className="inline-form" onSubmit={onCreate}>
          <h3 className="panel-title form-group full">New class</h3>
          <div className="form-group">
            <label className="form-label" htmlFor="class-name">Class name</label>
            <input
              id="class-name"
              className="form-input"
              value={form.name}
              required
              autoFocus
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="class-term">Term</label>
            <input
              id="class-term"
              className="form-input"
              placeholder="2026-27"
              value={form.term}
              onChange={(event) => setForm({ ...form, term: event.target.value })}
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="class-teacher">Teacher</label>
            <select
              id="class-teacher"
              className="form-select"
              value={form.teacherId}
              onChange={(event) => setForm({ ...form, teacherId: event.target.value })}
            >
              <option value="">(add later)</option>
              {teachers.map((teacher) => (
                <option key={teacher.id} value={teacher.id}>
                  {teacher.fullName} ({teacher.username})
                </option>
              ))}
            </select>
          </div>
          <div className="form-actions full">
            <button type="submit" className="btn btn-primary btn-sm" disabled={isBusy}>
              Create class
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setIsFormOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <div className="list-controls">
        <input
          className="form-input"
          placeholder="Search class or teacher"
          aria-label="Search classes"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select className="form-select" aria-label="Filter by term" value={termFilter} onChange={(event) => setTermFilter(event.target.value)}>
          <option value="all">All terms</option>
          {terms.map((term) => (
            <option key={term} value={term}>{term || "No term"}</option>
          ))}
        </select>
        <select className="form-select" aria-label="Filter by teacher" value={teacherFilter} onChange={(event) => setTeacherFilter(event.target.value)}>
          <option value="all">All teachers</option>
          <option value="none">No teacher</option>
          {rowTeachers.map((teacher) => (
            <option key={teacher.id} value={String(teacher.id)}>{teacher.fullName}</option>
          ))}
        </select>
        <div className="list-controls-end">
          {isFiltered ? (
            <span className="list-match-count" aria-live="polite">
              {rows.length} of {allRows.length}
            </span>
          ) : null}
          {isFormOpen ? null : (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setIsFormOpen(true)}>
              Create class
            </button>
          )}
        </div>
      </div>

      <div className="table-card table-scroll-region">
        <table className="classes-table">
          <thead>
            <tr>
              {header("className", "Class")}
              {header("term", "Term")}
              {header("teacher", "Teacher")}
              {header("students", "Students", "cell-num")}
              {header("remaining", "Student budget left", "cell-num")}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isOpen = openKey === row.key;
              return (
                <Fragment key={row.key}>
                  <tr className={isOpen ? "row-open" : undefined}>
                    <td className="cell-strong">{row.classItem.name}</td>
                    <td className="mono-sm">{row.classItem.term || "—"}</td>
                    <td>
                      {row.teacher ? (
                        <>
                          {row.teacher.fullName}
                          <div className="form-hint mono-sm">{row.teacher.username}</div>
                        </>
                      ) : (
                        <span className="form-hint">No teacher</span>
                      )}
                    </td>
                    <td className="cell-num">{row.classItem.students.length}</td>
                    <td className="cell-num">{formatDollars(row.remaining)}</td>
                    <td className="cell-actions">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        aria-expanded={isOpen}
                        onClick={() => setOpenKey(isOpen ? null : row.key)}
                      >
                        {isOpen ? "Close" : "Manage"}
                      </button>
                    </td>
                  </tr>
                  {isOpen ? (
                    <tr className="row-detail">
                      <td colSpan={6}>
                        <ClassMembers classItem={row.classItem} users={users} run={run} isBusy={isBusy} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="form-hint">
                  {allRows.length === 0 ? "No classes yet." : "Nothing matches these filters."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
