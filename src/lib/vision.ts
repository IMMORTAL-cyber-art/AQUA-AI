import { ImageData } from "@napi-rs/canvas";
import concaveman from "concaveman";

export interface GeologicalFeature {
  id: string;
  type: "Water-Bearing Gap";
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
  priority: number;
}

export interface VisionResult {
  waterZones: GeologicalFeature[];
  pixelMap: Uint8Array;
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

export function detectGeologicalFeatures(imageData: ImageData, width: number, height: number): VisionResult {
  const data = imageData.data;
  const startY = Math.round(height * 0.15); // Skip surface noise/header
  const totalPixels = width * height;
  
  const pixelMap = new Uint8Array(totalPixels); // 0=Bg, 1=Soft(Green), 2=Hard(Orange), 3=Gap(Black/Blue)
  
  // 1. Contextual Classification
  for (let y = startY; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const pIdx = idx * 4;
      const r = data[pIdx], g = data[pIdx + 1], b = data[pIdx + 2];
      const [h, s, l] = rgbToHsl(r, g, b);

      if (
        l < 25 || // Black anomaly
        (b > r + 20 && b > g + 20 && l < 60) || // cyan / light blue
        (h >= 180 && h <= 280 && s > 20)
      ) {
        pixelMap[idx] = 3; // Water Gap
      } else if (h >= 70 && h <= 170 && s > 15 && l > 15) {
        pixelMap[idx] = 1; // Soft Rock (Green)
      } else if ((h < 60 || h > 330) && s > 20 && l > 20) {
        pixelMap[idx] = 2; // Hard Rock (Orange)
      }
    }
  }

  // 2. Extract ONLY Water Gaps (Enclosed anomalies)
  const visited = new Uint8Array(totalPixels);
  const rawGaps: any[] = [];
  
  const borderMargin = Math.round(width * 0.05);

  for (let y = startY; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (visited[idx] || pixelMap[idx] !== 3) continue;
      
      const queue: [number, number][] = [[x, y]];
      visited[idx] = 1;
      
      let area = 0, minX = x, maxX = x, minY = y, maxY = y;
      let sumX = 0, sumY = 0;
      const points: number[] = [];
      let qHead = 0;
      let touchesBorder = false;

      while (qHead < queue.length) {
        const [cx, cy] = queue[qHead++];
        points.push(cx, cy);
        area++;
        sumX += cx; sumY += cy;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        if (cx <= borderMargin || cx >= width - borderMargin || cy >= height - borderMargin) {
          touchesBorder = true;
        }

        // 8-connected
        for (let ny = cy - 1; ny <= cy + 1; ny++) {
          for (let nx = cx - 1; nx <= cx + 1; nx++) {
            if (nx >= 0 && nx < width && ny >= startY && ny < height) {
              const nIdx = ny * width + nx;
              if (!visited[nIdx] && pixelMap[nIdx] === 3) {
                visited[nIdx] = 1;
                queue.push([nx, ny]);
              }
            }
          }
        }
      }

      // Ignore page borders or tiny noise
      if (!touchesBorder && area > (width * height * 0.0005) && area < (width * height * 0.2)) {
        
        // Analyze surrounding geological context
        let softRockCount = 0;
        let hardRockCount = 0;
        let hardRockAboveCount = 0;
        
        // Expand bounding box slightly to check context
        const searchMinX = Math.max(0, minX - 10);
        const searchMaxX = Math.min(width - 1, maxX + 10);
        const searchMinY = Math.max(startY, minY - 20); // Check more above
        const searchMaxY = Math.min(height - 1, maxY + 10);
        
        for (let sy = searchMinY; sy <= searchMaxY; sy++) {
          for (let sx = searchMinX; sx <= searchMaxX; sx++) {
            const ctxType = pixelMap[sy * width + sx];
            if (ctxType === 1) softRockCount++;
            if (ctxType === 2) {
              hardRockCount++;
              if (sy < minY) hardRockAboveCount++;
            }
          }
        }

        rawGaps.push({ 
          area, minX, maxX, minY, maxY, sumX, sumY, points,
          softRockCount, hardRockCount, hardRockAboveCount 
        });
      }
    }
  }

  const waterZones: GeologicalFeature[] = [];
  let zoneCount = 1;

  for (const gap of rawGaps) {
    const hullPoints: number[][] = [];
    const step = Math.max(1, Math.floor(gap.points.length / 2000));
    for (let i = 0; i < gap.points.length; i += 2 * step) {
      hullPoints.push([gap.points[i], gap.points[i+1]]);
    }
    const hull = concaveman(hullPoints, 2, 0.005);
    const flatHull: number[] = [];
    for (const p of hull) flatHull.push(p[0], p[1]);

    // Geological Borewell Interpretation Scoring
    // 1. Shallower depth (higher Y is deeper, so lower Y is better)
    const depthWeight = (height - gap.minY) / height; 
    
    // 2. Larger connected gap
    const sizeWeight = gap.area / (width * height);
    
    // 3. Less hard rock above it
    const hardRockPenalty = gap.hardRockAboveCount * 0.5;
    
    // 4. Presence of soft-rock fracture (green) around it
    const softRockBonus = gap.softRockCount * 0.2;

    const score = Math.round(
      (depthWeight * 2000) + 
      (sizeWeight * 10000) + 
      (softRockBonus) - 
      (hardRockPenalty)
    );

    waterZones.push({
      id: `Water Zone`, // Will be numbered after sorting
      type: "Water-Bearing Gap",
      area: gap.area,
      minX: gap.minX, maxX: gap.maxX, minY: gap.minY, maxY: gap.maxY,
      centroidX: gap.sumX / gap.area,
      centroidY: gap.sumY / gap.area,
      score,
      confidence: Math.min(100, Math.floor(75 + (gap.softRockCount / (gap.area + 1)) * 10 - (gap.hardRockAboveCount / (gap.area + 1)) * 10)),
      points: new Int32Array(gap.points),
      recommended: false,
      colorType: "black",
      polygon: flatHull,
      priority: 0
    });
  }

  // Sort by priority (score descending)
  waterZones.sort((a, b) => b.score - a.score);
  
  // Assign numbering and recommendation
  waterZones.forEach((z, idx) => {
    z.id = `Water Zone ${idx + 1}`;
    z.priority = idx + 1;
    if (idx === 0) z.recommended = true;
  });

  return { waterZones, pixelMap };
}
