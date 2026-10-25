import { useState } from "react";
import { adjustAdminBudget } from "../api/client";
import { formatDollars } from "../utils/format";

const roundCents = (value) => Math.round(value * 100) / 100;

// A balance that can be changed in place: click it, choose add or remove,
// enter an amount, review, confirm. target is "personal" or "pool".
export default function BudgetCell({ user, target, balance, label, onChanged }) {
  const [step, setStep] = useState("idle"); // idle | edit | confirm
  const [direction, setDirection] = useState("increase");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  const value = roundCents(Number(amount));
  const isValidAmount = Number.isFinite(value) && value > 0;
  const nextBalance = direction === "increase" ? roundCents(balance + value) : roundCents(balance - value);
  const wouldOverdraw = direction === "decrease" && isValidAmount && nextBalance < 0;

  function close() {
    setStep("idle");
    setAmount("");
    setNote("");
    setError("");
    setDirection("increase");
  }

  async function apply() {
    setIsBusy(true);
    setError("");
    try {
      await adjustAdminBudget({ userId: user.id, target, direction, amount: value, note });
      close();
      onChanged();
    } catch (nextError) {
      setError(nextError.message || "Request failed");
      setStep("edit");
    } finally {
      setIsBusy(false);
    }
  }

  if (step === "idle") {
    return (
      <button
        type="button"
        className="budget-link"
        title={`Change ${user.fullName}'s ${target === "pool" ? "pool" : "budget"}`}
        onClick={() => setStep("edit")}
      >
        {formatDollars(balance)}
        {label ? <span className="form-hint"> {label}</span> : null}
      </button>
    );
  }

  const who = `${user.fullName}'s ${target === "pool" ? "class pool" : "budget"}`;

  return (
    <div className="budget-editor">
      <div className="form-hint">
        {who}: {formatDollars(balance)}
      </div>
      {error ? <div className="repo-error">{error}</div> : null}

      {step === "edit" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (isValidAmount && !wouldOverdraw) {
              setStep("confirm");
            }
          }}
        >
          <div className="segmented" role="group" aria-label="Add or remove">
            <button
              type="button"
              className={direction === "increase" ? "active" : ""}
              onClick={() => setDirection("increase")}
            >
              + Add
            </button>
            <button
              type="button"
              className={direction === "decrease" ? "active" : ""}
              onClick={() => setDirection("decrease")}
            >
              − Remove
            </button>
          </div>
          <input
            className="form-input"
            type="number"
            min="0.01"
            max="100000"
            step="0.01"
            placeholder="Amount ($)"
            aria-label="Amount in dollars"
            autoFocus
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
          <input
            className="form-input"
            maxLength={200}
            placeholder="Note (optional)"
            aria-label="Note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          {wouldOverdraw ? <div className="form-hint">Can&apos;t remove more than {formatDollars(balance)}.</div> : null}
          <div className="row-actions">
            <button type="submit" className="btn btn-primary btn-sm" disabled={!isValidAmount || wouldOverdraw}>
              Review
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <div>
            {direction === "increase" ? "Add" : "Remove"} <strong>{formatDollars(value)}</strong>?
            <div className="form-hint">
              {formatDollars(balance)} → {formatDollars(nextBalance)}
            </div>
          </div>
          <div className="row-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={isBusy} onClick={apply}>
              Confirm
            </button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={isBusy} onClick={() => setStep("edit")}>
              Back
            </button>
          </div>
        </>
      )}
    </div>
  );
}
