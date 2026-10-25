import { useState } from "react";
import { grantAdminBudget } from "../api/client";
import { formatDollars } from "../utils/format";

export default function AdminBudgetsPanel({ users, onChanged }) {
  const [form, setForm] = useState({ userId: "", target: "pool", amount: "", note: "" });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  const active = users.filter((user) => user.status === "active");
  const candidates = form.target === "pool" ? active.filter((user) => user.roles.includes("teacher")) : active;
  const teachers = users.filter((user) => user.poolBalance !== null && user.roles.includes("teacher"));

  async function onSubmit(event) {
    event.preventDefault();
    setIsBusy(true);
    setError("");
    setMessage("");
    try {
      await grantAdminBudget({
        userId: form.userId,
        target: form.target,
        amount: Number(form.amount),
        note: form.note,
      });
      const person = users.find((user) => user.id === form.userId);
      setMessage(
        `Added ${formatDollars(form.amount)} to ${person?.fullName || "user"}'s ${
          form.target === "pool" ? "class pool" : "personal budget"
        }`,
      );
      setForm({ ...form, amount: "", note: "" });
      onChanged();
    } catch (nextError) {
      setError(nextError.message || "Request failed");
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <section className="panel admin-section" id="admin-budgets">
      <div className="panel-head">
        <h2 className="panel-title">Budgets</h2>
      </div>

      {message ? <div className="notice-ok">{message}</div> : null}
      {error ? <div className="repo-error">{error}</div> : null}

      <form className="inline-form" onSubmit={onSubmit}>
        <div className="form-group">
          <label className="form-label" htmlFor="grant-target">Add money to</label>
          <select
            id="grant-target"
            className="form-select"
            value={form.target}
            onChange={(event) => setForm({ ...form, target: event.target.value, userId: "" })}
          >
            <option value="pool">A teacher&apos;s pool (they hand it out)</option>
            <option value="personal">Someone&apos;s personal budget</option>
          </select>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="grant-user">Person</label>
          <select
            id="grant-user"
            className="form-select"
            value={form.userId}
            required
            onChange={(event) => setForm({ ...form, userId: event.target.value })}
          >
            <option value="">Choose...</option>
            {candidates.map((user) => (
              <option key={user.id} value={user.id}>
                {user.fullName} ({user.username})
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="grant-amount">Amount (USD)</label>
          <input
            id="grant-amount"
            className="form-input"
            type="number"
            min="0.01"
            max="100000"
            step="0.01"
            required
            value={form.amount}
            onChange={(event) => setForm({ ...form, amount: event.target.value })}
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="grant-note">Note (optional)</label>
          <input
            id="grant-note"
            className="form-input"
            maxLength={200}
            value={form.note}
            onChange={(event) => setForm({ ...form, note: event.target.value })}
          />
        </div>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary btn-sm" disabled={isBusy || !form.userId || !form.amount}>
            Add money
          </button>
        </div>
      </form>

      <div className="table-card table-scroll-region">
        <table>
          <thead>
            <tr>
              <th>Teacher</th>
              <th>Pool</th>
            </tr>
          </thead>
          <tbody>
            {teachers.map((teacher) => (
              <tr key={teacher.id}>
                <td>
                  {teacher.fullName}
                  <div className="form-hint mono-sm">{teacher.username}</div>
                </td>
                <td>{formatDollars(teacher.poolBalance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
