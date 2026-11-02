import { analyzeColony, type ColonyCircle, type ColonyParameters } from './colony';
import type { RGBAFrame } from './migration';

self.onmessage = (event: MessageEvent<{ frame: RGBAFrame; roi: ColonyCircle; parameters: ColonyParameters }>) => {
  try { self.postMessage({ result: analyzeColony(event.data.frame, event.data.roi, event.data.parameters) }); }
  catch (cause) { self.postMessage({ error: cause instanceof Error ? cause.message : String(cause) }); }
};
