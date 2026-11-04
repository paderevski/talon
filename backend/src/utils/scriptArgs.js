// Splits the Arguments field into argv entries, shell-style but without a
// shell: whitespace separates, '...' is literal, "..." allows \" and \\, and a
// backslash outside quotes escapes the next character. Nothing is expanded
// ($VAR, globs, `...`): each entry reaches the script exactly as written.
// Throws (status 400) on unbalanced quotes, control characters or too much.
const maxLength = 2000;
const maxCount = 100;

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function parseScriptArgs(text) {
  const input = String(text ?? "").trim();
  if (!input) {
    return [];
  }
  if (input.length > maxLength) {
    throw badRequest(`Arguments are limited to ${maxLength} characters`);
  }
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(input)) {
    throw badRequest("Arguments must be on one line");
  }

  const args = [];
  let current = "";
  let inToken = false;
  let quote = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && (input[i + 1] === '"' || input[i + 1] === "\\")) current += input[++i];
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
    } else if (ch === "\\" && i + 1 < input.length) {
      current += input[++i];
      inToken = true;
    } else if (/\s/.test(ch)) {
      if (inToken) {
        args.push(current);
        current = "";
        inToken = false;
      }
    } else {
      current += ch;
      inToken = true;
    }
  }
  if (quote) {
    throw badRequest("Arguments have an unclosed quote");
  }
  if (inToken) {
    args.push(current);
  }
  if (args.length > maxCount) {
    throw badRequest(`At most ${maxCount} arguments`);
  }
  return args;
}
