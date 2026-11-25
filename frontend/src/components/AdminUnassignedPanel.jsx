import { useMemo, useState } from "react";
import { assignAdminStudents } from "../api/client";
import { formatClassName, formatDollars } from "../utils/format";

// Students who are in no active class: usually someone whose first
// "Sign in with Microsoft" created their account before anyone set them up.
// Pick several, choose a class and an optional starting budget, Assign.
export function unassignedStudents(users) {
  return users.filter(
    (user) =>
      user.status === "active"
      && user.roles.includes("student")
      && !(user.classes || []).some((classItem) => classItem.memberRole === "student"),
  );
}

const signInLabel = (user) => {
  const methods = user.signIn || [];
  const labels = [methods.includes("entra") && "Microsoft", methods.includes("local") && "Password"].filter(Boolean);
  return labels.join(" + ") || "None";
};

const dateText = (value) => (value ? new Date(value).toLocaleDateString() : "never");

export default function AdminUnassignedPanel({ users, classes, onChanged }) {
  const [selected, setSelected] = useState(() => new Set());
  const [classId, setClassId] = useState("");
  const [budget, setBudget] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  // Newest first: the ones who just signed in are what you are looking for.
  const students = useMemo(
    () => unassignedStudents(users).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))),
    [users],
  );
  const activeClasses = useMemo(
    () =>
      classes
        .filter((classItem) => !classItem.archived)
        .sort((a, b) => formatClassName(a.name, a.block).localeCompare(formatClassName(b.name, b.block))),
    [classes],
  );

  // Selection only of students still listed (others were assigned meanwhile).
  const listedIds = new Set(students.map((student) => student.id));
  const chosen = [...selected].filter((id) => listedIds.has(id));
  const allChosen = students.length > 0 && chosen.length === students.length;

  function toggle(id) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function onAssign(event) {
    event.preventDefault();
    setMessage("");
    setError("");
    setIsBusy(true);
    try {
      const target = activeClasses.find((classItem) => String(classItem.id) === classId);
      const result = await assignAdminStudents(classId, chosen, budget);
      const who = result.added === 1 ? "1 student" : `${result.added} students`;
      const money = result.grantedDollars > 0 ? `, ${formatDollars(result.grantedDollars)} each` : "";
      setMessage(`Added ${who} to ${formatClassName(target?.name ?? "the class", target?.block)}${money}`);
      setSelected(new Set());
      setBudget("");
      onChanged();
    } catch (nextError) {
      setError(nextError.message || "Request failed");
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <section className="panel admin-section" id="admin-unassigned">
      <div className="panel-head">
        <h2 className="panel-title">
          Students not in a class
          <span className="panel-count">{students.length}</span>
        </h2>
      </div>
      <p className="form-hint">
        These students can sign in but cannot run jobs: they have no class and usually no budget. Most are new
        Microsoft sign-ins. Choose them, pick a class, and give a starting budget (or leave it empty and let the
        teacher allocate from their pool).
      </p>

      {message ? <div className="notice-ok">{message}</div> : null}
      {error ? <div className="repo-error">{error}</div> : null}

      {students.length === 0 ? (
        <div className="form-hint">Every active student is in a class.</div>
      ) : (
        <>
          <form className="inline-form" onSubmit={onAssign}>
            <div className="form-group">
              <label className="form-label" htmlFor="unassigned-class">Class</label>
              <select
                id="unassigned-class"
                className="form-select"
                value={classId}
                required
                onChange={(event) => setClassId(event.target.value)}
              >
                <option value="">Choose a class</option>
                {activeClasses.map((classItem) => (
                  <option key={classItem.id} value={classItem.id}>
                    {formatClassName(classItem.name, classItem.block)}
                    {classItem.teacher ? ` (${classItem.teacher.fullName})` : " (no teacher)"}
                    {classItem.term ? `, ${classItem.term}` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="unassigned-budget">Starting budget each ($, optional)</label>
              <input
                id="unassigned-budget"
                className="form-input"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                placeholder="0"
                value={budget}
                onChange={(event) => setBudget(event.target.value)}
              />
            </div>
            <div className="form-group form-actions">
              <button type="submit" className="btn btn-primary" disabled={isBusy || chosen.length === 0 || !classId}>
                {isBusy
                  ? "Assigning..."
                  : chosen.length
                    ? `Assign ${chosen.length} ${chosen.length === 1 ? "student" : "students"}`
                    : "Assign"}
              </button>
            </div>
          </form>

          <div className="table-card table-scroll-region">
            <table>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Choose all"
                      checked={allChosen}
                      onChange={() => setSelected(allChosen ? new Set() : new Set(students.map((student) => student.id)))}
                    />
                  </th>
                  <th>Student</th>
                  <th>Email</th>
                  <th>Signs in with</th>
                  <th>Account made</th>
                  <th>Last sign-in</th>
                  <th className="cell-num">Budget</th>
                </tr>
              </thead>
              <tbody>
                {students.map((student) => (
                  <tr key={student.id} className={selected.has(student.id) ? "row-open" : undefined}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Choose ${student.fullName}`}
                        checked={selected.has(student.id)}
                        onChange={() => toggle(student.id)}
                      />
                    </td>
                    <td>
                      {student.fullName}
                      <div className="form-hint mono-sm">{student.username}</div>
                    </td>
                    <td className="mono-sm">{student.email || "—"}</td>
                    <td>{signInLabel(student)}</td>
                    <td>{dateText(student.createdAt)}</td>
                    <td>{dateText(student.lastLoginAt)}</td>
                    <td className="cell-num">{formatDollars(student.personalBalance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
