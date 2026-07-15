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

  // STEP 2: Detect every geological contour (using Sobel Edge Detection on blurred grayscale)
  // Blur heavily to eliminate grid lines and text.
  const blurredGray = boxBlur(gray, width, height, 5);
  let edges = sobelEdges(blurredGray, width, height, 12);
  
  // Dilate edges to create solid closed loops (contours)
  edges = dilate3x3(edges, width, height);
  edges = dilate3x3(edges, width, height);
  edges = dilate3x3(edges, width, height);

  // STEP 3 & 4: Extract closed geological regions / Find cavities enclosed by surrounding layers
  const visited = new Uint8Array(totalPixels);
  const rawCavities: any[] = [];
  
  for (let y = startY; y < endY; y++) {
    let rowStart = y * width;
    for (let x = startX; x < endX; x++) {
      const idx = rowStart + x;
      if (visited[idx] || edges[idx] === 1) continue;
      
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

        if (cx <= startX + 2 || cx >= endX - 2 || cy <= startY + 2 || cy >= endY - 2) {
          touchesBorder = true;
        }

        const neighbors = [[cx-1, cy], [cx+1, cy], [cx, cy-1], [cx, cy+1]];
        for (let i=0; i<4; i++) {
          const nx = neighbors[i][0];
          const ny = neighbors[i][1];
          if (nx >= startX && nx < endX && ny >= startY && ny < endY) {
            const nIdx = ny * width + nx;
            if (!visited[nIdx] && edges[nIdx] === 0) {
              visited[nIdx] = 1;
              queue.push([nx, ny]);
            }
          }
        }
      }

      // STEP 10: Ignore grid lines, depth labels, tiny noise, massive background
      if (!touchesBorder && area > 200 && area < (width * height * 0.15)) {
        rawCavities.push({ area, minX, maxX, minY, maxY, sumX, sumY, points });
      }
    }
  }

  // STEP 5 & 9: Merge connected/nearby cavities into a single Water Zone
  const mergedCavities: any[] = [];
  const cavityMerged = new Array(rawCavities.length).fill(false);
  const mergeThreshold = height * 0.05; // Merge if within 5% height distance

  for (let i = 0; i < rawCavities.length; i++) {
    if (cavityMerged[i]) continue;
    let merged = { ...rawCavities[i], points: [...rawCavities[i].points] };
    cavityMerged[i] = true;
    
    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < rawCavities.length; j++) {
        if (!cavityMerged[j]) {
          const target = rawCavities[j];
          // Check if bounding boxes are close
          const xOverlap = Math.max(0, Math.min(merged.maxX, target.maxX) - Math.max(merged.minX, target.minX));
          const yDist = Math.max(0, Math.max(merged.minY, target.minY) - Math.min(merged.maxY, target.maxY));
          
          if (xOverlap > 0 && yDist < mergeThreshold) {
            merged.points.push(...target.points);
            merged.area += target.area;
            merged.minX = Math.min(merged.minX, target.minX);
            merged.maxX = Math.max(merged.maxX, target.maxX);
            merged.minY = Math.min(merged.minY, target.minY);
            merged.maxY = Math.max(merged.maxY, target.maxY);
            merged.sumX += target.sumX;
            merged.sumY += target.sumY;
            cavityMerged[j] = true;
            changed = true;
          }
        }
      }
    }
    mergedCavities.push(merged);
  }

  // STEP 6, 7 & 8: Ignore color while finding cavities, classify surrounding rock AFTERwards
  const waterZones: GeologicalFeature[] = [];

  for (const cav of mergedCavities) {
    const verticalThickness = cav.maxY - cav.minY;
    const horizontalWidth = cav.maxX - cav.minX;
    
    // Ignore long thin flat layers
    if (horizontalWidth > verticalThickness * 5) continue;

    let softCount = 0, hardCount = 0, darkCount = 0;
    for (let i = 0; i < cav.points.length; i += 2) {
      const type = pixelMap[cav.points[i+1] * width + cav.points[i]];
      if (type === 1) softCount++;
      if (type === 2) hardCount++;
      if (type === 3) darkCount++;
    }
    
    // Calculate rock above (search a block above the cavity)
    let hardAbove = 0, softAbove = 0;
    const searchTop = Math.max(startY, cav.minY - 40);
    for (let y = searchTop; y < cav.minY; y++) {
      for (let x = cav.minX; x <= cav.maxX; x++) {
        const type = pixelMap[y * width + x];
        if (type === 2) hardAbove++;
        if (type === 1) softAbove++;
      }
    }

    // Must have SOME fracture/gap color evidence to be a water zone, else it's just a rock chunk
    if (darkCount < cav.area * 0.05) continue;

    // Draw TIGHT polygon using concaveman with highly strict parameters
    const hullPoints: number[][] = [];
    const step = Math.max(1, Math.floor(cav.points.length / 500));
    for (let i = 0; i < cav.points.length; i += 2 * step) {
      hullPoints.push([cav.points[i], cav.points[i+1]]);
    }
    const hull = concaveman(hullPoints, 1, 10); // concavity=1, lengthThreshold=10 for ultra-tight fit
    const flatHull: number[] = [];
    for (const p of hull) flatHull.push(p[0], p[1]);

    // Scoring for Best Drilling Point
    // Largest connected cavity, Max vertical continuity, Min hard rock above, Max soft rock, Shortest depth
    const score = 
      (verticalThickness * 10) + 
      (cav.area * 0.5) + 
      (softCount * 2) - 
      (hardAbove * 5) + 
      ((height - cav.minY) * 2);

    waterZones.push({
      id: "", 
      type: "Water Zone",
      area: cav.area,
      minX: cav.minX, maxX: cav.maxX, minY: cav.minY, maxY: cav.maxY,
      centroidX: cav.sumX / cav.area,
      centroidY: cav.sumY / cav.area,
      score,
      confidence: Math.min(100, Math.floor(65 + (softCount/cav.area)*20 + (verticalThickness/height)*20)),
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
  }

  // Choose only ONE Best Drilling Point
  waterZones.sort((a, b) => b.score - a.score);
  
  waterZones.forEach((z, idx) => {
    z.id = `Water Zone ${idx + 1}`;
    z.priority = idx + 1;
    if (idx === 0) z.recommended = true;
  });

  return { waterZones, pixelMap };
}
