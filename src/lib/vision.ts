import { ImageData } from "@napi-rs/canvas";
import concaveman from "concaveman";

export interface GeologicalFeature {
  id: string;
  type: "Soft Rock" | "Hard Rock" | "Water-Bearing Gap";
  area: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  centroidX: number;
  centroidY: number;
  score: number;
  confidence: number;
  points: Int32Array;
  recommended: boolean;
  colorType: string;
  fillRatio: number; // area / bounding box area — used to decide ellipse vs contour
  polygon: number[]; // Alternating x, y array of tight concave hull vertices
}

function rgbToHsl(r: number, g: number, b: number) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}

/**
 * Morphological erosion: removes boundary pixels of a given type.
 * A pixel survives only if ALL 4 cardinal neighbours share the same type.
 * Running N passes breaks thin bridges between touching blobs.
 */
function erodeMask(pixelType: Uint8Array, width: number, height: number, startY: number, targetType: number, passes: number): Uint8Array {
  let current = new Uint8Array(pixelType);
  for (let pass = 0; pass < passes; pass++) {
    const next = new Uint8Array(current);
    for (let y = startY + 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        if (current[idx] !== targetType) continue;
        // Check 4-connected neighbours
        if (
          current[idx - 1] !== targetType ||
          current[idx + 1] !== targetType ||
          current[idx - width] !== targetType ||
          current[idx + width] !== targetType
        ) {
          next[idx] = 0; // erode away
        }
      }
    }
    current = next;
  }
  return current;
}

/**
 * BFS flood-fill to extract one connected component from a binary mask.
 */
function extractComponent(
  mask: Uint8Array, visited: Uint8Array,
  startX: number, startY: number,
  targetType: number, width: number, height: number, minScanY: number
): { area: number; minX: number; maxX: number; minY: number; maxY: number; sumX: number; sumY: number; points: number[] } {
  const queue: [number, number][] = [[startX, startY]];
  visited[startY * width + startX] = 1;

  let area = 0, minX = startX, maxX = startX, minY = startY, maxY = startY;
  let sumX = 0, sumY = 0;
  const points: number[] = [];
  let qHead = 0;

  while (qHead < queue.length) {
    const [cx, cy] = queue[qHead++];
    points.push(cx, cy);
    area++;
    sumX += cx; sumY += cy;
    if (cx < minX) minX = cx;
    if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy;
    if (cy > maxY) maxY = cy;

    for (const [nx, ny] of [[cx-1,cy],[cx+1,cy],[cx,cy-1],[cx,cy+1]]) {
      if (nx >= 0 && nx < width && ny >= minScanY && ny < height) {
        const nIdx = ny * width + nx;
        if (!visited[nIdx] && mask[nIdx] === targetType) {
          visited[nIdx] = 1;
          queue.push([nx, ny]);
        }
      }
    }
  }

  return { area, minX, maxX, minY, maxY, sumX, sumY, points };
}

/**
 * Sub-split a wide component by scanning vertical columns.
 * If a column has zero pixels of this component, that's a split boundary.
 */
function subSplitWide(
  points: number[], width: number, minX: number, maxX: number
): number[][] {
  // Build column histogram
  const colCount = new Uint32Array(width);
  for (let i = 0; i < points.length; i += 2) {
    colCount[points[i]]++;
  }

  // Find contiguous horizontal runs
  const runs: [number, number][] = [];
  let runStart = -1;
  for (let x = minX; x <= maxX; x++) {
    if (colCount[x] > 0) {
      if (runStart === -1) runStart = x;
    } else {
      if (runStart !== -1) {
        runs.push([runStart, x - 1]);
        runStart = -1;
      }
    }
  }
  if (runStart !== -1) runs.push([runStart, maxX]);

  if (runs.length <= 1) return [points]; // cannot split

  // Assign each point to its run
  const subGroups: number[][] = runs.map(() => []);
  for (let i = 0; i < points.length; i += 2) {
    const px = points[i], py = points[i + 1];
    for (let r = 0; r < runs.length; r++) {
      if (px >= runs[r][0] && px <= runs[r][1]) {
        subGroups[r].push(px, py);
        break;
      }
    }
  }

  return subGroups.filter(g => g.length >= 4); // at least 2 pixels
}

