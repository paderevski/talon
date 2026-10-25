import { useState } from "react";

// Shows a generated password once. It is not stored anywhere readable, so
// the admin has to pass it on before dismissing this.
export default function CredentialsNotice({ username, password, onDismiss }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      // Clipboard blocked; the text is selectable.
    }
  }

  return (
    <div className="credentials-notice" role="status">
      <span>
        Password for <strong>{username}</strong> (shown once, it cannot be looked up later):
      </span>
      <code>{password}</code>
      <button type="button" className="btn btn-secondary btn-sm" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
