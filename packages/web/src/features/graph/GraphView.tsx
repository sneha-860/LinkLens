import "@react-sigma/core/lib/style.css";
import { SigmaContainer, useRegisterEvents } from "@react-sigma/core";
import { useEffect, useMemo } from "react";
import type { GraphNodeAttributes, GraphResponse } from "../../api/types.js";
import { shortUrl } from "../../ui/format.js";
import { buildDrawGraph } from "./buildGraph.js";

type Select = (s: { node: string; attrs: GraphNodeAttributes } | null) => void;

function Events({ onSelect }: { onSelect: Select }) {
  const register = useRegisterEvents();
  useEffect(() => {
    register({
      // The caller replaces attrs with the node's attributes from the drawn graph.
      clickNode: (e) => onSelect({ node: e.node, attrs: {} }),
      clickStage: () => onSelect(null),
    });
  }, [register, onSelect]);
  return null;
}

/** The link graph in WebGL (sigma); loaded lazily by GraphTab. */
export default function GraphView({ data, onSelect }: { data: GraphResponse; onSelect: Select }) {
  const graph = useMemo(() => buildDrawGraph(data), [data]);
  const select: Select = (s) =>
    onSelect(s === null ? null : { node: s.node, attrs: graph.getNodeAttributes(s.node) });
  return (
    <SigmaContainer
      className="graph-canvas"
      graph={graph}
      settings={{
        defaultEdgeType: "arrow",
        defaultEdgeColor: "#d6d6d1",
        labelRenderedSizeThreshold: 9,
        labelFont: "system-ui, sans-serif",
        nodeReducer: (node, attrs) => ({ ...attrs, label: shortUrl(node) }),
      }}
    >
      <Events onSelect={select} />
    </SigmaContainer>
  );
}