export function detectGeologicalFeatures(imageData: ImageData, width: number, height: number): GeologicalFeature[] {
  const data = imageData.data;
  const startY = Math.round(height * 0.2);
  const totalPixels = width * height;
  
  // --- STEP 1: Color segmentation ---
  const pixelType = new Uint8Array(totalPixels);
  for (let y = startY; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const pIdx = idx * 4;
      const r = data[pIdx], g = data[pIdx + 1], b = data[pIdx + 2];
      const [h, s, l] = rgbToHsl(r, g, b);

      if (l < 25 || (b > r + 30 && b > g + 30 && l < 40) || (h >= 200 && h <= 280 && l < 35)) {
        pixelType[idx] = 3; // Dark / Water Gap
      } else if (h >= 70 && h <= 170 && s > 20 && l > 20) {
        pixelType[idx] = 1; // Green / Soft Rock
      } else if ((h < 60 || h > 330) && s > 30 && l > 30) {
        pixelType[idx] = 2; // Orange / Hard Rock
      }
    }
  }

  // --- STEP 2: Morphological erosion on dark pixels to break thin bridges ---
  const erodedDark = erodeMask(pixelType, width, height, startY, 3, 3);

  // --- STEP 3: Connected component analysis on eroded dark mask ---
  const visitedDark = new Uint8Array(totalPixels);
  const rawDarkComponents: { area: number; minX: number; maxX: number; minY: number; maxY: number; sumX: number; sumY: number; points: number[] }[] = [];

  for (let y = startY; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (visitedDark[idx] || erodedDark[idx] !== 3) continue;
      const comp = extractComponent(erodedDark, visitedDark, x, y, 3, width, height, startY);
      rawDarkComponents.push(comp);
    }
  }

  // --- STEP 4: For each eroded component, recover the ORIGINAL (pre-erosion) pixels ---
  // Map eroded component seeds back to original pixelType to get tight original boundaries
  const componentLabel = new Int32Array(totalPixels); // 0 = unlabeled
  for (let ci = 0; ci < rawDarkComponents.length; ci++) {
    const comp = rawDarkComponents[ci];
    // BFS from every eroded pixel, expanding into original dark pixels
    const label = ci + 1;
    const queue: [number, number][] = [];
    for (let i = 0; i < comp.points.length; i += 2) {
      const px = comp.points[i], py = comp.points[i + 1];
      const idx = py * width + px;
      if (componentLabel[idx] === 0) {
        componentLabel[idx] = label;
        queue.push([px, py]);
      }
    }
    let qHead = 0;
    while (qHead < queue.length) {
      const [cx, cy] = queue[qHead++];
      for (const [nx, ny] of [[cx-1,cy],[cx+1,cy],[cx,cy-1],[cx,cy+1]]) {
        if (nx >= 0 && nx < width && ny >= startY && ny < height) {
          const nIdx = ny * width + nx;
          if (componentLabel[nIdx] === 0 && pixelType[nIdx] === 3) {
            componentLabel[nIdx] = label;
            queue.push([nx, ny]);
          }
        }
      }
    }
  }

  // Gather the recovered components
  const recoveredComps: Map<number, { points: number[]; minX: number; maxX: number; minY: number; maxY: number; sumX: number; sumY: number; area: number }> = new Map();
  for (let y = startY; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const lbl = componentLabel[idx];
      if (lbl === 0) continue;
      if (!recoveredComps.has(lbl)) {
        recoveredComps.set(lbl, { points: [], minX: x, maxX: x, minY: y, maxY: y, sumX: 0, sumY: 0, area: 0 });
      }
      const c = recoveredComps.get(lbl)!;
      c.points.push(x, y);
      c.area++;
      c.sumX += x; c.sumY += y;
      if (x < c.minX) c.minX = x;
      if (x > c.maxX) c.maxX = x;
      if (y < c.minY) c.minY = y;
      if (y > c.maxY) c.maxY = y;
    }
  }

  // --- STEP 5: Build features ---
  const features: GeologicalFeature[] = [];
  let gapIdCount = 1;
  const totalSearchArea = width * (height - startY);
  const maxAnomalyWidthRatio = 0.55; // anomaly should NOT span > 55% of image width

  for (const [, comp] of recoveredComps) {
    if (comp.area < totalSearchArea * 0.001) continue; // too small = noise

    const bw = comp.maxX - comp.minX + 1;
    const bh = comp.maxY - comp.minY + 1;
    const bbArea = bw * bh;
    const fillRatio = comp.area / bbArea;

    // If region is extremely wide, try to sub-split it
    let subComponents: number[][] = [comp.points];
    if (bw > width * maxAnomalyWidthRatio) {
      subComponents = subSplitWide(comp.points, width, comp.minX, comp.maxX);
    }

    for (const subPoints of subComponents) {
      if (subPoints.length < 20) continue; // need at least 10 pixels

      // Recalculate bounds for this sub-component
      let sMinX = Infinity, sMaxX = -Infinity, sMinY = Infinity, sMaxY = -Infinity;
      let sSumX = 0, sSumY = 0;
      const sArea = subPoints.length / 2;
      for (let i = 0; i < subPoints.length; i += 2) {
        const px = subPoints[i], py = subPoints[i + 1];
        sSumX += px; sSumY += py;
        if (px < sMinX) sMinX = px;
        if (px > sMaxX) sMaxX = px;
        if (py < sMinY) sMinY = py;
        if (py > sMaxY) sMaxY = py;
      }
      if (sArea < totalSearchArea * 0.001) continue;

      const sw = sMaxX - sMinX + 1;
      const sh = sMaxY - sMinY + 1;
      const sBBArea = sw * sh;
      const sFillRatio = sArea / sBBArea;

      // Scoring
      const compactness = sFillRatio;
      const depthWeight = 1.0 + (sMinY / height);
      const sizeWeight = sArea / totalSearchArea;
      const score = Math.round(
        (sArea * 0.03) +
        (compactness * 60) +
        (sizeWeight * 200) +
        (depthWeight * 15)
      );

      let confidence = Math.min(100, Math.round(sFillRatio * 80) + 25);
      if (confidence > 100) confidence = 100;

      // Calculate concave hull (downsample points for performance)
      const hullPoints: number[][] = [];
      const step = Math.max(1, Math.floor(subPoints.length / 4000)); 
      for (let i = 0; i < subPoints.length; i += 2 * step) {
        hullPoints.push([subPoints[i], subPoints[i+1]]);
      }
      const hull = concaveman(hullPoints, 2, 0.005);
      const flatHull: number[] = [];
      for (const p of hull) {
        flatHull.push(p[0], p[1]);
      }

      features.push({
        id: `A${gapIdCount++}`,
        type: "Water-Bearing Gap",
        area: sArea,
        minX: sMinX, maxX: sMaxX, minY: sMinY, maxY: sMaxY,
        centroidX: sSumX / sArea,
        centroidY: sSumY / sArea,
        score,
        confidence,
        points: new Int32Array(subPoints),
        recommended: false,
        colorType: "black",
        fillRatio: sFillRatio,
        polygon: flatHull
      });
    }
  }

  // --- STEP 6: Soft Rock and Hard Rock (simple BFS, no erosion needed) ---
  const visitedRock = new Uint8Array(totalPixels);
  let softIdCount = 1, hardIdCount = 1;

  for (let y = startY; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const t = pixelType[idx];
      if (visitedRock[idx] || t === 0 || t === 3) continue;

      const comp = extractComponent(pixelType, visitedRock, x, y, t, width, height, startY);
      if (comp.area < totalSearchArea * 0.01) continue;

      const bw = comp.maxX - comp.minX + 1;
      const bh = comp.maxY - comp.minY + 1;
      const fillRatio = comp.area / (bw * bh);

      // Calculate concave hull
      const hullPoints: number[][] = [];
      const step = Math.max(1, Math.floor(comp.points.length / 4000));
      for (let i = 0; i < comp.points.length; i += 2 * step) {
        hullPoints.push([comp.points[i], comp.points[i+1]]);
      }
      const hull = concaveman(hullPoints, 2, 0.005);
      const flatHull: number[] = [];
      for (const p of hull) {
        flatHull.push(p[0], p[1]);
      }

      features.push({
        id: t === 1 ? `S${softIdCount++}` : `H${hardIdCount++}`,
        type: t === 1 ? "Soft Rock" : "Hard Rock",
        area: comp.area,
        minX: comp.minX, maxX: comp.maxX, minY: comp.minY, maxY: comp.maxY,
        centroidX: comp.sumX / comp.area,
        centroidY: comp.sumY / comp.area,
        score: 0,
        confidence: Math.min(100, Math.round(fillRatio * 80) + 25),
        points: new Int32Array(comp.points),
        recommended: false,
        colorType: t === 1 ? "green" : "orange",
        fillRatio,
        polygon: flatHull
      });
    }
  }

  // --- STEP 7: Recommend the highest-scoring water gap ---
  const waterGaps = features.filter(f => f.type === "Water-Bearing Gap");
  if (waterGaps.length > 0) {
    waterGaps.sort((a, b) => b.score - a.score);
    waterGaps[0].recommended = true;
  }

  return features;
}

