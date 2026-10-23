import { analyzeEdu, cleanupDisplay, cleanupEduDisplay } from './edu';
import type { NumericArray } from './analysis';
import type { EduParameters, EduDisplayOptions } from './edu';

self.onmessage = (event: MessageEvent<{ operation: 'analyze' | 'clean'; nucleus: NumericArray; edu: NumericArray; width: number; height: number; parameters: EduParameters; blueFloor: number; blueSpeckle: number; redOptions: EduDisplayOptions }>) => {
  try {
    const request = event.data;
    if (request.operation === 'analyze') {
      const result = analyzeEdu(request.nucleus, request.edu, request.width, request.height, request.parameters);
      self.postMessage({ result }, { transfer: [result.labels.buffer] });
    } else {
      const nucleus = cleanupDisplay(request.nucleus, request.width, request.height, request.blueFloor, request.blueSpeckle);
      const edu = cleanupEduDisplay(request.edu, request.nucleus, request.width, request.height, request.redOptions);
      self.postMessage({ nucleus, edu }, { transfer: [nucleus.buffer, edu.buffer] });
    }
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
