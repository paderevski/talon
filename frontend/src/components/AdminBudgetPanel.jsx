import { useEffect, useMemo, useState } from "react";
import { adjustAdminBudget, fetchAdminUserBudget } from "../api/client";
import { parseAmount } from "../utils/budget";
import { formatClassName, formatDollars } from "../utils/format";

// An admin changes one user's budget, in the expanded row under them. Left:
// where their money stands (now and this school year) and where it could
// come from. Right: add or take back an amount, from or to the School account
// or one of their teachers' pools, previewed, then confirmed by a button that
// says exactly what will happen. Teachers also have a pool, chosen by a switch.
// initialAccount: "pool" or "personal" to start on (default: a teacher who is
// not also a student starts on their pool).
// notice: why the panel opened (e.g. Disable needs the money back first).
export default function AdminBudgetPanel({ user, initialAccount, notice = "", onClose, onChanged }) {
  const isTeacher = user.roles.includes("teacher");
  const [details, setDetails] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [version, setVersion] = useState(0);
  const [account, setAccount] = useState(
    isTeacher && (initialAccount ?? (user.roles.includes("student") ? "personal" : "pool")) === "pool" ? "pool" : "personal",
  );
  const [direction, setDirection] = useState(notice ? "decrease" : "increase");
  const [source, setSource] = useState("school"); // "school" or a teacher's id
  const [amountText, setAmountText] = useState("");
  const [note, setNote] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchAdminUserBudget(user.id)
      .then((next) => {
        if (!cancelled) {
          setDetails(next);
          setLoadError("");
        }
      })
      .catch((nextError) => {
        if (!cancelled) {
          setLoadError(nextError.message || "Could not load this budget");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [user.id, version]);

  // Pools fund only personal budgets; a teacher's own pool is School-funded.
  const teachers = details?.teachers ?? [];
  const sourceTeacher = account === "personal" ? teachers.find((teacher) => teacher.id === source) ?? null : null;
  useEffect(() => {
    if (source !== "school" && !sourceTeacher && details) {
      setSource("school");
    }
  }, [source, sourceTeacher, details]);

  const amount = parseAmount(amountText);
  const targetBalance = details ? (account === "pool" ? details.pool?.balance ?? 0 : details.personal.balance) : 0;
  const sourceName = sourceTeacher ? `${sourceTeacher.fullName}'s pool` : "School";
  const sourceBalance = sourceTeacher ? sourceTeacher.poolBalance : details?.school ?? 0;
  const targetName = account === "pool" ? `${user.fullName}'s pool` : user.fullName;
  const adding = direction === "increase";

  const problem = useMemo(() => {
    if (amountText.trim() && !amount) return "Enter dollars, e.g. 5 or 2.50";
    if (!amount || !details) return "";
    if (adding && amount > sourceBalance) return `${sourceName} has only ${formatDollars(sourceBalance)}`;
    if (!adding && amount > Math.max(targetBalance, 0)) {
      return `At most ${formatDollars(Math.max(targetBalance, 0))} can be taken back (spent money and running jobs' reservations can't be)`;
    }
    return "";
  }, [amountText, amount, details, adding, sourceBalance, sourceName, targetBalance]);

  const canConfirm = Boolean(amount) && !problem && !isBusy && Boolean(details);
  const delta = amount && !problem ? (adding ? amount : -amount) : 0;

  async function confirm() {
    setIsBusy(true);
    setError("");
    setDone("");
    try {
      await adjustAdminBudget({
        userId: user.id,
        target: account,
        direction,
        amount,
        note: note.trim() || undefined,
        fromTeacherId: sourceTeacher ? sourceTeacher.id : undefined,
      });
      setDone(
        adding
          ? `Added ${formatDollars(amount)} to ${targetName} from ${sourceName}.`
          : `Took back ${formatDollars(amount)} from ${targetName} to ${sourceName}.`,
      );
      setAmountText("");
      setNote("");
      setVersion((current) => current + 1);
      onChanged();
    } catch (nextError) {
      setError(nextError.message || "Could not change the budget");
    } finally {
      setIsBusy(false);
    }
  }

  if (loadError) {
    return <div className="budget-panel"><div className="repo-error">{loadError}</div></div>;
  }
  if (!details) {
    return <div className="budget-panel"><div className="form-hint">Loading budget…</div></div>;
  }

  const personal = details.personal;
  return (
    <div className="budget-panel">
      {notice ? <div className="notice-warn budget-panel-notice" role="status">{notice}</div> : null}
      <div className="budget-panel-facts">
        <div className="budget-panel-figure">
          <span className="budget-stat-label">{account === "pool" ? "Pool left" : "Budget left"}</span>
          <span className="budget-panel-amount">{formatDollars(targetBalance)}</span>
        </div>
        <dl className="budget-panel-list">
          {account === "pool" ? (
            <>
              <dt>Received this school year</dt>
              <dd>{formatDollars(details.pool.receivedThisYear)}</dd>
              <dt>Handed out this school year</dt>
              <dd>{formatDollars(details.pool.handedOutThisYear)}</dd>
            </>
          ) : (
            <>
              <dt>Received this school year</dt>
              <dd>{formatDollars(personal.receivedThisYear)}</dd>
              <dt>Spent this school year</dt>
              <dd>{formatDollars(personal.spentThisYear)}</dd>
              {personal.movedOutThisYear > 0 ? (
                <>
                  <dt>Taken back this school year</dt>
                  <dd>{formatDollars(personal.movedOutThisYear)}</dd>
                </>
              ) : null}
              {personal.setAsideForRunningJobs > 0 ? (
                <>
                  <dt>Set aside for running jobs</dt>
                  <dd>{formatDollars(personal.setAsideForRunningJobs)}</dd>
                </>
              ) : null}
            </>
          )}
        </dl>
        <span className="budget-stat-label budget-panel-sources-title">{adding ? "Can come from" : "Can go back to"}</span>
        <dl className="budget-panel-list">
          {account === "personal"
            ? teachers.map((teacher) => (
                <FragmentRow
                  key={teacher.id}
                  label={`${teacher.fullName}'s pool`}
                  hint={teacher.classes.map((classItem) => formatClassName(classItem.name, classItem.block)).join(", ")}
                  value={formatDollars(teacher.poolBalance)}
                />
              ))
            : null}
          <dt>School account</dt>
          <dd>{formatDollars(details.school)}</dd>
        </dl>
      </div>

      <div className="budget-panel-action">
        <div className="budget-panel-switches">
        {isTeacher ? (
          <Segmented
            label="Account"
            value={account}
            onChange={(next) => {
              setAccount(next);
              setDone("");
            }}
            options={[
              ["pool", "Pool (for students)"],
              ["personal", "Own budget"],
            ]}
          />
        ) : null}
        <Segmented
          label="Change"
          value={direction}
          onChange={(next) => {
            setDirection(next);
            setDone("");
          }}
          options={[
            ["increase", "Add"],
            ["decrease", "Take back"],
          ]}
        />
        </div>
        <div className="budget-panel-fields">
          <div className="form-group">
            <label className="form-label" htmlFor={`budget-source-${user.id}`}>{adding ? "From" : "Back to"}</label>
            <select
              id={`budget-source-${user.id}`}
              className="form-select"
              value={sourceTeacher ? sourceTeacher.id : "school"}
              onChange={(event) => setSource(event.target.value)}
              disabled={account !== "personal" || teachers.length === 0}
            >
              <option value="school">School account ({formatDollars(details.school)})</option>
              {account === "personal"
                ? teachers.map((teacher) => (
                    <option key={teacher.id} value={teacher.id}>
                      {teacher.fullName}&apos;s pool ({formatDollars(teacher.poolBalance)})
                    </option>
                  ))
                : null}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label budget-panel-amount-label" htmlFor={`budget-amount-${user.id}`}>
              Amount
              {!adding && targetBalance > 0 ? (
                <button
                  type="button"
                  className="budget-panel-all"
                  onClick={() => {
                    setAmountText(targetBalance.toFixed(2));
                    setError("");
                    setDone("");
                  }}
                >
                  All {formatDollars(targetBalance)}
                </button>
              ) : null}
            </label>
            <input
              id={`budget-amount-${user.id}`}
              className="form-input mono-input"
              inputMode="decimal"
              placeholder="$0.00"
              value={amountText}
              onChange={(event) => {
                setAmountText(event.target.value);
                setError("");
                setDone("");
              }}
            />
          </div>
          <div className="form-group budget-panel-note">
            <label className="form-label" htmlFor={`budget-note-${user.id}`}>Note (optional)</label>
            <input
              id={`budget-note-${user.id}`}
              className="form-input"
              placeholder="Saved with the transaction"
              maxLength={200}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
        </div>

        <div className="budget-panel-preview" aria-live="polite">
          {problem ? (
            <span className="budget-panel-problem">{problem}</span>
          ) : delta ? (
            <>
              <span>
                {targetName}: {formatDollars(targetBalance)} → <strong>{formatDollars(targetBalance + delta)}</strong>
              </span>
              <span>
                {sourceName}: {formatDollars(sourceBalance)} → <strong>{formatDollars(sourceBalance - delta)}</strong>
              </span>
            </>
          ) : (
            <span className="form-hint">Enter an amount to see the change before confirming.</span>
          )}
        </div>
        {error ? <div className="repo-error">{error}</div> : null}
        {done ? <div className="notice-ok">{done}</div> : null}

        <div className="form-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={!canConfirm} onClick={confirm}>
            {isBusy
              ? "Saving…"
              : amount && !problem
                ? adding
                  ? `Add ${formatDollars(amount)} to ${targetName}`
                  : `Take back ${formatDollars(amount)} from ${targetName}`
                : adding
                  ? "Add"
                  : "Take back"}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
            {done ? "Close" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}

// A teacher's pool line in the facts list: name, their classes, balance.
function FragmentRow({ label, hint, value }) {
  return (
    <>
      <dt>
        {label}
        {hint ? <span className="budget-panel-dt-hint">{hint}</span> : null}
      </dt>
      <dd>{value}</dd>
    </>
  );
}

// A small two-or-more option switch (radio group styled as buttons).
function Segmented({ label, value, onChange, options }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(([optionValue, optionLabel]) => (
        <button
          key={optionValue}
          type="button"
          role="radio"
          aria-checked={value === optionValue}
          className={`segmented-option${value === optionValue ? " selected" : ""}`}
          onClick={() => onChange(optionValue)}
        >
          {optionLabel}
        </button>
      ))}
    </div>
  );
}
