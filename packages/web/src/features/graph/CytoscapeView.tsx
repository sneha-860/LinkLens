import cytoscape, { type Core, type ElementDefinition, type StylesheetStyle } from "cytoscape";
import fcose from "cytoscape-fcose";
import { useEffect, useRef } from "react";
import { shortUrl } from "../../ui/format.js";
import { ORPHAN_CLUSTER, type ColourMode, type Elements } from "./model.js";

let registered = false;
if (!registered) {
  cytoscape.use(fcose);
  registered = true;
}

export interface Preview {
  readonly donor: string;
  readonly target: string;
}

export interface CytoscapeViewProps {
  readonly elements: Elements;
  readonly mode: ColourMode;
  readonly selected: string | null;
  readonly preview: Preview | null;
  readonly onSelect: (node: string | null) => void;
}

/** Deterministic start position for a node (fcose then refines from there). */
function seededPosition(id: string): { x: number; y: number } {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const a = ((h >>> 0) % 10_000) / 10_000;
  const b = (((h >>> 0) / 10_000) % 10_000) / 10_000;
  return { x: a * 1_000, y: b * 1_000 };
}

const STYLE: StylesheetStyle[] = [
  {
    selector: "node",
    style: {
      width: "data(size)",
      height: "data(size)",
      "background-color": "data(colour)",
      label: "data(label)",
      "font-size": 10,
      "min-zoomed-font-size": 8,
      "text-valign": "bottom",
      "text-margin-y": 3,
      color: "#44443f",
      "text-max-width": "120px",
      "text-wrap": "ellipsis",
    },
  },
  { selector: "node.seed", style: { "border-width": 3, "border-color": "#1c1c1a" } },
  { selector: "node.orphan", style: { "border-width": 3, "border-color": "#c0352b" } },
  {
    selector: "node.cluster",
    style: {
      "background-color": "#fdecea",
      "background-opacity": 0.6,
      "border-width": 2,
      "border-style": "dashed",
      "border-color": "#c0352b",
      label: "data(label)",
      "text-valign": "top",
      "font-size": 12,
      "font-weight": "bold",
      color: "#c0352b",
      padding: "16px",
      shape: "round-rectangle",
    },
  },
  {
    selector: "node.selected",
    style: { "border-width": 5, "border-color": "#1c1c1a", "z-index": 999 },
  },
  {
    selector: "node.preview-node",
    style: { "border-width": 3, "border-style": "dashed", "border-color": "#3d5afe" },
  },
  {
    selector: "edge",
    style: {
      width: 1,
      "curve-style": "straight",
      "target-arrow-shape": "triangle",
      "arrow-scale": 0.6,
      "line-color": "#cfcfca",
      "target-arrow-color": "#cfcfca",
      opacity: 0.85,
    },
  },
  {
    selector: "edge.region-body",
    style: { width: 1.8, "line-color": "#5f6f86", "target-arrow-color": "#5f6f86" },
  },
  {
    selector: "edge.region-breadcrumb",
    style: { "line-color": "#8a6fd6", "target-arrow-color": "#8a6fd6", "line-style": "dotted" },
  },
  {
    selector: "edge.region-aside",
    style: { "line-color": "#6aa6a0", "target-arrow-color": "#6aa6a0" },
  },
  {
    selector: "edge.region-header, edge.region-nav",
    style: { "line-color": "#b3b3ad", "target-arrow-color": "#b3b3ad", "line-style": "dotted" },
  },
  {
    selector: "edge.region-pagination",
    style: { "line-color": "#c9b27c", "target-arrow-color": "#c9b27c", "line-style": "dotted" },
  },
  {
    selector: "edge.region-footer",
    style: { width: 0.6, "line-color": "#e2e2dd", "target-arrow-color": "#e2e2dd" },
  },
  {
    selector: "edge.preview",
    style: {
      width: 3,
      "line-style": "dashed",
      "line-dash-pattern": [8, 5],
      "line-color": "#3d5afe",
      "target-arrow-color": "#3d5afe",
      "arrow-scale": 1,
      opacity: 1,
      "z-index": 1000,
    },
  },
];

/** The graph in Cytoscape (loaded lazily by GraphTab). */
export default function CytoscapeView({
  elements,
  mode,
  selected,
  preview,
  onSelect,
}: CytoscapeViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;

  // A new instance and layout only when the elements change.
  useEffect(() => {
    if (container.current === null) return;
    const defs: ElementDefinition[] = [
      ...elements.nodes.map((n) => ({
        group: "nodes" as const,
        data: n.data,
        ...(n.classes === undefined ? {} : { classes: n.classes }),
        position: seededPosition(n.data.id),
      })),
      ...elements.edges.map((e) => ({ group: "edges" as const, data: e.data, classes: e.classes })),
    ];
    const big = elements.edges.length > 800 || elements.nodes.length > 400;
    const cy = cytoscape({
      container: container.current,
      elements: defs,
      style: STYLE,
      minZoom: 0.05,
      maxZoom: 4,
      pixelRatio: 1,
      textureOnViewport: big,
      hideEdgesOnViewport: big,
      motionBlur: false,
    });
    cy.layout({
      name: "fcose",
      quality: big ? "draft" : "default",
      randomize: false,
      animate: false,
      nodeRepulsion: () => 8_000,
      idealEdgeLength: () => 70,
      packComponents: true,
      fit: true,
      padding: 20,
    } as cytoscape.LayoutOptions).run();
    cy.on("tap", "node", (e) => {
      const id = e.target.id() as string;
      if (id !== ORPHAN_CLUSTER) selectRef.current(id);
    });
    cy.on("tap", (e) => {
      if (e.target === cy) selectRef.current(null);
    });
    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [elements]);

  // Recolour without a new layout.
  useEffect(() => {
    const cy = cyRef.current;
    if (cy === null) return;
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        if (n.id() !== ORPHAN_CLUSTER)
          n.data("colour", n.data(mode === "depth" ? "colourDepth" : "colourIssue"));
      });
    });
  }, [mode, elements]);

  useEffect(() => {
    const cy = cyRef.current;
    if (cy === null) return;
    cy.nodes(".selected").removeClass("selected");
    if (selected !== null) cy.getElementById(selected).addClass("selected");
  }, [selected, elements]);

  // The suggested link, dashed; its end points are added if the cap left them out.
  useEffect(() => {
    const cy = cyRef.current;
    if (cy === null || preview === null) return;
    const added: string[] = [];
    for (const [id, near] of [
      [preview.donor, preview.target],
      [preview.target, preview.donor],
    ] as const) {
      if (cy.getElementById(id).empty()) {
        const anchor = cy.getElementById(near);
        const pos = anchor.nonempty() ? anchor.position() : { x: 0, y: 0 };
        cy.add({
          group: "nodes",
          data: { id, label: shortUrl(id), size: 20, colour: "#ffffff" },
          classes: "preview-node",
          position: { x: pos.x + 60, y: pos.y - 60 },
        });
        added.push(id);
      }
    }
    const edge = cy.add({
      group: "edges",
      data: { id: "preview", source: preview.donor, target: preview.target },
      classes: "preview",
    });
    cy.animate(
      { fit: { eles: edge.union(edge.connectedNodes()), padding: 120 } },
      { duration: 300 },
    );
    return () => {
      if (cy.destroyed()) return;
      edge.remove();
      for (const id of added) cy.getElementById(id).remove();
    };
  }, [preview, elements]);

  return <div ref={container} className="graph-canvas" data-testid="cytoscape" />;
}
