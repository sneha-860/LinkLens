import { exportFileUrl, exportUrl, reportUrl } from "../../api/client.js";
import { useCurrentAudit } from "../../pages/AuditPage.js";
import { Card } from "../../ui/ui.js";

/** [name, contents, has CSV] */
const TABLES: [string, string, boolean][] = [
  ["issues", "Structural issues with their evidence", true],
  ["diagnosis", "Every pair's case (v1–v4) with its explanation", true],
  ["fixes", "Ranked fixes with scores and explanations", true],
  ["orphans", "Orphans, the channels that found them and their rescue donors", true],
  ["summary", "The headline numbers", false],
  ["audit", "Status and every stage with its duration", false],
  ["explanations", "Every explanation in full", false],
];

export function ExportTab() {
  const audit = useCurrentAudit();
  const id = audit.id;
  return (
    <div className="grid grid-2">
      <Card title="Report">
        <p style={{ marginTop: 0 }}>
          A printable summary: issues, the top fixes with their explanations, the diagnosis and the
          orphans. Print it or save it as PDF from the browser.
        </p>
        <a className="btn btn-primary" href={reportUrl(id)} target="_blank" rel="noreferrer">
          Open printable report
        </a>
      </Card>
      <Card title="Everything">
        <p style={{ marginTop: 0 }}>All the files below in one zip.</p>
        <a className="btn btn-primary" href={exportUrl(id)} download={`linklens-audit-${id}.zip`}>
          Download linklens-audit-{id}.zip
        </a>
      </Card>
      <div style={{ gridColumn: "1 / -1" }}>
        <Card title="Single files">
          <table>
            <thead>
              <tr>
                <th>Data</th>
                <th>Contents</th>
                <th>Download</th>
              </tr>
            </thead>
            <tbody>
              {TABLES.map(([name, what, csv]) => (
                <tr key={name}>
                  <td className="mono">{name}</td>
                  <td>{what}</td>
                  <td className="row">
                    <a href={exportFileUrl(id, `${name}.json`)} download>
                      JSON
                    </a>
                    {csv && (
                      <a href={exportFileUrl(id, `${name}.csv`)} download>
                        CSV
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="field-hint">A file the pipeline has not produced yet is not available.</p>
        </Card>
      </div>
    </div>
  );
}
