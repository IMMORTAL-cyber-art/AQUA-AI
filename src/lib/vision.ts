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
  recommended: boolean;
  colorType: string;
  polygon: number[];
  priority: number;
  softRockIntersection: boolean;
  hardRockAbove: boolean;
  verticalThickness: number;
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

// ---------------------------------------------------------
// Fast Box Blur to eliminate grid lines and text
// ---------------------------------------------------------
function boxBlur(gray: Float32Array, width: number, height: number, radius: number): Float32Array {
  const out = new Float32Array(gray.length);
  const temp = new Float32Array(gray.length);
  
  // Horizontal pass
  for (let y = 0; y < height; y++) {
    let sum = 0;
    const rowStart = y * width;
    for (let x = -radius; x <= radius; x++) {
      sum += gray[rowStart + Math.max(0, Math.min(width - 1, x))];
    }
    temp[rowStart] = sum;
    for (let x = 1; x < width; x++) {
      sum += gray[rowStart + Math.min(width - 1, x + radius)] - gray[rowStart + Math.max(0, x - radius - 1)];
      temp[rowStart + x] = sum;
    }
  }

  const windowSize = (radius * 2 + 1) * (radius * 2 + 1);
  
  // Vertical pass
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) {
      sum += temp[Math.max(0, Math.min(height - 1, y)) * width + x];
    }
    out[x] = sum / windowSize;
    for (let y = 1; y < height; y++) {
      sum += temp[Math.min(height - 1, y + radius) * width + x] - temp[Math.max(0, y - radius - 1) * width + x];
      out[y * width + x] = sum / windowSize;
    }
  }
  return out;
}

