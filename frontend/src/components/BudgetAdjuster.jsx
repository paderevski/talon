import { useState } from "react";
import { parseAmount } from "../utils/budget";
import { formatDollars } from "../utils/format";

// One balance changed in place: type an amount, then Add or Subtract. Each
// button is enabled only when that move is possible (addLimit: what the
// source can give, e.g. the teacher's pool; subtractLimit: what can be taken
// out), and says why when it is not; the server checks again.
// onAdjust(direction "add" | "subtract", amount) returns a promise; an error
// is shown under the control, success clears the amount.
export default function BudgetAdjuster({ who, balance, addLimit = null, subtractLimit, onAdjust, disabled = false }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  const amount = parseAmount(text);
  const typed = text.trim() !== "";
  const limit = Math.max(0, subtractLimit ?? balance ?? 0);
  const addProblem = !amount ? null : addLimit !== null && amount > addLimit ? `Your pool has only ${formatDollars(addLimit)}` : null;
  const subtractProblem = !amount ? null : amount > limit ? `At most ${formatDollars(limit)} can be taken out` : null;
  const canAdd = Boolean(amount) && !addProblem && !disabled && !isBusy;
  const canSubtract = Boolean(amount) && !subtractProblem && !disabled && !isBusy;

  async function run(direction) {
    setIsBusy(true);
    setError("");
    try {
      await onAdjust(direction, amount);
      setText("");
    } catch (nextError) {
      setError(nextError.message || "Could not change the balance");
    } finally {
      setIsBusy(false);
    }
  }

  let hint = "";
  if (typed && !amount) {
    hint = "Enter dollars, e.g. 5 or 2.50";
  } else if (addProblem && subtractProblem) {
    hint = `${addProblem}; ${subtractProblem.toLowerCase()}`;
  } else {
    hint = addProblem || subtractProblem || "";
  }

  return (
    <div className="budget-adjuster">
      <div className="budget-adjuster-row">
        <span className="budget-adjuster-balance">{formatDollars(balance ?? 0)}</span>
        <input
          className="form-input"
          inputMode="decimal"
          placeholder="$"
          aria-label={`Dollars to add or subtract for ${who}`}
          value={text}
          disabled={disabled}
          onChange={(event) => {
            setText(event.target.value);
            setError("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
            }
          }}
        />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={!canAdd}
          title={addProblem || undefined}
          aria-label={`Add${amount ? ` ${formatDollars(amount)}` : ""} for ${who}`}
          onClick={() => run("add")}
        >
          + Add
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={!canSubtract}
          title={subtractProblem || undefined}
          aria-label={`Subtract${amount ? ` ${formatDollars(amount)}` : ""} for ${who}`}
          onClick={() => run("subtract")}
        >
          − Subtract
        </button>
      </div>
      {error ? <div className="repo-error budget-adjuster-msg">{error}</div> : null}
      {!error && hint ? <div className="form-hint budget-adjuster-msg">{hint}</div> : null}
    </div>
  );
}
