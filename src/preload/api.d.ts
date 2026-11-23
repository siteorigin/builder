import type { BuilderApi } from '../shared/api';
declare global {
  interface Window {
    builder: BuilderApi;
  }
}
export {};
