import { ErrorToast } from "./errors";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import { Textarea } from "../ui/primitives/textarea";
import { useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  MarkerType,
  type Node,
  type Edge,
  type NodeChange,
  applyNodeChanges,
} from "@xyflow/react";
import { parseCanvas, type CanvasNode } from "../core/vaults/canvas";
import "@xyflow/react/dist/style.css";

export function CanvasEditor({
  value,
  onChange,
  open,
}: {
  value: string;
  onChange(value: string): void;
  open(path: string): void;
}) {
  const parsed = useMemo(() => {
    try {
      return { doc: parseCanvas(value) };
    } catch (error) {
      return { error: String(error) };
    }
  }, [value]);
  const [selected, setSelected] = useState<string>();
  if (!parsed.doc)
    return (
      <div>
        <ErrorToast error={parsed.error} source="canvas" />
        <Textarea
          aria-label="Canvas JSON"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  const doc = parsed.doc,
    active = doc.nodes.find((n) => n.id === selected);
  const save = () => onChange(JSON.stringify(doc, null, 2) + "\n");
  const nodes: Node[] = doc.nodes.map((n) => ({
    id: n.id,
    position: { x: n.x, y: n.y },
    data: { label: n.text ?? n.file ?? n.url ?? n.label ?? "Group" },
    style: {
      width: n.width,
      height: n.height,
      background: color(n.color),
      whiteSpace: "pre-wrap",
    },
    type: n.type === "group" ? "group" : "default",
    zIndex: n.type === "group" ? -1 : undefined,
  }));
  const edges: Edge[] = doc.edges.map((e) => ({
    id: e.id,
    source: e.fromNode,
    target: e.toNode,
    label: e.label,
    markerEnd:
      e.toEnd !== "none" ? { type: MarkerType.ArrowClosed } : undefined,
    markerStart:
      e.fromEnd === "arrow" ? { type: MarkerType.ArrowClosed } : undefined,
    style: { stroke: color(e.color) },
  }));
  const changeNodes = (changes: NodeChange[]) => {
    const next = applyNodeChanges(changes, nodes);
    doc.nodes = doc.nodes
      .filter((n) => next.some((item) => item.id === n.id))
      .map((n) => {
        const changed = next.find((item) => item.id === n.id)!;
        return {
          ...n,
          x: Math.round(changed.position.x),
          y: Math.round(changed.position.y),
          width: Math.round(changed.measured?.width ?? n.width),
          height: Math.round(changed.measured?.height ?? n.height),
        };
      });
    doc.edges = doc.edges.filter(
      (e) =>
        doc.nodes.some((n) => n.id === e.fromNode) &&
        doc.nodes.some((n) => n.id === e.toNode),
    );
    save();
  };
  return (
    <section className="vault-canvas">
      <div className="vault-toolbar">
        {(["text", "file", "link", "group"] as const).map((type) => (
          <Button
            variant="outline"
            key={type}
            onClick={() => {
              const node: CanvasNode = {
                id: crypto.randomUUID(),
                type,
                x: 40 + doc.nodes.length * 30,
                y: 40 + doc.nodes.length * 30,
                width: 280,
                height: 180,
              };
              if (type === "text") node.text = "New note";
              if (type === "file") node.file = "note.md";
              if (type === "link") node.url = "https://example.com";
              if (type === "group") {
                node.label = "Group";
                node.width = 600;
                node.height = 400;
              }
              doc.nodes.push(node);
              setSelected(node.id);
              save();
            }}
          >
            Add {type}
          </Button>
        ))}
      </div>
      <div className="vault-canvas-body">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={changeNodes}
          onNodeClick={(_, n) => setSelected(n.id)}
          onNodeDoubleClick={(_, node) => {
            const n = doc.nodes.find((n) => n.id === node.id)!;
            if (n.file) open(n.file + (n.subpath ?? ""));
            if (n.url && /^https?:\/\//.test(n.url))
              window.open(n.url, "_blank", "noopener,noreferrer");
          }}
          onConnect={(c) => {
            doc.edges.push({
              id: crypto.randomUUID(),
              fromNode: c.source,
              toNode: c.target,
            });
            save();
          }}
          onEdgesDelete={(deleted) => {
            doc.edges = doc.edges.filter(
              (e) => !deleted.some((d) => d.id === e.id),
            );
            save();
          }}
          fitView
        >
          <Background />
          <Controls />
          <MiniMap />
        </ReactFlow>
      </div>
      {active && (
        <div className="vault-canvas-properties">
          <label>
            {active.type}
            <Textarea
              aria-label="Canvas node content"
              value={
                active.text ?? active.file ?? active.url ?? active.label ?? ""
              }
              onChange={(e) => {
                const field = (
                  {
                    text: "text",
                    file: "file",
                    link: "url",
                    group: "label",
                  } as const
                )[active.type];
                active[field] = e.target.value;
                save();
              }}
            />
          </label>
          <label>
            Color{" "}
            <Input
              value={active.color ?? ""}
              onChange={(e) => {
                active.color = e.target.value;
                save();
              }}
            />
          </label>
        </div>
      )}
    </section>
  );
}
function color(value?: string) {
  return value && /^#[0-9a-f]{6}$/i.test(value)
    ? value
    : ((
        {
          "1": "#ffdddd",
          "2": "#ffe3c6",
          "3": "#fff5bf",
          "4": "#ddf3d5",
          "5": "#d7f0fa",
          "6": "#ebdefb",
        } as Record<string, string>
      )[value ?? ""] ?? "#f5f5f5");
}
