import { analyzeScratch, analyzeTranswell, type RGBAFrame, type ScratchParameters, type TranswellParameters } from './migration';

export type MigrationRequest =
  | { id: string | number; mode: 'scratch'; frame: RGBAFrame; parameters: ScratchParameters }
  | { id: string | number; mode: 'transwell'; frame: RGBAFrame; parameters: TranswellParameters };

self.onmessage = (event: MessageEvent<MigrationRequest>) => {
  const request = event.data;
  try {
    if (request.mode === 'scratch') {
      self.postMessage({ id: request.id, mode: request.mode, result: analyzeScratch(request.frame, request.parameters) });
    } else if (request.mode === 'transwell') {
      const result = analyzeTranswell(request.frame, request.parameters);
      self.postMessage({ id: request.id, mode: request.mode, result }, { transfer: [result.mask.buffer] });
    } else throw new Error('未知分析模式。');
  } catch (cause) {
    self.postMessage({ id: request?.id, mode: request?.mode, error: cause instanceof Error ? cause.message : String(cause) });
  }
};
