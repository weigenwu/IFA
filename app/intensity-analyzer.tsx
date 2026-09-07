'use client';

import { useEffect, useRef } from 'react';
import Analyzer from './analyzer';

function findInput(root: HTMLElement, labelText: string, selector: string) {
  const label = Array.from(root.querySelectorAll('label')).find(candidate => candidate.textContent?.includes(labelText));
  return label?.querySelector<HTMLInputElement>(selector) ?? null;
}

export default function IntensityAnalyzer() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let queued = false;
    const syncScaleBarAvailability = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        const pixelSizeInput = findInput(root, '像素尺寸', 'input[type="number"]');
        const scaleBarToggle = findInput(root, '导出显示比例尺', 'input[type="checkbox"]');
        if (!pixelSizeInput || !scaleBarToggle || !scaleBarToggle.checked) return;

        const pixelSize = Number(pixelSizeInput.value);
        if (!Number.isFinite(pixelSize) || pixelSize <= 0) {
          scaleBarToggle.click();
        }
      });
    };

    const observer = new MutationObserver(syncScaleBarAvailability);
    observer.observe(root, { childList: true, subtree: true });
    root.addEventListener('input', syncScaleBarAvailability, true);
    root.addEventListener('change', syncScaleBarAvailability, true);
    syncScaleBarAvailability();

    return () => {
      observer.disconnect();
      root.removeEventListener('input', syncScaleBarAvailability, true);
      root.removeEventListener('change', syncScaleBarAvailability, true);
    };
  }, []);

  return <div ref={rootRef}><Analyzer mode="intensity" /></div>;
}
