// One CSV field. Text a spreadsheet would run as a formula (leading = + - @,
// tab or CR) gets a leading ' so it shows as text; neutralize: false keeps the
// value exact (generated passwords, which must be copied as they are). A field
// with a comma, quote or line break is quoted.
export function csvField(value, { neutralize = true } = {}) {
  let text = String(value ?? "");
  if (neutralize && /^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
