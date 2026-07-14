/**
 * Sample kit — real recorded drums (GMRockKit: see samples/real/LICENSE.md).
 *
 * Each drum has five velocity layers (separate recordings of soft → hard
 * strokes, not volume-scaled copies). The layer boundaries come from the
 * kit's own Hydrogen definition, so dynamics land where the drummer meant
 * them to. On top of layer selection, playback applies a smooth
 * velocity-following gain and a ±1.5% playback-rate humanization so fast
 * repeated hits never sound like the same file machine-gunned.
 */

export const REAL_KIT_MANIFEST = {
  kick: {
    boundaries: [0.203, 0.37, 0.732, 0.866], // from GMRockKit drumkit.xml
    files: ['kick_1.wav', 'kick_2.wav', 'kick_3.wav', 'kick_4.wav', 'kick_5.wav'],
  },
  snare: {
    boundaries: [0.203, 0.377, 0.569, 0.783],
    files: ['snare_1.wav', 'snare_2.wav', 'snare_3.wav', 'snare_4.wav', 'snare_5.wav'],
  },
  hat: {
    boundaries: [0.203, 0.377, 0.569, 0.783],
    files: ['hat_1.wav', 'hat_2.wav', 'hat_3.wav', 'hat_4.wav', 'hat_5.wav'],
  },
  openhat: {
    boundaries: [0.203, 0.377, 0.569, 0.783],
    files: ['openhat_1.wav', 'openhat_2.wav', 'openhat_3.wav', 'openhat_4.wav', 'openhat_5.wav'],
  },
};

/** Which velocity layer a hit falls into (0 = softest). Pure, testable. */
export function layerIndex(boundaries, velocity) {
  let idx = 0;
  for (const b of boundaries) {
    if (velocity > b) idx++;
    else break;
  }
  return idx;
}

/**
 * Fetch and decode every layer of the real kit.
 * @returns {Promise<Record<'kick'|'snare'|'hat', {boundaries:number[], buffers:AudioBuffer[]}>>}
 *   AudioBuffers are context-independent, so the result is reusable in an
 *   OfflineAudioContext for WAV export.
 */
export async function loadRealKit(ctx, baseUrl = 'samples/real/') {
  const kit = {};
  await Promise.all(Object.entries(REAL_KIT_MANIFEST).map(async ([drum, spec]) => {
    const buffers = await Promise.all(spec.files.map(async (file) => {
      const res = await fetch(baseUrl + file);
      if (!res.ok) throw new Error(`sample ${file}: HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      return ctx.decodeAudioData(bytes);
    }));
    kit[drum] = { boundaries: spec.boundaries, buffers };
  }));
  return kit;
}
