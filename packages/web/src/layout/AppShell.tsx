import type { ReactNode } from "react";
import { Link, NavLink, Outlet } from "react-router";
import { SessionGate, SignOut } from "../features/session/SessionGate.js";

export function AppShell() {
  return (
    <>
      <header className="shell-header">
        <div className="shell-bar">
          <Link to="/" className="brand">
            LinkLens
          </Link>
          <nav className="shell-nav" aria-label="Main">
            <NavLink to="/" end>
              Audits
            </NavLink>
            <NavLink to="/audits/new">New audit</NavLink>
          </nav>
          <SignOut />
        </div>
      </header>
      <main className="shell-main">
        <SessionGate>
          <Outlet />
        </SessionGate>
      </main>
    </>
  );
}

export function PageHeader({
  title,
  sub,
  actions,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {sub !== undefined && <div className="page-sub">{sub}</div>}
      </div>
      {actions}
    </div>
  );
}
