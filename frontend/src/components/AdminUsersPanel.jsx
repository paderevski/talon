import { useState } from "react";
import {
  createAdminUser,
  resetAdminUserPassword,
  unlockAdminUser,
  updateAdminUser,
} from "../api/client";
import { formatDollars } from "../utils/format";
import CredentialsNotice from "./CredentialsNotice";

const allRoles = ["student", "teacher", "admin"];
const emptyForm = { username: "", fullName: "", email: "", roles: ["student"] };

export default function AdminUsersPanel({ users, authUser, onChanged }) {
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState(null); // user being edited, or null when adding
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [credentials, setCredentials] = useState(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [search, setSearch] = useState("");

  const needle = search.trim().toLowerCase();
  const visibleUsers = needle
    ? users.filter((user) =>
        [user.fullName, user.username, user.email || ""].some((value) => value.toLowerCase().includes(needle)),
      )
    : users;

  function openAdd() {
    setEditing(null);
    setForm(emptyForm);
    setIsFormOpen(true);
    setError("");
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

  return (
    <section className="panel admin-section" id="admin-users">
      <div className="panel-head">
        <h2 className="panel-title">Users</h2>
        <button type="button" className="btn btn-primary btn-sm" onClick={openAdd}>
          Add user
        </button>
      </div>

      {credentials ? (
        <CredentialsNotice {...credentials} onDismiss={() => setCredentials(null)} />
      ) : null}
      {message ? <div className="notice-ok">{message}</div> : null}
      {error ? <div className="repo-error">{error}</div> : null}

      {isFormOpen ? (
        <form className="inline-form" onSubmit={onSubmit}>
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

      <div className="form-group" style={{ marginBottom: 10, maxWidth: 320 }}>
        <input
          className="form-input"
          placeholder="Search name, username or email"
          aria-label="Search users"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <div className="table-card table-scroll-region">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Roles</th>
              <th>Classes</th>
              <th>Budget</th>
              <th>Last sign-in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visibleUsers.map((user) => {
              const isSelf = user.username.toLowerCase() === String(authUser?.username ?? "").toLowerCase();
              return (
                <tr key={user.id} className={user.status === "disabled" ? "row-disabled" : undefined}>
                  <td>
                    {user.fullName}
                    <div className="form-hint mono-sm">{user.username}</div>
                    {user.status === "disabled" ? <div className="form-hint">Disabled</div> : null}
                  </td>
                  <td>
                    {user.roles.map((role) => (
                      <span key={role} className={`role-chip ${role}`}>{role}</span>
                    ))}
                  </td>
                  <td>{user.classes.map((classItem) => classItem.name).join(", ") || "—"}</td>
                  <td>
                    {formatDollars(user.personalBalance)}
                    {user.poolBalance !== null ? (
                      <div className="form-hint">pool {formatDollars(user.poolBalance)}</div>
                    ) : null}
                  </td>
                  <td className="mono-sm">
                    {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString() : "never"}
                  </td>
                  <td>
                    <div className="row-actions">
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => openEdit(user)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={isBusy}
                        onClick={() => onResetPassword(user)}
                      >
                        Reset password
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={isBusy || isSelf}
                        title={isSelf ? "You cannot disable your own account" : undefined}
                        onClick={() =>
                          run(
                            () => updateAdminUser(user.id, { status: user.status === "active" ? "disabled" : "active" }),
                            `${user.status === "active" ? "Disabled" : "Enabled"} ${user.username}`,
                          )
                        }
                      >
                        {user.status === "active" ? "Disable" : "Enable"}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
