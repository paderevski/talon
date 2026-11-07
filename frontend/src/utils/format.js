// Money in the API is dollars (numbers like 8.4). Show it as $8.40.
export function formatDollars(value) {
  // Numbers and numeric text only: Number(" ") is 0 and Number(true) is 1.
  const usable = typeof value === "number" || (typeof value === "string" && value.trim() !== "");
  const amount = Number(value);
  if (!usable || !Number.isFinite(amount)) {
    return "—";
  }

  return amount.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

// "5" -> "Block 5"; anything else ("5A", "B5") is shown as entered.
export function formatBlock(block) {
  const value = String(block ?? "").trim();
  if (!value) {
    return "";
  }
  return /^\d+$/.test(value) ? `Block ${value}` : value;
}

// A class is one section: "Calculus · Block 5". Legacy classes may have no block.
export function formatClassName(name, block) {
  const label = formatBlock(block);
  return label ? `${name} · ${label}` : name;
}
