'use client';

import { useRef, type PointerEvent as ReactPointerEvent } from 'react';

type Point = { x: number; y: number };

interface BrushProps {
  width: number;
  height: number;
  preview: { width: number; height: number };
  diameter: number;
  onStroke: (points: Point[]) => void;
}

export default function DisplayBrush({ width, height, preview, diameter, onStroke }: BrushProps) {
  const stroke = useRef<{ id: number; points: Point[] } | null>(null);
  const cursor = useRef<HTMLSpanElement>(null);

  function sample(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = event.currentTarget;
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const active = stroke.current;
    const context = canvas.getContext('2d');
    if (!context || (active && active.id !== event.pointerId)) return;
    const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
    const points = [...samples, event.nativeEvent];
    context.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    context.strokeStyle = context.fillStyle = '#ffad55';
    context.lineWidth = diameter;
    context.lineCap = 'round';
    for (const sample of points) {
      const x = Math.floor((sample.clientX - box.left) * width / box.width) + 0.5;
      const y = Math.floor((sample.clientY - box.top) * height / box.height) + 0.5;
      if (active) {
        const last = active.points.at(-1);
        if (!last || last.x !== x || last.y !== y) {
          context.beginPath();
          if (last) {
            context.moveTo(last.x, last.y);
            context.lineTo(x, y);
            context.stroke();
          } else {
            context.arc(x, y, diameter / 2, 0, Math.PI * 2);
            context.fill();
          }
          active.points.push({ x, y });
        }
      }
      if (cursor.current) {
        cursor.current.style.left = `${100 * x / width}%`;
        cursor.current.style.top = `${100 * y / height}%`;
        cursor.current.hidden = x < 0 || x >= width || y < 0 || y >= height;
      }
    }
  }

  function finish(event: ReactPointerEvent<HTMLCanvasElement>, commit: boolean) {
    const active = stroke.current;
    if (!active || active.id !== event.pointerId) return;
    if (commit) sample(event);
    stroke.current = null;
    const canvas = event.currentTarget;
    const context = canvas.getContext('2d');
    context?.setTransform(1, 0, 0, 1, 0, 0);
    context?.clearRect(0, 0, canvas.width, canvas.height);
    if (cursor.current && (!commit || event.pointerType === 'touch')) cursor.current.hidden = true;
    if (commit && active.points.length) onStroke(active.points);
  }

  return <>
    <span ref={cursor} aria-hidden="true" hidden className="brush-tip"
      style={{ width: `${diameter / width * 100}%`, height: `${diameter / height * 100}%` }} />
    <canvas className="brush-draft" width={preview.width} height={preview.height} aria-label="画笔遮罩画布"
      onPointerDown={event => {
        if (!event.isPrimary || event.button !== 0 || stroke.current) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        stroke.current = { id: event.pointerId, points: [] };
        sample(event);
      }}
      onPointerMove={event => { if (event.isPrimary) sample(event); }}
      onPointerUp={event => finish(event, true)} onPointerCancel={event => finish(event, false)}
      onLostPointerCapture={event => finish(event, false)}
      onPointerLeave={() => { if (cursor.current) cursor.current.hidden = true; }} />
  </>;
}
