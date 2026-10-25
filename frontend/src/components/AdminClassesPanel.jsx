import { useState } from "react";
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

function ClassCard({ classItem, users, run, isBusy }) {
  const [isEditing, setIsEditing] = useState(false);
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

  return (
    <article className="result-card">
      <div className="result-card-head">
        <div className="result-job-name">{classItem.name}</div>
        <span className="status-pill queued">
          <span className="sdot" />
          {classItem.students.length} student{classItem.students.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="form-hint">{classItem.term || "No term set"}</div>

      {isEditing ? (
        <div className="class-member-add">
          <input className="form-input" aria-label="Class name" value={name} onChange={(event) => setName(event.target.value)} />
          <input className="form-input" aria-label="Term" value={term} onChange={(event) => setTerm(event.target.value)} />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={isBusy || !name.trim()}
            onClick={async () => {
              const saved = await run(() => updateAdminClass(classItem.id, { name, term }), `Saved ${name}`);
              if (saved) {
                setIsEditing(false);
              }
            }}
          >
            Save
          </button>
        </div>
      ) : null}

      <div className="panel-head subhead">
        <h3 className="panel-title">Teachers</h3>
      </div>
      <table>
        <tbody>
          {classItem.teachers.map((teacher) => (
            <tr key={teacher.id}>
              <td>
                {teacher.fullName}
                <div className="form-hint mono-sm">{teacher.username}</div>
              </td>
              <td>{removeButton(teacher)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <MemberAdder
        label="Add a teacher..."
        role="teacher"
        candidates={usersWithRole("teacher")}
        disabled={isBusy}
        onAdd={(userId, role) => run(() => addAdminClassMember(classItem.id, userId, role), "Teacher added")}
      />

      <div className="panel-head subhead">
        <h3 className="panel-title">Students</h3>
      </div>
      <table>
        <tbody>
          {classItem.students.map((student) => (
            <tr key={student.id}>
              <td>
                {student.fullName}
                <div className="form-hint mono-sm">{student.username}</div>
              </td>
              <td>{formatDollars(student.balance)}</td>
              <td>{removeButton(student)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <MemberAdder
        label="Add a student..."
        role="student"
        candidates={usersWithRole("student")}
        disabled={isBusy}
        onAdd={(userId, role) => run(() => addAdminClassMember(classItem.id, userId, role), "Student added")}
      />

      <div className="form-actions" style={{ marginTop: 12 }}>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setIsEditing((current) => !current)}>
          {isEditing ? "Cancel rename" : "Rename"}
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
    </article>
  );
}

export default function AdminClassesPanel({ classes, users, onChanged }) {
  const [form, setForm] = useState({ name: "", term: "", teacherId: "" });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);

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
    }
  }

  const teachers = users.filter((user) => user.status === "active" && user.roles.includes("teacher"));

  return (
    <section className="panel admin-section" id="admin-classes">
      <div className="panel-head">
        <h2 className="panel-title">Classes</h2>
      </div>

      {message ? <div className="notice-ok">{message}</div> : null}
      {error ? <div className="repo-error">{error}</div> : null}

      <form className="inline-form" onSubmit={onCreate}>
        <div className="form-group">
          <label className="form-label" htmlFor="class-name">Class name</label>
          <input
            id="class-name"
            className="form-input"
            value={form.name}
            required
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
        <div className="form-actions">
          <button type="submit" className="btn btn-primary btn-sm" disabled={isBusy}>
            Create class
          </button>
        </div>
      </form>

      {classes.length === 0 ? <div className="form-hint">No classes yet.</div> : null}
      <div className="results-grid">
        {classes.map((classItem) => (
          <ClassCard key={classItem.id} classItem={classItem} users={users} run={run} isBusy={isBusy} />
        ))}
      </div>
    </section>
  );
}
