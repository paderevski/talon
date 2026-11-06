const maxAmount = 100000;

// Parses a dollar amount typed by a person: positive, at most two decimals,
// at most $100,000 (the server's limit). Returns the amount or null.
export function parseAmount(text) {
  const trimmed = String(text ?? "").trim();
  if (!/^\d*\.?\d{0,2}$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    return null;
  }
  const value = Number(trimmed);
  return value > 0 && value <= maxAmount ? value : null;
}
