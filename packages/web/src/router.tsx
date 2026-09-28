import { createBrowserRouter, Navigate, type RouteObject } from "react-router";
import { CanonTab } from "./features/canonicalisation/CanonTab.js";
import { DiagnosisTab } from "./features/diagnosis/DiagnosisTab.js";
import { ExportTab } from "./features/export/ExportTab.js";
import { FixesTab } from "./features/fixes/FixesTab.js";
import { GraphTab } from "./features/graph/GraphTab.js";
import { LinksTab } from "./features/links/LinksTab.js";
import { OrphansTab } from "./features/orphans/OrphansTab.js";
import { RatingTab } from "./features/rating/RatingTab.js";
import { SummaryTab } from "./features/summary/SummaryTab.js";
import { AppShell } from "./layout/AppShell.js";
import { AuditPage } from "./pages/AuditPage.js";
import { AuditsPage } from "./pages/AuditsPage.js";
import { NewAuditPage } from "./pages/NewAuditPage.js";
import { EmptyState } from "./ui/ui.js";

/** Routes: /, /audits/new, /audits/:id/:tab (the tab is part of the URL). */
export const routes: RouteObject[] = [
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <AuditsPage /> },
      { path: "audits/new", element: <NewAuditPage /> },
      {
        path: "audits/:id",
        element: <AuditPage />,
        children: [
          { index: true, element: <Navigate to="summary" replace /> },
          { path: "summary", element: <SummaryTab /> },
          { path: "graph", element: <GraphTab /> },
          { path: "fixes", element: <FixesTab /> },
          { path: "diagnosis", element: <DiagnosisTab /> },
          { path: "orphans", element: <OrphansTab /> },
          { path: "links", element: <LinksTab /> },
          { path: "canonicalisation", element: <CanonTab /> },
          { path: "rating", element: <RatingTab /> },
          { path: "export", element: <ExportTab /> },
        ],
      },
      { path: "*", element: <EmptyState title="Page not found" /> },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes);
