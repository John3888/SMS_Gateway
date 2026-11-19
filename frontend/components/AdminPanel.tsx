"use client";
import { useEffect, useState } from "react";
import { login, logout } from "@/services/auth.service";
import { adminGet, SessionExpired } from "@/services/admin.services";
import type { RequestPage, LogEvent } from "@/types/admin.types";

export default function AdminPanel() {
  const [signedIn, setSignedIn] = useState(false),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState("");
  const [apps, setApps] = useState<string[]>([]),
    [app, setApp] = useState(""),
    [page, setPage] = useState(0);
  const [data, setData] = useState<RequestPage | null>(null),
    [logs, setLogs] = useState<LogEvent[]>([]);
  const [selected, select] = useState(""),
    [tab, setTab] = useState("Requests");
  useEffect(() => {
    const controller = new AbortController();
    async function restoreSession() {
      const { authenticated } = await adminGet<{ authenticated: boolean }>(
        "authentication/session", controller.signal,
      );
      if (!authenticated || controller.signal.aborted) return;
      const items = await adminGet<string[]>("applications", controller.signal);
      if (!controller.signal.aborted) {
        setApps(items);
        setSignedIn(true);
      }
    }
    restoreSession().catch(e => {
      if (!controller.signal.aborted && !(e instanceof SessionExpired)) setError(e.message);
    });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!signedIn) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const result = await adminGet<RequestPage>(
          "requests?" +
            new URLSearchParams({ application: app, page: String(page) }),
          controller.signal,
        );
        const events =
          tab === "Logs" && selected
            ? await adminGet<LogEvent[]>(
                "requests/" + selected + "/logs",
                controller.signal,
              )
            : [];
        if (!controller.signal.aborted) {
          setData(result);
          setLogs(events);
          setError("");
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof SessionExpired) {
          setSignedIn(false);
          resetList();
          return;
        }
        setError(e instanceof Error ? e.message : "Connection failed");
      }
      if (!controller.signal.aborted) timer = setTimeout(refresh, 5000);
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [signedIn, app, page, tab, selected]);
  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    try {
      await login(username, password);
      setPassword("");
      setApps(await adminGet<string[]>("applications"));
      setSignedIn(true);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed");
    }
  }
  function resetList() {
    setData(null);
    select("");
    setLogs([]);
  }
  return (
    <main>
      <header>
        <span className="mark">↗</span> SMS Gateway{" "}
        <small>Administration</small>
      </header>
      {!signedIn ? (
        <form onSubmit={signIn}>
          <h1>Admin access</h1>
          <label>
            Username
            <input required autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} />
          </label>
          <label>
            Password
            <input
              required
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button>Sign in</button>
          {error && <p role="alert">{error}</p>}
        </form>
      ) : (
        <section>
          <div className="bar">
            <h1>Request monitor</h1>
            <button
              onClick={async () => {
                try { await logout(); } catch { setError("Sign-out failed. Please try again."); return; }
                setSignedIn(false);
                setTab("Requests");
                resetList();
                setApp("");
                setPage(0);
                setError("");
              }}
            >
              Sign out
            </button>
          </div>
          <nav>
            {["Requests", "Logs"].map((t) => (
              <button
                aria-pressed={tab === t}
                key={t}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </nav>
          <label>
            Application
            <select
              value={app}
              onChange={(e) => {
                setApp(e.target.value);
                setPage(0);
                resetList();
              }}
            >
              <option value="">All applications</option>
              {apps.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </label>
          {error && <p role="alert">{error}</p>}
          {data?.writeFailed && (
            <p role="alert">
              Some events could not be saved. History may be incomplete.
            </p>
          )}
          {tab === "Requests" ? (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    {["Request", "Application", "Status", "Last update"].map(
                      (x) => (
                        <th key={x}>{x}</th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {data?.rows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <button
                          className="link"
                          onClick={() => {
                            select(r.id);
                            setLogs([]);
                            setTab("Logs");
                          }}
                        >
                          {r.id}
                        </button>
                      </td>
                      <td>{r.application}</td>
                      <td>
                        <b>{r.status}</b>
                      </td>
                      <td>{new Date(r.updated).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <>
              <label>
                Request
                <select
                  value={selected}
                  onChange={(e) => {
                    select(e.target.value);
                    setLogs([]);
                  }}
                >
                  <option value="">Choose a request</option>
                  {data?.rows.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.application} · {r.id}
                    </option>
                  ))}
                </select>
              </label>
              {selected && (
                <ol>
                  {logs.map((e) => (
                    <li key={e.id}>
                      <time>{new Date(e.at).toLocaleString()}</time>{" "}
                      <b>{e.status}</b>
                      {e.detail && <p>{e.detail}</p>}
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
          {!data && !error && <p>Loading requests…</p>}
          {data?.rows.length === 0 && (
            <p>No requests recorded for this application.</p>
          )}
          <footer>
            <button
              disabled={!page}
              onClick={() => {
                resetList();
                setPage(page - 1);
              }}
            >
              Previous
            </button>{" "}
            Page {page + 1}{" "}
            <button
              disabled={!data?.more}
              onClick={() => {
                resetList();
                setPage(page + 1);
              }}
            >
              Next
            </button>
          </footer>
        </section>
      )}
    </main>
  );
}
