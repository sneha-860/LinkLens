/** Node colour by click depth: 0 (home) … 5+; grey when unreachable. */
export const DEPTH_COLOURS = ["#1f8a4c", "#3d5afe", "#7c4dff", "#c77800", "#e0620d", "#c0352b"];

export const depthColour = (depth: number | null | undefined) =>
  depth === null || depth === undefined
    ? "#b8b8b3"
    : (DEPTH_COLOURS[Math.min(depth, DEPTH_COLOURS.length - 1)] as string);
