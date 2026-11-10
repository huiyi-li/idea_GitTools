import { analyze, type AnalysisRequest, type AnalysisResponse } from './analysis';

self.addEventListener('message', (event: MessageEvent<AnalysisRequest>) => {
  let response: AnalysisResponse;
  try {
    response = { id: event.data.id, result: analyze(event.data) };
  } catch (error) {
    response = { id: event.data.id, error: error instanceof Error ? error.message : String(error) };
  }
  self.postMessage(response);
});
