import { useEffect, useState } from "react";
import { connectUrl, disconnectConnection, fetchConnectionItems } from "../api/client";

// Outside accounts Talon can read from (GET /api/connections). Each provider
// gets a card: status, account, Disconnect, and what Talon can see. GitHub
// has its own body (choose repositories on GitHub); a provider without one
// gets the generic body. Built-in sources (public repos, later uploads and a
// home folder) need no account and are not listed here.

// Result codes the server puts in ?connection=<provider>&result=<code>.
const genericMessages = {
  connected: (label) => `${label} connected.`,
  updated: () => "Access updated.",
  denied: (label) => `${label} sign-in was cancelled.`,
  state: (label) => `That ${label} sign-in link expired or was not started here. Try again.`,
  "in-use": (label) => `That ${label} account is already connected to another Talon user.`,
  failed: (label) => `Could not connect ${label}. Try again in a minute.`,
  "signed-out": (label) => `Your Talon session ended. Sign in and connect ${label} again.`,
  "not-configured": (label) => `${label} sign-in is not set up on this server yet.`,
};
const providerMessages = {
  github: { updated: () => "Repository access updated." },
};

// code and provider come from the address bar: look up own keys only, so
// "constructor" or "__proto__" find nothing.
const own = (table, key) => (table && Object.hasOwn(table, key) ? table[key] : undefined);

export function connectionResultMessage(provider, code, label = provider) {
  const make = own(own(providerMessages, provider), code) || own(genericMessages, code);
  return typeof make === "function" ? make(label) : "";
}

// What Talon can see through a linked connection: null while loading.
function useConnectionItems(connection) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const linked = Boolean(connection.configured && connection.linked);
  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setError("");
    if (!linked) {
      return undefined;
    }
    fetchConnectionItems(connection.provider)
      .then((list) => !cancelled && setItems(list))
      .catch((err) => !cancelled && setError(err.message || "Could not load the list"));
    return () => {
      cancelled = true;
    };
  }, [linked, connection.provider, connection.account?.login]);
  return { items, error };
}

function ItemList({ items }) {
  return (
    <ul className="github-repo-list">
      {items.map((item) => (
        <li key={item.id}>
          <span className="github-repo-name">{item.label}</span>
          {item.private ? <span className="github-private">private</span> : null}
        </li>
      ))}
    </ul>
  );
}

// GitHub: "Connect GitHub" signs the student in (GitHub shows its account
// picker); which repositories Talon may read is chosen on GitHub's install
// page, reached from "Choose repositories".
function GitHubBody({ connection }) {
  const { items, error } = useConnectionItems(connection);
  const chooseUrl = connectUrl("github", "install");

  if (!connection.configured) {
    return (
      <p className="github-text">
        GitHub sign-in is not set up on this server. Public repositories still work: paste the repository URL in New Job.
      </p>
    );
  }
  if (!connection.linked) {
    return (
      <>
        <p className="github-text">
          Public repositories work without this. To run a private repository, connect your GitHub account;
          Talon only gets read access to the repositories you choose.
        </p>
        <a className="btn btn-primary github-btn" href={connectUrl("github")}>Connect GitHub</a>
      </>
    );
  }
  return (
    <>
      {error ? <p className="github-text github-error">{error}</p> : null}
      {!error && items === null ? <p className="github-text github-muted">Loading repositories...</p> : null}
      {items && items.length === 0 ? (
        <>
          <p className="github-text">Talon can&apos;t read any of your repositories yet. Choose the ones you want to run on GitHub.</p>
          <a className="btn btn-primary github-btn" href={chooseUrl}>Choose repositories on GitHub</a>
        </>
      ) : null}
      {items && items.length > 0 ? (
        <>
          <p className="github-text">Talon can read {items.length === 1 ? "this repository" : `these ${items.length} repositories`}:</p>
          <ItemList items={items} />
          <a className="github-link" href={chooseUrl}>Add or remove repositories on GitHub ↗</a>
        </>
      ) : null}
    </>
  );
}

// Any other provider: connect, then list what it shares.
function GenericBody({ connection }) {
  const { items, error } = useConnectionItems(connection);
  if (!connection.configured) {
    return <p className="github-text">{connection.label} is not set up on this server.</p>;
  }
  if (!connection.linked) {
    return <a className="btn btn-primary github-btn" href={connectUrl(connection.provider)}>Connect {connection.label}</a>;
  }
  return (
    <>
      {error ? <p className="github-text github-error">{error}</p> : null}
      {!error && items === null ? <p className="github-text github-muted">Loading...</p> : null}
      {items && items.length === 0 ? <p className="github-text">Nothing shared with Talon yet.</p> : null}
      {items && items.length > 0 ? <ItemList items={items} /> : null}
    </>
  );
}

const bodies = { github: GitHubBody };

const disconnectNotes = {
  github: "To remove the Talon app from your account too, use GitHub Settings > Applications.",
};

function ConnectionCard({ connection, resultMessage, onChanged }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const Body = bodies[connection.provider] || GenericBody;
  const linked = connection.configured && connection.linked;

  const onDisconnect = async () => {
    setBusy(true);
    setMessage("");
    try {
      await disconnectConnection(connection.provider, connection.label);
      setMessage(`${connection.label} disconnected. ${disconnectNotes[connection.provider] || ""}`.trim());
      onChanged?.();
    } catch (error) {
      setMessage(error.message || `Unable to disconnect ${connection.label}`);
    } finally {
      setBusy(false);
    }
  };

  const shown = message || resultMessage;

  return (
    <article className="connection-card" id={`connection-${connection.provider}`}>
      <div className="connection-card-head">
        <h3 className="connection-card-title">{connection.label}</h3>
        <span className={`connection-state${linked ? " linked" : ""}`}>
          {!connection.configured ? "Not available" : linked ? "Connected" : "Not connected"}
        </span>
      </div>

      {linked ? (
        <div className="github-account">
          <span className="github-text">
            Signed in as <strong>{connection.account?.login}</strong>
          </span>
          <span className="github-muted" aria-hidden="true">·</span>
          <button type="button" className="github-link-button" onClick={onDisconnect} disabled={busy}>
            {busy ? "Disconnecting..." : "Disconnect"}
          </button>
        </div>
      ) : null}

      {linked && connection.needsReconnect ? (
        <p className="github-text github-error">
          This link was made with an older {connection.label} app. <a className="github-link" href={connectUrl(connection.provider)}>Connect again</a> to keep using it.
        </p>
      ) : null}

      <Body connection={connection} />

      {shown ? <p className="github-text github-muted github-message">{shown}</p> : null}
    </article>
  );
}

// connections: list from GET /api/connections (null while loading).
// result: { provider, code } from the sign-in round trip, or null.
export default function ConnectionsPanel({ connections, result = null, onChanged }) {
  return (
    <section className="panel github-panel" id="connections">
      <div className="panel-head">
        <h2 className="panel-title">Connections</h2>
      </div>
      <p className="github-text">
        Accounts Talon can read your code from. Public GitHub repositories need no connection.
      </p>

      {connections === null ? <p className="github-text">Loading...</p> : null}
      {connections && connections.length === 0 ? <p className="github-text">No connections are set up on this server.</p> : null}

      <div className="connection-list">
        {(connections || []).map((connection) => (
          <ConnectionCard
            key={connection.provider}
            connection={connection}
            resultMessage={result?.provider === connection.provider ? connectionResultMessage(connection.provider, result.code, connection.label) : ""}
            onChanged={onChanged}
          />
        ))}
      </div>
    </section>
  );
}