// ---------------------------------------------------------
// Sobel Edge Detection
// ---------------------------------------------------------
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
  const startY = Math.round(height * 0.15); // Skip surface noise/header
  const totalPixels = width * height;
  
  // =========================================================================
  // ANALYZER 2: PROCESSED MAP (Geological Color Classification)
  // =========================================================================
  const pixelMap = new Uint8Array(totalPixels); // 0=Bg, 1=Soft(Green), 2=Hard(Orange), 3=GapColor
  const gray = new Float32Array(totalPixels);
  
  for (let y = startY; y < height; y++) {
    let rowStart = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowStart + x;
      const pIdx = idx * 4;
      const r = data[pIdx], g = data[pIdx + 1], b = data[pIdx + 2];
      
      // Grayscale for structure detection
      gray[idx] = 0.299 * r + 0.587 * g + 0.114 * b;
      
      const [h, s, l] = rgbToHsl(r, g, b);

      if (l < 20 || (h >= 170 && h <= 280 && s > 20)) {
        pixelMap[idx] = 3; // Gap Color
      } else if (h >= 70 && h <= 160 && s > 15 && l > 15) {
        pixelMap[idx] = 1; // Soft Rock (Green)
      } else if ((h >= 10 && h <= 65 || h > 330) && s > 20 && l > 15) {
        pixelMap[idx] = 2; // Hard Rock (Orange/Red/Yellow)
      }
    }
  }

  // =========================================================================
  // ANALYZER 1: ORIGINAL PROFILE (Structural Cavity Detection)
  // =========================================================================
  // 1. Blur to remove grid lines and text
  const blurredGray = boxBlur(gray, width, height, 4);
  
  // 2. Edge Detection to find boundaries of cavities
  let edges = sobelEdges(blurredGray, width, height, 15);
  
  // 3. Dilate edges so they form closed loops, creating enclosed cavities
  edges = dilate3x3(edges, width, height);
  edges = dilate3x3(edges, width, height);
  edges = dilate3x3(edges, width, height);

  // 4. Find enclosed cavities (Connected components on NON-edge pixels)
  const visited = new Uint8Array(totalPixels);
  const rawCavities: any[] = [];
  
  const borderMargin = Math.round(width * 0.05);
  const minArea = width * height * 0.005; 
  const maxArea = width * height * 0.25;

  for (let y = startY; y < height; y++) {
    let rowStart = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowStart + x;
      // We look for regions bounded by edges
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

        // Check if touches border margin
        if (cx <= borderMargin || cx >= width - borderMargin || cy >= height - borderMargin) {
          touchesBorder = true;
        }

        // 4-connected flood fill for cavities
        const neighbors = [[cx-1, cy], [cx+1, cy], [cx, cy-1], [cx, cy+1]];
        for (let i=0; i<4; i++) {
          const nx = neighbors[i][0];
          const ny = neighbors[i][1];
          if (nx >= 0 && nx < width && ny >= startY && ny < height) {
            const nIdx = ny * width + nx;
            if (!visited[nIdx] && edges[nIdx] === 0) {
              visited[nIdx] = 1;
              queue.push([nx, ny]);
            }
          }
        }
      }

      const verticalThickness = maxY - minY;
      const horizontalWidth = maxX - minX;

      // Filter 1: Border touching
      // Filter 2: Area constraints
      // Filter 3: Ignore long horizontal geological layers (Aspect ratio check)
      const isHorizontalLayer = horizontalWidth > verticalThickness * 4;

      if (!touchesBorder && area >= minArea && area <= maxArea && !isHorizontalLayer) {
        
        // Context Check (Analyzer 2 colors intersecting this structural cavity)
        let softRockCount = 0;
        let hardRockCount = 0;
        let gapColorCount = 0;
        let hardRockAboveCount = 0;
        
        for (let i = 0; i < points.length; i += 2) {
          const px = points[i];
          const py = points[i+1];
          const ctxType = pixelMap[py * width + px];
          if (ctxType === 1) softRockCount++;
          if (ctxType === 2) hardRockCount++;
          if (ctxType === 3) gapColorCount++;
        }
        
        // Check above cavity for hard rock
        for (let sy = Math.max(startY, minY - 50); sy < minY; sy++) {
          for (let sx = minX; sx <= maxX; sx++) {
            if (pixelMap[sy * width + sx] === 2) hardRockAboveCount++;
          }
        }

        // Must contain at least SOME gap color (black/blue) to be a water gap candidate
        if (gapColorCount > area * 0.05) {
           rawCavities.push({ 
            area, minX, maxX, minY, maxY, sumX, sumY, points,
            softRockCount, hardRockCount, hardRockAboveCount, verticalThickness
          });
        }
      }
    }
  }

  // =========================================================================
  // BEST DRILLING POINT DECISION
  // =========================================================================
  const waterZones: GeologicalFeature[] = [];

  for (const gap of rawCavities) {
    const hullPoints: number[][] = [];
    const step = Math.max(1, Math.floor(gap.points.length / 1000));
    for (let i = 0; i < gap.points.length; i += 2 * step) {
      hullPoints.push([gap.points[i], gap.points[i+1]]);
    }
    const hull = concaveman(hullPoints, 2, 0.01);
    const flatHull: number[] = [];
    for (const p of hull) flatHull.push(p[0], p[1]);

    // DRILL DECISION SCORING based on pure geometry and context
    // 1. Minimum drilling depth (shallower = better)
    const depthScore = Math.max(0, 1 - (gap.minY / height)) * 1500; 
    
    // 2. Sufficient vertical thickness
    const thicknessScore = (gap.verticalThickness / height) * 3000;
    
    // 3. Intersects soft rock
    const softRockBonus = (gap.softRockCount > gap.area * 0.1) ? 800 : 0;
    
    // 4. Avoids excessive hard rock
    const hardRockPenalty = (gap.hardRockAboveCount > gap.area * 0.5) ? -1500 : 0;

    const score = Math.round(depthScore + thicknessScore + softRockBonus + hardRockPenalty);

    waterZones.push({
      id: "", // Assigned later
      type: "Water-Bearing Gap",
      area: gap.area,
      minX: gap.minX, maxX: gap.maxX, minY: gap.minY, maxY: gap.maxY,
      centroidX: gap.sumX / gap.area,
      centroidY: gap.sumY / gap.area,
      score,
      confidence: Math.min(100, Math.floor(70 + (gap.softRockCount > 0 ? 15 : 0) + (gap.verticalThickness > height*0.1 ? 15 : 0))),
      recommended: false,
      colorType: "black",
      polygon: flatHull,
      priority: 0,
      softRockIntersection: gap.softRockCount > gap.area * 0.1,
      hardRockAbove: gap.hardRockAboveCount > gap.area * 0.5,
      verticalThickness: gap.verticalThickness
    });
  }

  // Sort by score descending to assign priorities
  waterZones.sort((a, b) => b.score - a.score);
  
  // Assign numbering and ONE recommended zone
  waterZones.forEach((z, idx) => {
    z.id = `Water Zone ${idx + 1}`;
    z.priority = idx + 1;
    if (idx === 0) z.recommended = true;
  });

  return { waterZones, pixelMap };
}
