import { useEffect, useState } from "react";
import { adjustAdminBudget, fetchBudgetSummary } from "../api/client";
import { formatDollars } from "../utils/format";
import BudgetAdjuster from "./BudgetAdjuster";

// School years (July 1 to June 30) from the first one Talon ran in to the
// current one, newest first: [{ label: "2026-27", from, to }].
const firstSchoolYear = 2026;
export function schoolYears(today = new Date()) {
  const current = today.getMonth() >= 6 ? today.getFullYear() : today.getFullYear() - 1;
  const years = [];
  for (let year = Math.max(current, firstSchoolYear); year >= firstSchoolYear; year -= 1) {
    years.push({ label: `${year}-${String(year + 1).slice(2)}`, from: `${year}-07-01`, to: `${year + 1}-06-30` });
  }
  return years;
}

// Admin Overview: the School account (where the yearly budget goes in and
// everything else is funded from), where the money is now, and the chosen
// school year's budget and spending. onChanged reloads the admin lists
// (their add limits follow the School balance).
export default function AdminMoneyPanel({ refreshKey = 0, onChanged }) {
  const years = schoolYears();
  const [yearLabel, setYearLabel] = useState(years[0].label);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const year = years.find((item) => item.label === yearLabel) ?? years[0];

  useEffect(() => {
    let cancelled = false;
    fetchBudgetSummary({ from: year.from, to: year.to })
      .then((response) => {
        if (!cancelled) {
          setSummary(response.summary);
          setError("");
        }
      })
      .catch((nextError) => {
        if (!cancelled) {
          setError(nextError.message || "Unable to load the budget summary");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [year.from, year.to, refreshKey]);

  async function adjustSchool(direction, amount) {
    setMessage("");
    await adjustAdminBudget({ target: "school", direction: direction === "add" ? "increase" : "decrease", amount });
    setMessage(direction === "add" ? `Added ${formatDollars(amount)} to the School account` : `Removed ${formatDollars(amount)} from the School account`);
    onChanged?.();
  }

  const cards = summary
    ? [
        { label: `Budget ${year.label}`, value: summary.budget, hint: "Added to the School account" },
        { label: `Spent ${year.label}`, value: summary.spent, hint: `${summary.jobs} job${summary.jobs === 1 ? "" : "s"}` },
        { label: "School account", value: summary.school, hint: "Not given out yet" },
        { label: "Teacher pools", value: summary.teacherPools, hint: "Not given to students yet" },
        { label: "Own budgets", value: summary.personal, hint: "Students, teachers, admins" },
        { label: "Running jobs", value: summary.reservedForRunningJobs, hint: "Set aside, in Spent" },
      ]
    : [];

  return (
    <section className="panel" id="admin-money">
      <div className="panel-head">
        <h2 className="panel-title">Money</h2>
        <select
          className="form-select money-year-select"
          aria-label="School year"
          value={yearLabel}
          onChange={(event) => setYearLabel(event.target.value)}
        >
          {years.map((item) => (
            <option key={item.label} value={item.label}>
              School year {item.label}
            </option>
          ))}
        </select>
      </div>

      {error ? <div className="repo-error">{error}</div> : null}
      {!summary && !error ? <div className="form-hint">Loading...</div> : null}

      {summary ? (
        <>
          <div className="results-grid stat-row">
            {cards.map((card) => (
              <div key={card.label} className="result-card stat-card">
                <div className="result-job-name">{card.label}</div>
                <div className="result-meta-value num">{formatDollars(card.value)}</div>
                <div className="form-hint">{card.hint}</div>
              </div>
            ))}
          </div>

          <div className="money-school">
            <div>
              <div className="result-job-name">School account</div>
              <div className="form-hint">
                Add the yearly budget here. Teacher pools and everyone&apos;s own budget (yours too) are funded from it on
                the Users and Classes pages; money taken back from them returns here. Subtract only corrects a mistake: that
                money leaves Talon.
              </div>
            </div>
            <BudgetAdjuster
              who="the School account"
              balance={summary.school}
              subtractLimit={summary.school}
              onAdjust={adjustSchool}
            />
          </div>
          {message ? <div className="form-hint">{message}</div> : null}
          <div className="form-hint">
            Spent is compute charged to jobs in Talon (per second, from {summary.from} to {summary.to}), not the AWS bill.
          </div>
        </>
      ) : null}
    </section>
  );
}
