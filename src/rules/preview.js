// The Makeup VTO request for one catalogue shade on the shopper's own photo.

// PROVISIONAL until the live visibility check, which records the coverage at which two shades
// about 3 ΔE00 apart are visibly different on the split face.
export const PREVIEW_INTENSITY = Object.freeze({ colorIntensity: 70, coverageIntensity: 60 });
export const PREVIEW_PROVISIONAL = true;

export const GLOW_BY_FINISH = Object.freeze({ matte: 0, satin: 30, radiant: 60 });

export function makeupVtoBody(fileId, shade, finish) {
  return {
    src_file_id: fileId,
    version: "1.0",
    effects: [
      {
        category: "foundation",
        palettes: [
          {
            color: shade.hex,
            colorIntensity: PREVIEW_INTENSITY.colorIntensity,
            glowIntensity: GLOW_BY_FINISH[finish],
            coverageIntensity: PREVIEW_INTENSITY.coverageIntensity,
          },
        ],
      },
      // The docs apply a default smoothing of 50 unless it is set to 0, which would show a
      // beauty filter instead of the shade.
      { category: "skin_smooth", skinSmoothStrength: 0, skinSmoothColorIntensity: 0 },
    ],
  };
}
