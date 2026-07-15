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
  polygon: number[]; 
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

export function detectGeologicalFeatures(imageData: ImageData, width: number, height: number): GeologicalFeature[] {
  const data = imageData.data;
  const startY = Math.round(height * 0.2); // Skip header/surface noise
  const totalPixels = width * height;
  
  const pixelType = new Uint8Array(totalPixels);
  
  // Strict color matching
  for (let y = startY; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const pIdx = idx * 4;
      const r = data[pIdx], g = data[pIdx + 1], b = data[pIdx + 2];
      const [h, s, l] = rgbToHsl(r, g, b);

      // Light blue, very light blue, cyan, black anomaly
      // e.g., low lightness (black/dark blue) or hue in blue/cyan range
      if (
        l < 25 || 
        (b > r + 20 && b > g + 20 && l < 60) || 
        (h >= 180 && h <= 280 && s > 20)
      ) {
        pixelType[idx] = 3; // Water Gap
      } else if (h >= 70 && h <= 170 && s > 20 && l > 20) {
        pixelType[idx] = 1; // Soft Rock
      } else if ((h < 60 || h > 330) && s > 30 && l > 30) {
        pixelType[idx] = 2; // Hard Rock
      }
    }
  }

  // BFS to find connected components
  const visited = new Uint8Array(totalPixels);
  const rawFeatures: any[] = [];

  for (let y = startY; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (visited[idx] || pixelType[idx] === 0) continue;

      const t = pixelType[idx];
      
      const queue: [number, number][] = [[x, y]];
      visited[idx] = 1;
      
      let area = 0, minX = x, maxX = x, minY = y, maxY = y;
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

        // 8-connected to merge nearby structures slightly better
        for (let ny = cy - 1; ny <= cy + 1; ny++) {
          for (let nx = cx - 1; nx <= cx + 1; nx++) {
            if (nx >= 0 && nx < width && ny >= startY && ny < height) {
              const nIdx = ny * width + nx;
              if (!visited[nIdx] && pixelType[nIdx] === t) {
                visited[nIdx] = 1;
                queue.push([nx, ny]);
              }
            }
          }
        }
      }

      // Ignore thin noise
      if (area > (width * height * 0.001)) {
        rawFeatures.push({ type: t, area, minX, maxX, minY, maxY, sumX, sumY, points });
      }
    }
  }

  const features: GeologicalFeature[] = [];
  let waterZoneCount = 1;

  for (const comp of rawFeatures) {
    const isWater = comp.type === 3;
    const isSoft = comp.type === 1;

    // Concave hull
    const hullPoints: number[][] = [];
    const step = Math.max(1, Math.floor(comp.points.length / 2000));
    for (let i = 0; i < comp.points.length; i += 2 * step) {
      hullPoints.push([comp.points[i], comp.points[i+1]]);
    }
    const hull = concaveman(hullPoints, 2, 0.005);
    const flatHull: number[] = [];
    for (const p of hull) flatHull.push(p[0], p[1]);

    // Scoring for Water Gaps: Prefer shallower, larger, continuous
    let score = 0;
    if (isWater) {
      const depthWeight = 1.0 - (comp.minY / height); // shallower = better
      const sizeWeight = comp.area / (width * height);
      score = Math.round((comp.area * 0.05) + (sizeWeight * 500) + (depthWeight * 50));
    }

    features.push({
      id: isWater ? `Water Zone ${waterZoneCount++}` : (isSoft ? "Soft Rock" : "Hard Rock"),
      type: isWater ? "Water-Bearing Gap" : (isSoft ? "Soft Rock" : "Hard Rock"),
      area: comp.area,
      minX: comp.minX, maxX: comp.maxX, minY: comp.minY, maxY: comp.maxY,
      centroidX: comp.sumX / comp.area,
      centroidY: comp.sumY / comp.area,
      score,
      confidence: Math.min(100, Math.floor(80 + (comp.area / (width*height)) * 100)),
      points: new Int32Array(comp.points),
      recommended: false,
      colorType: isWater ? "black" : (isSoft ? "green" : "orange"),
      polygon: flatHull
    });
  }

  // Find the best drilling point (Water Zone with highest score)
  const waterGaps = features.filter(f => f.type === "Water-Bearing Gap");
  if (waterGaps.length > 0) {
    waterGaps.sort((a, b) => b.score - a.score);
    waterGaps[0].recommended = true;
  }

  return features;
}
