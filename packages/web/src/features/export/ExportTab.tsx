import { exportUrl } from "../../api/client.js";
import { useCurrentAudit } from "../../pages/AuditPage.js";
import { Card } from "../../ui/ui.js";

const FILES: [string, string][] = [
  ["audit.json", "Status and every stage with its duration"],
  ["summary.json", "The headline numbers"],
  ["issues.json / .csv", "Structural issues with their evidence"],
  ["diagnosis.json / .csv", "Every pair's case (v1–v4) with its explanation"],
  ["fixes.json / .csv", "Ranked fixes with scores and explanations"],
  ["orphans.json / .csv", "Orphans, the channels that found them and their rescue donors"],
  ["explanations.json", "Every explanation in full"],
];

export function ExportTab() {
  const audit = useCurrentAudit();
  return (
    <Card title="Export">
      <p style={{ marginTop: 0 }}>
        Everything this audit has produced so far, as one zip of JSON and CSV files. CSV files open
        in a spreadsheet.
      </p>
      <p>
        <a
          className="btn btn-primary"
          href={exportUrl(audit.id)}
          download={`linklens-audit-${audit.id}.zip`}
        >
          Download linklens-audit-{audit.id}.zip
        </a>
      </p>
      <table>
        <thead>
          <tr>
            <th>File</th>
            <th>Contents</th>
          </tr>
        </thead>
        <tbody>
          {FILES.map(([name, what]) => (
            <tr key={name}>
              <td className="mono">{name}</td>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
