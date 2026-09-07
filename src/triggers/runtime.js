import { recordIncident } from '../usecases/incidents.js';

export async function triggerRuntime() {
  return {
    recordIncident
  };
}
