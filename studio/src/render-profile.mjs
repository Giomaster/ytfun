/** The stored canvas is independent of duration/scene-count format limits. */
export function renderProfile(renderCanvas = 'portrait') {
  if (!['portrait', 'landscape'].includes(renderCanvas)) throw new Error('renderCanvas must be portrait or landscape');
  return renderCanvas === 'landscape'
    ? { width: 1920, height: 1080, framesPerSecond: 30 }
    : { width: 1080, height: 1920, framesPerSecond: 30 };
}
