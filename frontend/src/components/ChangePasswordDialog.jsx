import { useState } from "react";
import { changeOwnPassword } from "../api/client";

export default function ChangePasswordDialog({ onClose }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [isDone, setIsDone] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    setError("");
    if (next !== confirm) {
      setError("The new passwords do not match");
      return;
    }

    setIsBusy(true);
    try {
      await changeOwnPassword(current, next);
      setIsDone(true);
    } catch (nextError) {
      setError(nextError.message || "Unable to change password");
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Change password"
        onClick={(event) => event.stopPropagation()}
        onSubmit={onSubmit}
      >
        <h2 className="panel-title">Change password</h2>
        {isDone ? (
          <>
            <div className="notice-ok">Password changed. Your other sessions were signed out.</div>
            <div className="form-actions">
              <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            {error ? <div className="repo-error">{error}</div> : null}
            <div className="form-group">
              <label className="form-label" htmlFor="pw-current">Current password</label>
              <input id="pw-current" className="form-input" type="password" autoComplete="current-password" required value={current} onChange={(event) => setCurrent(event.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="pw-new">New password (8+ characters)</label>
              <input id="pw-new" className="form-input" type="password" autoComplete="new-password" minLength={8} required value={next} onChange={(event) => setNext(event.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="pw-confirm">Confirm new password</label>
              <input id="pw-confirm" className="form-input" type="password" autoComplete="new-password" required value={confirm} onChange={(event) => setConfirm(event.target.value)} />
            </div>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary btn-sm" disabled={isBusy}>
                Change password
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
