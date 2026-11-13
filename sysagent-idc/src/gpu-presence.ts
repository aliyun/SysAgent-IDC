let cached: boolean | undefined;

function probeWebgl(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl', { failIfMajorPerformanceCaveat: true });
    if (!gl) return false;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /nvidia|geforce|quadro|tesla|radeon|amd|intel|apple/i.test(renderer)
      && !/swiftshader|llvmpipe|softpipe|software|vmware|virgl/i.test(renderer);
  } catch {
    return false;
  }
}

// Host-provided flag first, then ?gpu=0|1, then a WebGL renderer probe for the plain browser build.
export function detectGpu(): boolean {
  if (cached !== undefined) return cached;
  const hosted = window.sysomDesktop?.gpu;
  const param = new URLSearchParams(window.location.search).get('gpu');
  cached = typeof hosted === 'boolean' ? hosted : param === '0' || param === '1' ? param === '1' : probeWebgl();
  return cached;
}