/**
 * Generate a binary detection mask image for debugging.
 * Returns raw RGBA pixel data (width x height x 4).
 */
export function generateDetectionMask(imageData: ImageData, width: number, height: number): Uint8Array {
  const data = imageData.data;
  const startY = Math.round(height * 0.2);
  const out = new Uint8Array(width * height * 4);

  // Fill with white
  for (let i = 0; i < out.length; i += 4) {
    out[i] = 255; out[i+1] = 255; out[i+2] = 255; out[i+3] = 255;
  }

  for (let y = startY; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const pIdx = idx * 4;
      const r = data[pIdx], g = data[pIdx + 1], b = data[pIdx + 2];
      const [h, s, l] = rgbToHsl(r, g, b);

      const oIdx = idx * 4;
      if (l < 25 || (b > r + 30 && b > g + 30 && l < 40) || (h >= 200 && h <= 280 && l < 35)) {
        out[oIdx] = 30; out[oIdx+1] = 64; out[oIdx+2] = 175; out[oIdx+3] = 255; // Blue = water gap
      } else if (h >= 70 && h <= 170 && s > 20 && l > 20) {
        out[oIdx] = 34; out[oIdx+1] = 197; out[oIdx+2] = 94; out[oIdx+3] = 255; // Green = soft rock
      } else if ((h < 60 || h > 330) && s > 30 && l > 30) {
        out[oIdx] = 234; out[oIdx+1] = 138; out[oIdx+2] = 36; out[oIdx+3] = 255; // Orange = hard rock
      }
    }
  }
  return out;
}
