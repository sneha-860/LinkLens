import { useNavigate } from "react-router";
import { NewAuditForm } from "../features/new-audit/NewAuditForm.js";
import { PageHeader } from "../layout/AppShell.js";
import { Card } from "../ui/ui.js";

export function NewAuditPage() {
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title="New audit" sub="Crawl a site and find the internal links worth adding." />
      <Card>
        <NewAuditForm onCreated={(id) => void navigate(`/audits/${id}`)} />
      </Card>
    </>
  );
}
