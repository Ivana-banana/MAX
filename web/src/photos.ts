/**
 * University photos for the start and finale screens: `photos/<university id>.webp`.
 *
 * A new university needs no code here, only its file; without one the screen keeps the red cut,
 * circle and ring. Photos are Public Domain or CC0 from Wikimedia Commons (see photos/SOURCES.md),
 * stored in grayscale: the duotone and halftone are CSS, so both themes share one file.
 */

const files = import.meta.glob<string>("./photos/*.webp", { eager: true, import: "default", query: "?url" });

export function universityPhoto(universityId: string): string | undefined {
  return files[`./photos/${universityId}.webp`];
}
