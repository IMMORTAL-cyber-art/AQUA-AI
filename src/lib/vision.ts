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

export interface DepthComposition {
  interval: string;
  hardRockPercent: number;
  softRockPercent: number;
  waterPercent: number;
}

export interface VisionResult {
  waterZones: GeologicalFeature[];
  pixelMap: Uint8Array;
  cropStartY: number;
  cropEndY: number;
  composition: DepthComposition[];
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

function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowStart + x;
      if (mask[idx] === 1) {
        for (let dy = -radius; dy <= radius; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          const nRowStart = ny * width;
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            out[nRowStart + nx] = 1;
          }
        }
      }
    }
  }
  return out;
}

function erode(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowStart + x;
      let allOne = true;
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) {
          allOne = false;
          break;
        }
        const nRowStart = ny * width;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width || mask[nRowStart + nx] === 0) {
            allOne = false;
            break;
          }
        }
        if (!allOne) break;
      }
      if (allOne) {
        out[idx] = 1;
      }
    }
  }
  return out;
}

export function detectGeologicalFeatures(imageData: ImageData, width: number, height: number, maxDepth: number = 150): VisionResult {
  const data = imageData.data;
  const totalPixels = width * height;
  

  
  // STEP 1: Automatic Profile Detection
  // Calculate row and column counts of colorful pixels to dynamically find the largest contiguous profile grid.
  const rowCounts = new Int32Array(height);
  const colCounts = new Int32Array(width);
  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowStart + x;
      const pIdx = idx * 4;
      const r = data[pIdx], g = data[pIdx + 1], b = data[pIdx + 2];
      const [h, s, l] = rgbToHsl(r, g, b);
      // Colors belonging to the geological scan scale (ignore white/grey margins/text/logos)
      if (s > 15 && l > 10 && l < 97) {
        rowCounts[y]++;
        colCounts[x]++;
      }
    }
  }

  // Find union of all significant row segments (length >= 50px) to capture both original profile and processed map
  const rowThreshold = width * 0.15;
  let startY = -1;
  let endY = -1;
  let currentStart = -1;

  for (let y = 0; y < height; y++) {
    if (rowCounts[y] >= rowThreshold) {
      if (currentStart === -1) currentStart = y;
    } else {
      if (currentStart !== -1) {
        const len = y - currentStart;
        if (len >= 50) {
          if (startY === -1) startY = currentStart;
          endY = y - 1;
        }
        currentStart = -1;
      }
    }
  }
  if (currentStart !== -1) {
    const len = height - currentStart;
    if (len >= 50) {
      if (startY === -1) startY = currentStart;
      endY = height - 1;
    }
  }

  // Find longest contiguous sequence of columns containing geological pixels
  const colThreshold = height * 0.15;
  let bestColStart = -1, bestColEnd = -1;
  let maxColLen = 0;
  currentStart = -1;

  for (let x = 0; x < width; x++) {
    if (colCounts[x] >= colThreshold) {
      if (currentStart === -1) currentStart = x;
    } else {
      if (currentStart !== -1) {
        const len = x - currentStart;
        if (len > maxColLen) {
          maxColLen = len;
          bestColStart = currentStart;
          bestColEnd = x - 1;
        }
        currentStart = -1;
      }
    }
  }
  if (currentStart !== -1) {
    const len = width - currentStart;
    if (len > maxColLen) {
      maxColLen = len;
      bestColStart = currentStart;
      bestColEnd = width - 1;
    }
  }

  // Apply fallback if not found, otherwise pad inset
  let startX = 0, endX = width - 1;
  if (startX === -1 || endX === -1 || bestColStart === -1) {
    startX = Math.round(width * 0.08);
    endX = width - Math.round(width * 0.08);
  } else {
    startX = Math.max(0, bestColStart + 2);
    endX = Math.min(width, bestColEnd - 2);
  }

  if (startY === -1 || endY === -1) {
    startY = Math.round(height * 0.15);
    endY = height - Math.round(height * 0.08);
  } else {
    startY = Math.max(0, startY + 2);
    endY = Math.min(height, endY - 2);
  }

  console.log(`[Auto Crop] Detected geological profile area: X [${startX} -> ${endX}], Y [${startY} -> ${endY}] (Width: ${endX - startX}, Height: ${endY - startY})`);

  const gray = new Float32Array(totalPixels);
  const pixelMap = new Uint8Array(totalPixels); // 0=Bg, 1=Soft(Green), 2=Hard(Orange), 3=Dark/Gap(Black/Blue)

  // STEP 2: Color classification strictly inside crop bounds
  for (let y = startY; y < endY; y++) {
    let rowStart = y * width;
    for (let x = startX; x < endX; x++) {
      const idx = rowStart + x;
      const pIdx = idx * 4;
      const r = data[pIdx], g = data[pIdx + 1], b = data[pIdx + 2];
      
      gray[idx] = 0.299 * r + 0.587 * g + 0.114 * b;
      
      const [h, s, l] = rgbToHsl(r, g, b);
      if (l < 20 || (h >= 170 && h <= 280 && s > 20)) {
        pixelMap[idx] = 3; // Black / Dark Blue / Light Blue (Water gap)
      } else {
        if (h >= 70 && h <= 170) {
          pixelMap[idx] = 1; // Green (Soft Rock)
        } else {
          pixelMap[idx] = 2; // Orange/Brown (Hard Rock)
        }
      }
    }
  }

  // Create binary mask of aquifer (fracture/water) pixels inside the cropped region
  const aquiferMask = new Uint8Array(totalPixels);
  for (let y = startY; y < endY; y++) {
    const rowStart = y * width;
    for (let x = startX; x < endX; x++) {
      const idx = rowStart + x;
      if (pixelMap[idx] === 3 || pixelMap[idx] === 1) { // 3=Water, 1=Fracture/Soft Rock
        aquiferMask[idx] = 1;
      }
    }
  }

  // STEP 3: Morphological Closing with radius=1 to avoid giant merges
  console.log("[Morphological Closing] Performing closing on aquifer mask (radius=1)...");
  const dilated = dilate(aquiferMask, width, height, 1);
  const closedMask = erode(dilated, width, height, 1);

  // STEP 4: Extract connected components (BFS)
  const visited = new Uint8Array(totalPixels);
  const validCavities: any[] = [];

  const cropWidth = endX - startX;
  const cropHeight = endY - startY;

  for (let y = startY; y < endY; y++) {
    const rowStart = y * width;
    for (let x = startX; x < endX; x++) {
      const idx = rowStart + x;
      if (visited[idx] || closedMask[idx] === 0) continue;

      // Start BFS
      const queue: [number, number][] = [[x, y]];
      visited[idx] = 1;
      let qHead = 0;
      
      let minX = x, maxX = x, minY = y, maxY = y;
      let sumX = 0, sumY = 0;
      let enclosedArea = 0;
      let blueCount = 0;
      let greenCount = 0;
      const points: number[] = [];
      const componentPixels = new Set<number>();

      while (qHead < queue.length) {
        const [cx, cy] = queue[qHead++];
        const cIdx = cy * width + cx;
        points.push(cx, cy);
        componentPixels.add(cIdx);
        enclosedArea++;
        if (pixelMap[cIdx] === 3) blueCount++;
        if (pixelMap[cIdx] === 1) greenCount++;
        
        sumX += cx;
        sumY += cy;

        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        const neighbors = [[cx-1, cy], [cx+1, cy], [cx, cy-1], [cx, cy+1]];
        for (let i = 0; i < 4; i++) {
          const nx = neighbors[i][0];
          const ny = neighbors[i][1];
          if (nx >= startX && nx < endX && ny >= startY && ny < endY) {
            const nIdx = ny * width + nx;
            if (!visited[nIdx] && closedMask[nIdx] === 1) {
              visited[nIdx] = 1;
              queue.push([nx, ny]);
            }
          }
        }
      }

      const centroidX = sumX / enclosedArea;
      const centroidY = sumY / enclosedArea;
      const verticalThickness = maxY - minY;
      const horizontalWidth = maxX - minX;

      // Filter A: Reject tiny components
      if (enclosedArea < 300) {
        console.log(`[Debug Log] Cavity candidate at Y: ${minY}-${maxY} ignored: tiny area (${enclosedArea} < 300)`);
        continue;
      }

      // Filter B: Reject components touching absolute image boundaries (using 5px buffer)
      const touchesBorder = (minX <= 5 || maxX >= width - 5 || minY <= 5 || maxY >= height - 5);
      if (touchesBorder) {
        console.log(`[Debug Log] Cavity candidate at Y: ${minY}-${maxY} ignored: touches border (X: ${minX}-${maxX}, Y: ${minY}-${maxY})`);
        continue;
      }

      // Filter C: Reject continuous bottom blue boundary
      const isBottomLayer = (maxY > endY - 30 && horizontalWidth > cropWidth * 0.50);
      if (isBottomLayer) {
        console.log(`[Debug Log] Cavity candidate at Y: ${minY}-${maxY} ignored: bottom blue boundary`);
        continue;
      }

      // Filter D: Reject long horizontal strips
      const isHorizontalStrip = (horizontalWidth > cropWidth * 0.35 && verticalThickness < 20);
      if (isHorizontalStrip) {
        console.log(`[Debug Log] Cavity candidate at Y: ${minY}-${maxY} ignored: horizontal strip`);
        continue;
      }

      // Filter E: Rock enclosure check (must be surrounded mostly, >=75%, by soft/hard rock)
      let totalNeighbors = 0;
      let orangeNeighbors = 0;
      let greenNeighbors = 0;
      for (const cIdx of componentPixels) {
        const cx = cIdx % width;
        const cy = Math.floor(cIdx / width);
        const neighbors = [[cx-1, cy], [cx+1, cy], [cx, cy-1], [cx, cy+1]];
        for (let n = 0; n < 4; n++) {
          const nx = neighbors[n][0];
          const ny = neighbors[n][1];
          if (nx >= startX && nx < endX && ny >= startY && ny < endY) {
            const nIdx = ny * width + nx;
            if (!componentPixels.has(nIdx)) {
              totalNeighbors++;
              const neighborColor = pixelMap[nIdx];
              if (neighborColor === 2) orangeNeighbors++;
              if (neighborColor === 1) greenNeighbors++;
            }
          }
        }
      }
      
      const rockNeighbors = orangeNeighbors + greenNeighbors;
      const rockRatio = totalNeighbors > 0 ? rockNeighbors / totalNeighbors : 0;
      const orangeRatio = totalNeighbors > 0 ? orangeNeighbors / totalNeighbors : 0;
      
      if (rockRatio < 0.75) {
        console.log(`[Debug Log] Cavity candidate at Y: ${minY}-${maxY} ignored: rock enclosure ratio too low (${(rockRatio*100).toFixed(1)}% < 75%)`);
        continue;
      }

      validCavities.push({
        enclosedArea,
        blueCount,
        greenCount,
        minX, maxX, minY, maxY,
        centroidX, centroidY,
        verticalThickness, horizontalWidth,
        points, rockRatio, orangeRatio
      });
    }
  }

  console.log(`[Debug Log] Unmerged valid cavities: ${validCavities.length}`);

  // STEP 5: Merge vertically overlapping cavities
  const mergedCavities: any[] = [];
  const cavityMerged = new Uint8Array(validCavities.length);
  const mergeThreshold = 30; // merge if within 30 pixels vertically

  for (let i = 0; i < validCavities.length; i++) {
    if (cavityMerged[i]) continue;
    const merged = { ...validCavities[i] };
    merged.points = [...validCavities[i].points];
    cavityMerged[i] = 1;

    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < validCavities.length; j++) {
        if (!cavityMerged[j]) {
          const target = validCavities[j];
          const xOverlap = Math.max(0, Math.min(merged.maxX, target.maxX) - Math.max(merged.minX, target.minX));
          const yDist = Math.max(0, Math.max(merged.minY, target.minY) - Math.min(merged.maxY, target.maxY));
          
          if (xOverlap > 0 && yDist < mergeThreshold) {
            merged.points.push(...target.points);
            merged.enclosedArea += target.enclosedArea;
            merged.blueCount += target.blueCount;
            merged.greenCount += target.greenCount;
            merged.minX = Math.min(merged.minX, target.minX);
            merged.maxX = Math.max(merged.maxX, target.maxX);
            merged.minY = Math.min(merged.minY, target.minY);
            merged.maxY = Math.max(merged.maxY, target.maxY);
            merged.centroidX = (merged.centroidX * (merged.enclosedArea - target.enclosedArea) + target.centroidX * target.enclosedArea) / merged.enclosedArea;
            merged.centroidY = (merged.centroidY * (merged.enclosedArea - target.enclosedArea) + target.centroidY * target.enclosedArea) / merged.enclosedArea;
            merged.verticalThickness = merged.maxY - merged.minY;
            merged.horizontalWidth = merged.maxX - merged.minX;
            merged.rockRatio = (merged.rockRatio + target.rockRatio) / 2;
            merged.orangeRatio = (merged.orangeRatio + target.orangeRatio) / 2;
            cavityMerged[j] = 1;
            changed = true;
          }
        }
      }
    }
    mergedCavities.push(merged);
  }

  // STEP 6: Geological Point Scoring Rules
  const LARGE_AREA_THRESHOLD = 5000;
  const VERTICAL_THRESHOLD = 150;
  
  const scoredCorridors = mergedCavities.map(c => {
    let score = 0;
    
    // - Blue cavity: +100
    if (c.blueCount > 50) score += 100;
    
    // - Green fracture: +70
    if (c.greenCount > 50) score += 70;
    
    // - Large connected area: +40
    if (c.enclosedArea > LARGE_AREA_THRESHOLD) score += 40;
    
    // - Continuous vertical fracture: +30
    if (c.verticalThickness > VERTICAL_THRESHOLD) score += 30;
    
    // - Inside orange hard rock: -40
    if (c.orangeRatio > 0.6) score -= 40;
    
    // - Tiny isolated region: -30
    if (c.enclosedArea < 1500) score -= 30;

    return { ...c, score };
  });

  scoredCorridors.sort((a, b) => b.score - a.score);

  console.log(`[Debug Log] Total valid merged corridors: ${scoredCorridors.length}`);
  scoredCorridors.forEach((c, idx) => {
    console.log(`- Corridor #${idx + 1}: Y: ${c.minY}-${c.maxY} (X: ${c.minX}-${c.maxX}), Centroid: (${c.centroidX.toFixed(1)}, ${c.centroidY.toFixed(1)})`);
    console.log(`  * Blue Pixels: ${c.blueCount}`);
    console.log(`  * Green Pixels: ${c.greenCount}`);
    console.log(`  * Final Geological Score: ${c.score}`);
  });

  const waterZones: GeologicalFeature[] = [];

  // 7. Label only meaningful water zones (Score > 0)
  const meaningfulCorridors = scoredCorridors.filter(c => c.score > 0);

  if (meaningfulCorridors.length > 0) {
    // 8. Choose the highest scoring region as the single Best Drilling Point
    // (Only label the top 1 since the user requested "Draw only ONE Best Drilling Point", but wait, "Label only meaningful water zones" means we can list others as zones, but only 1 drilling point)
    // Actually the prompt says "Draw only ONE Best Drilling Point. Label only meaningful water zones."
    // We'll mark the first one as recommended=true, the rest as recommended=false.
    
    meaningfulCorridors.forEach((c, idx) => {
      // Concave hull points
      const hullPoints: number[][] = [];
      const step = Math.max(1, Math.floor(c.points.length / 500));
      for (let i = 0; i < c.points.length; i += 2 * step) {
        hullPoints.push([c.points[i], c.points[i+1]]);
      }
      const hull = concaveman(hullPoints, 1, 10);
      const flatHull: number[] = [];
      for (const p of hull) flatHull.push(p[0], p[1]);

      // Map rock surrounding description
      const rockSurrounding = c.orangeRatio > 0.5 ? "Hard Rock Dominant" : "Soft Rock Dominant";

      waterZones.push({
        id: `Water Zone ${idx + 1}`,
        type: "Water Zone",
        area: c.enclosedArea, 
        minX: c.minX, maxX: c.maxX, minY: c.minY, maxY: c.maxY,
        centroidX: c.centroidX,
        centroidY: c.centroidY,
        score: c.score,
        confidence: Math.min(100, Math.max(0, c.score)), // Convert score directly to confidence visual
        recommended: idx === 0, // ONLY the first (highest scoring) is the Best Drilling Point
        colorType: c.blueCount > c.greenCount ? "blue" : "green",
        polygon: flatHull,
        priority: idx + 1,
        verticalThickness: c.verticalThickness,
        horizontalWidth: c.horizontalWidth,
        rockAbove: "Unknown",
        rockBelow: "Unknown", 
        rockSurrounding: rockSurrounding

      });
    });
  }

  if (waterZones.length === 0) {
    console.log(`[Debug Log] Best Drilling Point selected: None (No valid enclosed cavities detected)`);
  } else {
    const recommendedZone = waterZones[0];
    console.log(`[Debug Log] Best Drilling Point selected: ${recommendedZone.id} (Score: ${recommendedZone.score.toFixed(3)}, Centroid Y: ${recommendedZone.centroidY.toFixed(1)}, Depth pixel range: Y ${recommendedZone.minY}-${recommendedZone.maxY}, Confidence: ${recommendedZone.confidence}%)`);
  }

  // STEP 7: Depth-wise Composition Table
  // Divide crop height into 3 segments dynamically based on maxDepth
  const composition: DepthComposition[] = [];
  const third = Math.round(maxDepth / 3);
  const twoThirds = Math.round((maxDepth * 2) / 3);
  const intervals = [
    { label: `0-${third}m`, startRatio: 0, endRatio: 1/3 },
    { label: `${third}-${twoThirds}m`, startRatio: 1/3, endRatio: 2/3 },
    { label: `${twoThirds}-${maxDepth}m`, startRatio: 2/3, endRatio: 1 }
  ];

  const totalCropHeight = endY - startY;
  for (const interval of intervals) {
    const iStartY = startY + Math.floor(interval.startRatio * totalCropHeight);
    const iEndY = startY + Math.floor(interval.endRatio * totalCropHeight);
    let hard = 0, soft = 0, water = 0, validPixels = 0;

    for (let y = iStartY; y < iEndY; y++) {
      for (let x = startX; x < endX; x++) {
        const type = pixelMap[y * width + x];
        if (type === 2) hard++;
        else if (type === 1) soft++;
        else if (type === 3) water++;
        if (type !== 0) validPixels++;
      }
    }

    composition.push({
      interval: interval.label,
      hardRockPercent: validPixels > 0 ? (hard / validPixels) * 100 : 0,
      softRockPercent: validPixels > 0 ? (soft / validPixels) * 100 : 0,
      waterPercent: validPixels > 0 ? (water / validPixels) * 100 : 0,
    });
  }

  return { waterZones, pixelMap, cropStartY: startY, cropEndY: endY, composition };
}
