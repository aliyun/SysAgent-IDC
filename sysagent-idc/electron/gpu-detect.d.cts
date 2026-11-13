export interface DetectGpuOptions {
  env?: Record<string, string | undefined>;
  platform?: string;
  pciRoot?: string;
  devRoot?: string;
  run?: typeof import('node:child_process').spawnSync;
}

export function detectGpu(options?: DetectGpuOptions): boolean;
export function hasRenderNode(driRoot?: string): boolean;
