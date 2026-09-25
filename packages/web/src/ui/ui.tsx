import type { ButtonHTMLAttributes, ReactNode } from "react";
import { NavLink } from "react-router";
import { ApiError } from "../api/client.js";

export function Button({
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" }) {
  return <button className={`btn btn-${variant}${className ? ` ${className}` : ""}`} {...props} />;
}

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

const STATUS_TONES: Record<string, Tone> = {
  queued: "neutral",
  pending: "neutral",
  running: "info",
  completed: "success",
  failed: "danger",
};
export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONES[status] ?? "neutral"}>{status}</Badge>;
}

export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {hint !== undefined && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card">
      {(title !== undefined || actions !== undefined) && (
        <header className="card-header">
          {title !== undefined && <h2 className="card-title">{title}</h2>}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

/** Tabs as links: the tab is part of the URL, so it can be bookmarked and shared. */
export function Tabs({ tabs }: { tabs: { to: string; label: string }[] }) {
  return (
    <nav className="tabs" aria-label="Audit sections">
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          className={({ isActive }) => `tab${isActive ? " tab-active" : ""}`}
          end
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}

/** Horizontal bars (inline SVG-free: plain divs scale with the text). */
export function BarList({
  rows,
  format = (n) => String(n),
}: {
  rows: { label: string; value: number; tone?: Tone }[];
  format?: (n: number) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="bars">
      {rows.map((r) => (
        <li key={r.label} className="bar-row">
          <span className="bar-label">{r.label}</span>
          <span className="bar-track">
            <span
              className={`bar-fill bar-${r.tone ?? "info"}`}
              style={{ width: `${(100 * r.value) / max}%` }}
              aria-hidden="true"
            />
          </span>
          <span className="bar-value">{format(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

export function ProgressBar({ fraction, label }: { fraction: number; label: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div className="progress-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="spinner" role="status">
      <span className="spinner-dot" aria-hidden="true" />
      {label}…
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children}
    </div>
  );
}

/** An error; "not ready" (409) means the pipeline has not produced this yet. */
export function ErrorState({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.code === "not_ready") {
    return (
      <EmptyState title="Not ready yet">
        The pipeline has not reached this step. It appears here when it does.
      </EmptyState>
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="error" role="alert">
      {message}
    </div>
  );
}

/** Loading / error / data states of a query in one place. */
export function QueryView<T>({
  query,
  children,
}: {
  query: { isPending: boolean; error: unknown; data: T | undefined };
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) return <Spinner />;
  if (query.error) return <ErrorState error={query.error} />;
  return <>{children(query.data as T)}</>;
}
