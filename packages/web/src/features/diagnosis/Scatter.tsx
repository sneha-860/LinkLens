import type { DiagnosisCase, DiagnosisItem } from "../../api/types.js";
import { fmt2, shortUrl } from "../../ui/format.js";

export const CASE_COLOURS: Record<DiagnosisCase, string> = {
  v4: "#c0352b",
  v3: "#e0620d",
  v1: "#7c4dff",
  v2: "#1f8a4c",
};

/** Points drawn at most (an even stride over the list keeps the shape of the cloud). */
export const MAX_POINTS = 3_000;

export function samplePoints<T>(items: readonly T[], max = MAX_POINTS): T[] {
  if (items.length <= max) return [...items];
  const step = items.length / max;
  return Array.from({ length: max }, (_, i) => items[Math.floor(i * step)] as T);
}

const W = 520;
const H = 360;
const PAD = { l: 48, r: 16, t: 16, b: 40 };

/**
 * Semantic weight (x) against link prominence ω (y), one dot per diagnosed pair. With x = ρ the
 * α lines split the plot into the four cases; with x = raw REF the ε line shows the REF cutoff.
 */
export function Scatter({
  items,
  x,
  alpha,
  epsilon,
}: {
  items: readonly DiagnosisItem[];
  x: "rho" | "ref";
  alpha: number;
  epsilon: number;
}) {
  const points = samplePoints(items);
  const xs = (v: number) => PAD.l + v * (W - PAD.l - PAD.r);
  const ys = (v: number) => H - PAD.b - v * (H - PAD.t - PAD.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const xLabel =
    x === "rho" ? "ρ: share of the source's REF (normalised)" : "REF (raw containment)";
  return (
    <figure className="scatter">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Scatter of ${xLabel} against link prominence ω`}
      >
        {ticks.map((t) => (
          <g key={t} className="scatter-grid">
            <line x1={xs(t)} x2={xs(t)} y1={ys(0)} y2={ys(1)} />
            <line x1={xs(0)} x2={xs(1)} y1={ys(t)} y2={ys(t)} />
            <text x={xs(t)} y={H - PAD.b + 16} textAnchor="middle">
              {t}
            </text>
            <text x={PAD.l - 8} y={ys(t) + 4} textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        {x === "rho" ? (
          <line
            className="scatter-threshold"
            data-testid="alpha-x"
            x1={xs(alpha)}
            x2={xs(alpha)}
            y1={ys(0)}
            y2={ys(1)}
          />
        ) : (
          <line
            className="scatter-threshold scatter-epsilon"
            data-testid="epsilon-x"
            x1={xs(epsilon)}
            x2={xs(epsilon)}
            y1={ys(0)}
            y2={ys(1)}
          />
        )}
        <line
          className="scatter-threshold"
          data-testid="alpha-y"
          x1={xs(0)}
          x2={xs(1)}
          y1={ys(alpha)}
          y2={ys(alpha)}
        />
        {points.map((d) => (
          <circle
            key={d.id}
            cx={xs(Math.min(1, x === "rho" ? d.rho : d.ref))}
            cy={ys(Math.min(1, d.omega))}
            r={3}
            fill={CASE_COLOURS[d.case]}
            fillOpacity={0.65}
          >
            <title>
              {`${d.case}: ${shortUrl(d.source)} → ${shortUrl(d.target)}  ρ ${fmt2(d.rho)} · REF ${fmt2(d.ref)} · ω ${fmt2(d.omega)}`}
            </title>
          </circle>
        ))}
        <text x={(W + PAD.l) / 2} y={H - 6} textAnchor="middle" className="scatter-axis">
          {xLabel}
        </text>
        <text
          x={12}
          y={(H - PAD.b) / 2}
          textAnchor="middle"
          className="scatter-axis"
          transform={`rotate(-90 12 ${(H - PAD.b) / 2})`}
        >
          ω: link prominence
        </text>
      </svg>
      <figcaption className="legend">
        {(Object.keys(CASE_COLOURS) as DiagnosisCase[]).map((c) => (
          <span key={c}>
            <span className="legend-swatch" style={{ background: CASE_COLOURS[c] }} />
            {c}
          </span>
        ))}
        <span>
          dashed:{" "}
          {x === "rho" ? `α = ${alpha} (ρ and ω)` : `ε = ${epsilon} (REF), α = ${alpha} (ω)`}
        </span>
        {items.length > points.length && (
          <span>
            {points.length} of {items.length} pairs drawn
          </span>
        )}
      </figcaption>
    </figure>
  );
}
