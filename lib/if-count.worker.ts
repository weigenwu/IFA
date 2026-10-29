import { analyzeIf } from './if-count';

self.onmessage = event => {
  try {
    const { nucleus, a, b, width, height, parameters, regions } = event.data;
    self.postMessage({ result: analyzeIf(nucleus, a, b, width, height, parameters, regions) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
