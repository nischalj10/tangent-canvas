import React, { useCallback, useRef } from "react";
import { NodeResizeControl } from "@xyflow/react";
import "./card-resize.css";

const edges = ["top", "right", "bottom", "left"];
const corners = [
  ["top-left", "nw"],
  ["top-right", "ne"],
  ["bottom-left", "sw"],
  ["bottom-right", "se"],
];

// React Flow applies pointer movement in canvas coordinates, including zoom.
// Stable callbacks keep its pointer interaction alive during streaming updates.
export default function CanvasResizeControls({
  nodeId,
  isVisible = true,
  minWidth = 360,
  minHeight = 400,
  onStart,
  onCommit,
}) {
  const callbacks = useRef({ nodeId, onStart, onCommit });
  callbacks.current = { nodeId, onStart, onCommit };
  const start = useCallback(() => {
    const current = callbacks.current;
    current.onStart?.(current.nodeId);
  }, []);
  const finish = useCallback((_, size) => {
    const current = callbacks.current;
    current.onCommit?.(current.nodeId, {
      width: size.width,
      height: size.height,
      position: { x: size.x, y: size.y },
    });
  }, []);
  if (!isVisible) return null;
  const shared = {
    nodeId,
    minWidth,
    minHeight,
    maxWidth: 8192,
    maxHeight: 8192,
    onResizeStart: start,
    onResizeEnd: finish,
  };
  return <>
    {edges.map(position => (
      <NodeResizeControl {...shared} key={position} position={position} variant="line" className="card-resize-edge nopan">
        <span className="card-resize-edge-target" data-testid={`resize-${position}-${nodeId}`} title={`Drag to resize ${position} edge`} />
      </NodeResizeControl>
    ))}
    {corners.map(([position, direction]) => (
      <NodeResizeControl {...shared} key={position} position={position} className={`card-resize-corner card-resize-${direction} nopan`}>
        <span className="card-resize-corner-target" data-testid={`resize-${direction}-${nodeId}`} title="Drag to resize this card without changing canvas zoom" aria-label={`Resize card from ${position}`}>
          {direction === "se" ? <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 13 13 5M10 13l3-3" /></svg> : <i />}
        </span>
      </NodeResizeControl>
    ))}
  </>;
}
