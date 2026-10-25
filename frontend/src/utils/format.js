// Money in the API is dollars (numbers like 8.4). Show it as $8.40.
export function formatDollars(value) {
  const amount = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(amount)) {
    return "—";
  }

  return amount.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
