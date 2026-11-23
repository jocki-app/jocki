export interface CanvasNode {
  id: string;
  type: "text" | "file" | "link" | "group";
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  text?: string;
  file?: string;
  subpath?: string;
  url?: string;
  label?: string;
  background?: string;
  backgroundStyle?: "cover" | "ratio" | "repeat";
  [key: string]: unknown;
}
export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  label?: string;
  color?: string;
  fromSide?: "top" | "right" | "bottom" | "left";
  toSide?: "top" | "right" | "bottom" | "left";
  fromEnd?: "none" | "arrow";
  toEnd?: "none" | "arrow";
  [key: string]: unknown;
}
export interface CanvasDocument {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  [key: string]: unknown;
}
/** JSON Canvas 1.0. Unknown extension attributes are preserved on round trip. */
export function parseCanvas(source: string): CanvasDocument {
  const value = JSON.parse(source) as CanvasDocument;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Expected a JSON Canvas object");
  value.nodes ??= [];
  value.edges ??= [];
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges))
    throw Error("Canvas nodes and edges must be arrays");
  const ids = new Set<string>();
  for (const node of value.nodes) {
    if (!node || typeof node.id !== "string" || !node.id || ids.has(node.id))
      throw Error("Canvas node IDs must be unique");
    ids.add(node.id);
    if (
      !["text", "file", "link", "group"].includes(node.type) ||
      ![node.x, node.y, node.width, node.height].every(Number.isSafeInteger) ||
      node.width <= 0 ||
      node.height <= 0
    )
      throw Error("Invalid canvas node");
    const required = { text: "text", file: "file", link: "url", group: null }[
      node.type
    ];
    if (required && typeof node[required] !== "string")
      throw Error(`Missing canvas ${required}`);
    if (
      node.subpath !== undefined &&
      (typeof node.subpath !== "string" || !node.subpath.startsWith("#"))
    )
      throw Error("Invalid canvas subpath");
  }
  const edgeIds = new Set();
  for (const edge of value.edges) {
    if (
      !edge ||
      typeof edge.id !== "string" ||
      !edge.id ||
      edgeIds.has(edge.id) ||
      !ids.has(edge.fromNode) ||
      !ids.has(edge.toNode)
    )
      throw Error("Invalid canvas edge");
    edgeIds.add(edge.id);
    for (const side of [edge.fromSide, edge.toSide])
      if (
        side !== undefined &&
        !["top", "right", "bottom", "left"].includes(side)
      )
        throw Error("Invalid edge side");
    for (const end of [edge.fromEnd, edge.toEnd])
      if (end !== undefined && !["none", "arrow"].includes(end))
        throw Error("Invalid edge end");
  }
  return value;
}
