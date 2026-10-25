import { useEffect, useRef, useState } from "react";
import {
  createAdminUser,
  resetAdminUserPassword,
  unlockAdminUser,
  updateAdminUser,
} from "../api/client";
import CredentialsNotice from "./CredentialsNotice";
import UserList from "./UserList";

const allRoles = ["student", "teacher", "admin"];
const emptyForm = { username: "", fullName: "", email: "", roles: ["student"] };

export default function AdminUsersPanel({ users, classes, authUser, onChanged }) {
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState(null); // user being edited, or null when adding
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [credentials, setCredentials] = useState(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const formRef = useRef(null);

  // The form opens above the lists; bring it into view from wherever the button was.
  useEffect(() => {
    if (isFormOpen) {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [isFormOpen, editing]);

  function openAdd(role = "student") {
    setEditing(null);
    setForm({ ...emptyForm, roles: [role] });
    setIsFormOpen(true);
    setError("");
  }

  async function onToggleStatus(user) {
    const disabling = user.status === "active";
    await run(
      () => updateAdminUser(user.id, { status: disabling ? "disabled" : "active" }),
      `${disabling ? "Disabled" : "Enabled"} ${user.username}`,
    );
  }

  function openEdit(user) {
    setEditing(user);
    setForm({
      username: user.username,
      fullName: user.fullName,
      email: user.email || "",
      roles: user.roles,
    });
    setIsFormOpen(true);
    setError("");
  }

  function closeForm() {
    setIsFormOpen(false);
    setEditing(null);
  }

  function toggleRole(role) {
    setForm((current) => ({
      ...current,
      roles: current.roles.includes(role)
        ? current.roles.filter((existing) => existing !== role)
        : [...current.roles, role],
    }));
  }

  // Runs an action, then refreshes; shows the server's message on failure.
  async function run(action, successMessage) {
    setIsBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await action();
      if (successMessage) {
        setMessage(successMessage);
      }
      onChanged();
      return result;
    } catch (nextError) {
      setError(nextError.message || "Request failed");
      return null;
    } finally {
      setIsBusy(false);
    }
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (editing) {
      const saved = await run(
        () => updateAdminUser(editing.id, { fullName: form.fullName, email: form.email, roles: form.roles }),
        `Saved ${editing.username}`,
      );
      if (saved) {
        closeForm();
      }
      return;
    }

    const created = await run(() => createAdminUser(form), `Created ${form.username}`);
    if (created) {
      setCredentials({ username: created.username, password: created.password });
      setForm(emptyForm);
      closeForm();
    }
  }

  async function onResetPassword(user) {
    if (!window.confirm(`Reset the password for ${user.username}? They will be signed out everywhere.`)) {
      return;
    }
    const result = await run(() => resetAdminUserPassword(user.id), "");
    if (result) {
      setCredentials({ username: result.username, password: result.password });
    }
  }

  const shared = {
    classes,
    authUser,
    isBusy,
    onAdd: openAdd,
    onEdit: openEdit,
    onResetPassword,
    onToggleStatus,
    onChanged,
  };

  return (
    <>
      <div className="admin-section">
      {credentials ? (
        <CredentialsNotice {...credentials} onDismiss={() => setCredentials(null)} />
      ) : null}
      {message ? <div className="notice-ok">{message}</div> : null}
      {error ? <div className="repo-error">{error}</div> : null}

      {isFormOpen ? (
        <form className="inline-form" ref={formRef} onSubmit={onSubmit}>
          <h3 className="panel-title form-group full">{editing ? `Edit ${editing.username}` : "Add user"}</h3>
          <div className="form-group">
            <label className="form-label" htmlFor="user-username">Username</label>
            <input
              id="user-username"
              className="form-input"
              value={form.username}
              disabled={Boolean(editing)}
              required
              autoComplete="off"
              onChange={(event) => setForm({ ...form, username: event.target.value })}
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="user-fullname">Full name</label>
            <input
              id="user-fullname"
              className="form-input"
              value={form.fullName}
              required
              onChange={(event) => setForm({ ...form, fullName: event.target.value })}
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="user-email">Email (optional)</label>
            <input
              id="user-email"
              className="form-input"
              type="email"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
            />
          </div>
          <div className="form-group">
            <span className="form-label">Roles</span>
            <div className="check-row">
              {allRoles.map((role) => (
                <label key={role}>
                  <input
                    type="checkbox"
                    checked={form.roles.includes(role)}
                    onChange={() => toggleRole(role)}
                  />
                  {role}
                </label>
              ))}
            </div>
          </div>
          <div className="form-actions full">
            <button type="submit" className="btn btn-primary btn-sm" disabled={isBusy || form.roles.length === 0}>
              {editing ? "Save changes" : "Create user"}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={closeForm}>
              Cancel
            </button>
            {editing ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={isBusy}
                onClick={() => run(() => unlockAdminUser(editing.id), `Cleared the sign-in lockout for ${editing.username}`)}
              >
                Clear lockout
              </button>
            ) : (
              <span className="form-hint">A random password is generated and shown once.</span>
            )}
          </div>
        </form>
      ) : null}

      </div>

      <UserList id="admin-students" title="Students" kind="student" users={users.filter((user) => user.roles.includes("student"))} {...shared} />
      <UserList id="admin-teachers" title="Teachers" kind="teacher" users={users.filter((user) => user.roles.includes("teacher"))} {...shared} />
      <UserList id="admin-admins" title="Admins" kind="admin" users={users.filter((user) => user.roles.includes("admin"))} {...shared} />
    </>
  );
}
