import { ImageData } from "@napi-rs/canvas";
import concaveman from "concaveman";

export interface GeologicalFeature {
  id: string;
  type: "Water Zone";
  area: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  centroidX: number;
  centroidY: number;
  score: number;
  confidence: number;
  recommended: boolean;
  colorType: string;
  polygon: number[];
  priority: number;
  verticalThickness: number;
  horizontalWidth: number;
  rockAbove: string;
  rockBelow: string;
  rockSurrounding: string;
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

function boxBlur(gray: Float32Array, width: number, height: number, radius: number): Float32Array {
  const out = new Float32Array(gray.length);
  const temp = new Float32Array(gray.length);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    const rowStart = y * width;
    for (let x = -radius; x <= radius; x++) sum += gray[rowStart + Math.max(0, Math.min(width - 1, x))];
    temp[rowStart] = sum;
    for (let x = 1; x < width; x++) {
      sum += gray[rowStart + Math.min(width - 1, x + radius)] - gray[rowStart + Math.max(0, x - radius - 1)];
      temp[rowStart + x] = sum;
    }
  }
  const windowSize = (radius * 2 + 1) * (radius * 2 + 1);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += temp[Math.max(0, Math.min(height - 1, y)) * width + x];
    out[x] = sum / windowSize;
    for (let y = 1; y < height; y++) {
      sum += temp[Math.min(height - 1, y + radius) * width + x] - temp[Math.max(0, y - radius - 1) * width + x];
      out[y * width + x] = sum / windowSize;
    }
  }
  return out;
}

function sobelEdges(gray: Float32Array, width: number, height: number, threshold: number): Uint8Array {
  const edges = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    const row0 = (y - 1) * width;
    const row1 = y * width;
    const row2 = (y + 1) * width;
    for (let x = 1; x < width - 1; x++) {
      const gx = 
        -1 * gray[row0 + x - 1] + 1 * gray[row0 + x + 1] +
        -2 * gray[row1 + x - 1] + 2 * gray[row1 + x + 1] +
        -1 * gray[row2 + x - 1] + 1 * gray[row2 + x + 1];
      const gy = 
        -1 * gray[row0 + x - 1] - 2 * gray[row0 + x] - 1 * gray[row0 + x + 1] +
         1 * gray[row2 + x - 1] + 2 * gray[row2 + x] + 1 * gray[row2 + x + 1];
      const mag = Math.sqrt(gx * gx + gy * gy);
      if (mag > threshold) edges[row1 + x] = 1;
    }
  }
  return edges;
}

function dilate3x3(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y++) {
    let rowStart = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = rowStart + x;
      if (mask[idx]) {
        out[idx] = 1; out[idx - 1] = 1; out[idx + 1] = 1;
        out[idx - width] = 1; out[idx - width - 1] = 1; out[idx - width + 1] = 1;
        out[idx + width] = 1; out[idx + width - 1] = 1; out[idx + width + 1] = 1;
      }
    }
  }
  return out;
}

export function detectGeologicalFeatures(imageData: ImageData, width: number, height: number): VisionResult {
  const data = imageData.data;
  const totalPixels = width * height;
  
  // STEP 1: Crop the profile area. Remove borders, labels, margins.
  const marginX = Math.round(width * 0.08);
  const marginYTop = Math.round(height * 0.15);
  const marginYBot = Math.round(height * 0.08);
  
  const startX = marginX;
  const endX = width - marginX;
  const startY = marginYTop;
  const endY = height - marginYBot;

  const gray = new Float32Array(totalPixels);
  const pixelMap = new Uint8Array(totalPixels); // 0=Bg, 1=Soft(Green), 2=Hard(Orange), 3=Dark/Gap(Black/Blue)
  
  // Create color map (Used ONLY AFTER geometry detection for context)
  for (let y = 0; y < height; y++) {
    let rowStart = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowStart + x;
      const pIdx = idx * 4;
      const r = data[pIdx], g = data[pIdx + 1], b = data[pIdx + 2];
      
      gray[idx] = 0.299 * r + 0.587 * g + 0.114 * b;
      
      const [h, s, l] = rgbToHsl(r, g, b);
      if (l < 20 || (h >= 170 && h <= 280 && s > 20)) {
        pixelMap[idx] = 3; // Black / Dark Blue / Light Blue (Water gap context)
      } else if (h >= 70 && h <= 160 && s > 15 && l > 15) {
        pixelMap[idx] = 1; // Green (Soft Rock)
      } else if ((h >= 10 && h <= 65 || h > 330) && s > 20 && l > 15) {
        pixelMap[idx] = 2; // Orange (Hard Rock)
      }
    }
  }

  // STEP 2: Precompute anomaly map for direct cool-color anomaly segmentation (blue/cyan/green low resistivity)
  const anomalyMap = new Uint8Array(totalPixels);
  for (let y = startY; y < endY; y++) {
    const rowStart = y * width;
    for (let x = startX; x < endX; x++) {
      const idx = rowStart + x;
      const pIdx = idx * 4;
      const r = data[pIdx], g = data[pIdx + 1], b = data[pIdx + 2];
      const [h, s, l] = rgbToHsl(r, g, b);
      // Cool colors (green, cyan, light blue, dark blue) between 75 and 270 hue
      if ((h >= 75 && h <= 270) && (s > 12 && l > 12 && l < 88)) {
        anomalyMap[idx] = 1;
      }
    }
  }

  // STEP 3: Extract connected anomaly components (BFS)
  const visited = new Uint8Array(totalPixels);
  const rawZones: any[] = [];

  for (let y = startY; y < endY; y++) {
    const rowStart = y * width;
    for (let x = startX; x < endX; x++) {
      const idx = rowStart + x;
      if (visited[idx] || anomalyMap[idx] === 0) continue;

      // Start BFS
      const queue: [number, number][] = [[x, y]];
      visited[idx] = 1;
      let qHead = 0;
      
      let area = 0;
      let minX = x, maxX = x, minY = y, maxY = y;
      let sumX = 0, sumY = 0;
      let blueCount = 0;
      let greenCount = 0;
      const points: number[] = [];

      while (qHead < queue.length) {
        const [cx, cy] = queue[qHead++];
        points.push(cx, cy);
        area++;
        sumX += cx;
        sumY += cy;

        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        const pIdx = (cy * width + cx) * 4;
        const r = data[pIdx], g = data[pIdx + 1], b = data[pIdx + 2];
        const [h, s, l] = rgbToHsl(r, g, b);
        if (h >= 160 && h <= 270) {
          blueCount++;
        } else {
          greenCount++;
        }

        const neighbors = [[cx-1, cy], [cx+1, cy], [cx, cy-1], [cx, cy+1]];
        for (let i = 0; i < 4; i++) {
          const nx = neighbors[i][0];
          const ny = neighbors[i][1];
          if (nx >= startX && nx < endX && ny >= startY && ny < endY) {
            const nIdx = ny * width + nx;
            if (!visited[nIdx] && anomalyMap[nIdx] === 1) {
              visited[nIdx] = 1;
              queue.push([nx, ny]);
            }
          }
        }
      }

      // Filter out tiny isolated patches
      if (area < 250) continue;

      // Filter out surface vegetation (mostly green and near the top)
      const isGreenDominant = blueCount / area < 0.15;
      const isNearSurface = minY < startY + (endY - startY) * 0.22;
      if (isGreenDominant && isNearSurface) {
        console.log(`[Debug Log] Ignored surface vegetation patch at Y: ${minY}-${maxY}, Area: ${area}, Green: ${(greenCount/area*100).toFixed(1)}%`);
        continue;
      }

      rawZones.push({
        area,
        minX,
        maxX,
        minY,
        maxY,
        centroidX: sumX / area,
        centroidY: sumY / area,
        blueCount,
        greenCount,
        points
      });
    }
  }

  // STEP 4: Merge nearby raw anomaly zones
  const mergedZones: any[] = [];
  const zoneMerged = new Array(rawZones.length).fill(false);
  const mergeThreshold = height * 0.05; // 5% height distance

  for (let i = 0; i < rawZones.length; i++) {
    if (zoneMerged[i]) continue;
    let merged = { ...rawZones[i], points: [...rawZones[i].points] };
    zoneMerged[i] = true;

    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < rawZones.length; j++) {
        if (!zoneMerged[j]) {
          const target = rawZones[j];
          const xOverlap = Math.max(0, Math.min(merged.maxX, target.maxX) - Math.max(merged.minX, target.minX));
          const yDist = Math.max(0, Math.max(merged.minY, target.minY) - Math.min(merged.maxY, target.maxY));
          
          if (xOverlap > 0 && yDist < mergeThreshold) {
            merged.points.push(...target.points);
            merged.area += target.area;
            merged.minX = Math.min(merged.minX, target.minX);
            merged.maxX = Math.max(merged.maxX, target.maxX);
            merged.minY = Math.min(merged.minY, target.minY);
            merged.maxY = Math.max(merged.maxY, target.maxY);
            merged.centroidX = (merged.centroidX * (merged.area - target.area) + target.centroidX * target.area) / merged.area;
            merged.centroidY = (merged.centroidY * (merged.area - target.area) + target.centroidY * target.area) / merged.area;
            merged.blueCount += target.blueCount;
            merged.greenCount += target.greenCount;
            zoneMerged[j] = true;
            changed = true;
          }
        }
      }
    }
    mergedZones.push(merged);
  }

  // STEP 5: Rank and evaluate all merged water zones
  const waterZones: GeologicalFeature[] = [];

  console.log(`[Debug Log] Total merged water zones: ${mergedZones.length}`);

  mergedZones.forEach((z, idx) => {
    const verticalThickness = z.maxY - z.minY;
    const horizontalWidth = z.maxX - z.minX;

    // Rock above search top block
    let hardAbove = 0, softAbove = 0;
    const searchTop = Math.max(startY, z.minY - 40);
    for (let y = searchTop; y < z.minY; y++) {
      for (let x = z.minX; x <= z.maxX; x++) {
        const type = pixelMap[y * width + x];
        if (type === 2) hardAbove++;
        if (type === 1) softAbove++;
      }
    }

    // Rock surrounding search 30px boundary
    let softSurrounding = 0;
    let hardSurrounding = 0;
    const margin = 30;
    const sMinX = Math.max(startX, z.minX - margin);
    const sMaxX = Math.min(endX - 1, z.maxX + margin);
    const sMinY = Math.max(startY, z.minY - margin);
    const sMaxY = Math.min(endY - 1, z.maxY + margin);

    for (let y = sMinY; y <= sMaxY; y++) {
      for (let x = sMinX; x <= sMaxX; x++) {
        const type = pixelMap[y * width + x];
        if (type === 1) softSurrounding++;
        if (type === 2) hardSurrounding++;
      }
    }

    // Rock inside count
    let softCount = 0;
    let hardCount = 0;
    for (let i = 0; i < z.points.length; i += 2) {
      const type = pixelMap[z.points[i+1] * width + z.points[i]];
      if (type === 1) softCount++;
      if (type === 2) hardCount++;
    }
    softSurrounding = Math.max(0, softSurrounding - softCount);
    hardSurrounding = Math.max(0, hardSurrounding - hardCount);

    // Score components: Area, Continuity (VerticalThickness), Depth (centroidY), Centrality (Distance to center)
    const distanceToCenter = Math.abs(z.centroidX - width / 2);
    const score = 
      (z.area * 0.5) + 
      (verticalThickness * 12) + 
      (z.centroidY * 3) - 
      (distanceToCenter * 4);

    // Concave hull points
    const hullPoints: number[][] = [];
    const step = Math.max(1, Math.floor(z.points.length / 500));
    for (let i = 0; i < z.points.length; i += 2 * step) {
      hullPoints.push([z.points[i], z.points[i+1]]);
    }
    const hull = concaveman(hullPoints, 1, 10);
    const flatHull: number[] = [];
    for (const p of hull) flatHull.push(p[0], p[1]);

    waterZones.push({
      id: "", 
      type: "Water Zone",
      area: z.area,
      minX: z.minX, maxX: z.maxX, minY: z.minY, maxY: z.maxY,
      centroidX: z.centroidX,
      centroidY: z.centroidY,
      score,
      confidence: Math.min(100, Math.floor(65 + (softCount/z.area)*20 + (verticalThickness/height)*20)),
      recommended: false,
      colorType: "black",
      polygon: flatHull,
      priority: 0,
      verticalThickness,
      horizontalWidth,
      rockAbove: hardAbove > softAbove ? "Hard Rock" : (softAbove > hardAbove ? "Soft Rock" : "Mixed"),
      rockBelow: "Unknown", 
      rockSurrounding: softCount > hardCount ? "Soft Rock Dominant" : "Hard Rock Dominant"
    });
  });

  // Sort by score descending to rank them
  waterZones.sort((a, b) => b.score - a.score);

  waterZones.forEach((z, idx) => {
    z.id = `Water Zone ${idx + 1}`;
    z.priority = idx + 1;
    if (idx === 0) {
      z.recommended = true;
      console.log(`[Debug Log] Best Drilling Point selected: ${z.id} (Score: ${z.score.toFixed(1)}, Centroid: Y=${z.centroidY.toFixed(1)}, X=${z.centroidX.toFixed(1)}, Depth Y: ${z.minY}-${z.maxY})`);
    }
  });

  // Print debug log for all zones
  console.log(`[Debug Log] Evaluation of all ranked water zones:`);
  waterZones.forEach((z, idx) => {
    const distanceToCenter = Math.abs(z.centroidX - width / 2);
    console.log(`- Zone #${idx + 1} (${z.id}) at Y: ${z.minY}-${z.maxY} (Centroid Y: ${z.centroidY.toFixed(1)}, Centroid X: ${z.centroidX.toFixed(1)}):`);
    console.log(`  * Metrics: area=${z.area}, width=${z.horizontalWidth}, thickness=${z.verticalThickness}`);
    console.log(`  * Scoring: areaContribution=${(z.area * 0.5).toFixed(1)}, thicknessContribution=${(z.verticalThickness * 12).toFixed(1)}, depthContribution=${(z.centroidY * 3).toFixed(1)}, centralityContribution=${(-distanceToCenter * 4).toFixed(1)} -> Total Score: ${z.score.toFixed(1)}`);
  });

  if (waterZones.length === 0) {
    console.log(`[Debug Log] Best Drilling Point selected: None (No low-resistivity anomalies detected)`);
  }

  return { waterZones, pixelMap };
}
