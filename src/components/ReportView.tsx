"use client";
import React, { useRef, useState } from "react";
import { useLanguage } from "./LanguageContext";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import jsPDF from "jspdf";
import { toJpeg } from "html-to-image";

export function ReportView({ report, parsedData, onNewSurvey }: { report: any; parsedData: any; onNewSurvey?: () => void }) {
  const { t } = useLanguage();
  const reportRef = useRef<HTMLDivElement>(null);
  const [isExporting, setIsExporting] = useState(false);

  const exportPDF = async () => {
    if (!reportRef.current) return;
    try {
      setIsExporting(true);
      
      const pdf = new jsPDF("p", "mm", "a4");
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const marginX = 18;
      const marginY = 20;
      const renderWidth = pdfWidth - marginX * 2;
      
      const sections = ['section-original', 'section-processed', 'section-table', 'section-analysis'];
      let hasAddedFirstPage = false;
      
      for (const sectionId of sections) {
        const sectionNode = document.getElementById(sectionId);
        if (!sectionNode) continue;
        
        const images = sectionNode.querySelectorAll('img');
        await Promise.all(Array.from(images).map(img => {
          if (img.complete) return Promise.resolve();
          return new Promise(resolve => { img.onload = resolve; img.onerror = resolve; });
        }));
        await new Promise(resolve => setTimeout(resolve, 400));
                
        const dataUrl = await toJpeg(sectionNode, {
          cacheBust: true, pixelRatio: 2, quality: 1, backgroundColor: '#ffffff'
        });
        
        let targetWidth = renderWidth;
        let targetHeight = (sectionNode.offsetHeight * targetWidth) / sectionNode.offsetWidth;
        const maxH = pageHeight - marginY * 2;
        if (targetHeight > maxH) {
          const sf = maxH / targetHeight;
          targetHeight = maxH;
          targetWidth = targetWidth * sf;
        }
        const offsetX = marginX + (renderWidth - targetWidth) / 2;
        
        if (hasAddedFirstPage) pdf.addPage();
        else hasAddedFirstPage = true;
        
        pdf.addImage(dataUrl, "JPEG", offsetX, marginY, targetWidth, targetHeight);
      }
      
      pdf.save(`AquaScan_Report_${report.customerName}.pdf`);
    } catch (error) {
      console.error("PDF Export failed:", error);
    } finally {
      setIsExporting(false);
    }
  };

  const surveyDate = new Date().toLocaleDateString();

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-8">
      {/* Top Bar */}
      <div className="max-w-5xl mx-auto mb-6 flex justify-between items-center">
        <h1 className="text-2xl font-bold text-slate-800">{t("title")}</h1>
        <div className="flex gap-4 items-center">
          <LanguageSwitcher />
          <Button onClick={exportPDF} disabled={isExporting} className="bg-blue-600 hover:bg-blue-700">
            {isExporting ? "Generating PDF..." : t("exportPDF") || "Download PDF"}
          </Button>
          {onNewSurvey && (
            <Button onClick={onNewSurvey} variant="outline">New Survey</Button>
          )}
        </div>
      </div>

      <div ref={reportRef} className="max-w-5xl mx-auto flex flex-col gap-8">

        {/* ============================== */}
        {/* SECTION 1: ORIGINAL PQWT PROFILE */}
        {/* ============================== */}
        <div id="section-original" className="bg-white border rounded-xl shadow-sm p-6" style={{ borderColor: '#e2e8f0' }}>
          <h2 className="text-2xl font-bold mb-1" style={{ color: '#1e293b' }}>Original PQWT Profile</h2>
          <div className="flex flex-wrap gap-x-8 gap-y-1 text-sm mb-4" style={{ color: '#64748b' }}>
            <span><strong>Customer:</strong> {report.customerName}</span>
            <span><strong>Date:</strong> {surveyDate}</span>
          </div>
          <div className="relative w-full border rounded overflow-hidden" style={{ borderColor: '#e2e8f0' }}>
            <img
              src={report.originalImage}
              alt="Original PQWT Profile"
              className="w-full h-auto object-contain block"
              crossOrigin="anonymous"
            />
          </div>
        </div>

        {/* ============================== */}
        {/* SECTION 1.5: BINARY DETECTION MASK */}
        {/* ============================== */}
        {report.maskImage && (
          <div id="section-mask" className="bg-white border rounded-xl shadow-sm p-6" style={{ borderColor: '#e2e8f0' }}>
            <h2 className="text-2xl font-bold mb-1" style={{ color: '#1e293b' }}>Binary Detection Mask</h2>
            <p className="text-sm mb-4" style={{ color: '#64748b' }}>
              Computer Vision debug view showing raw segmented features before morphological processing and ellipse fitting.
            </p>
            <div className="relative w-full border rounded overflow-hidden" style={{ borderColor: '#e2e8f0', backgroundColor: '#fff' }}>
              <img
                src={report.maskImage}
                alt="Binary Detection Mask"
                className="w-full h-auto object-contain block"
                crossOrigin="anonymous"
              />
            </div>
          </div>
        )}

        {/* ============================== */}
        {/* SECTION 2: AI PROCESSED DETECTION MAP */}
        {/* ============================== */}
        <div id="section-processed" className="bg-white border rounded-xl shadow-sm p-6" style={{ borderColor: '#e2e8f0' }}>
          <h2 className="text-2xl font-bold mb-1" style={{ color: '#1e293b' }}>AI Processed Detection Map</h2>
          <p className="text-sm mb-4" style={{ color: '#64748b' }}>
            Computer Vision detected geological contours, anomalies, and water-bearing gaps. The highest-scoring gap is marked as the recommended drilling point.
          </p>

          {/* Color Legend */}
          <div className="flex flex-wrap gap-4 mb-4">
            <div className="flex items-center gap-2">
              <div className="w-5 h-5 rounded" style={{ backgroundColor: 'rgba(34,197,94,0.7)' }}></div>
              <span className="text-xs font-semibold text-slate-600">Soft Rock (Green)</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-5 h-5 rounded" style={{ backgroundColor: 'rgba(234,138,36,0.7)' }}></div>
              <span className="text-xs font-semibold text-slate-600">Hard Rock (Orange)</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-5 h-5 rounded" style={{ backgroundColor: 'rgba(30,64,175,0.7)' }}></div>
              <span className="text-xs font-semibold text-slate-600">Water-Bearing Gap (Blue)</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-5 h-3 border-t-2 border-dashed" style={{ borderColor: 'rgba(255,255,0,1)' }}></div>
              <span className="text-xs font-semibold text-slate-600">Dashed Ellipse = Anomaly</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-5 h-3 border-t-2" style={{ borderColor: 'rgba(0,255,0,0.9)' }}></div>
              <span className="text-xs font-semibold text-slate-600">Green Line = Drilling Path</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: 'red' }}></div>
              <span className="text-xs font-semibold text-slate-600">Red Cross = Best Drilling Point</span>
            </div>
          </div>

          <div className="relative w-full border rounded overflow-hidden" style={{ borderColor: '#e2e8f0' }}>
            <img
              src={report.processedImage}
              alt="AI Processed Detection Map"
              className="w-full h-auto object-contain block"
              crossOrigin="anonymous"
            />
          </div>
        </div>

        {/* ============================== */}
        {/* SECTION 3: DETECTION TABLE */}
        {/* ============================== */}
        <div id="section-table" className="bg-white border rounded-xl shadow-sm p-6" style={{ borderColor: '#e2e8f0' }}>
          <h2 className="text-2xl font-bold mb-4" style={{ color: '#1e293b' }}>Detected Geological Features</h2>
          <div className="overflow-x-auto border rounded" style={{ borderColor: '#e2e8f0' }}>
            <table className="w-full text-sm text-left">
              <thead className="text-xs uppercase bg-slate-100" style={{ color: '#475569' }}>
                <tr>
                  <th className="px-4 py-3">ID</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Depth</th>
                  <th className="px-4 py-3">Width</th>
                  <th className="px-4 py-3">Confidence</th>
                  <th className="px-4 py-3">Score</th>
                  <th className="px-4 py-3">Recommended</th>
                </tr>
              </thead>
              <tbody>
                {report.features && report.features.length > 0 ? (
                  report.features.map((f: any, idx: number) => (
                    <tr key={idx} className={`border-b hover:bg-slate-50 ${f.recommended ? 'bg-green-50' : ''}`} style={{ borderColor: '#f1f5f9' }}>
                      <td className="px-4 py-3 font-bold">{f.id}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-1 rounded text-xs font-semibold ${
                          f.type === "Soft Rock" ? "bg-green-100 text-green-800" :
                          f.type === "Hard Rock" ? "bg-orange-100 text-orange-800" :
                          "bg-blue-900 text-white"
                        }`}>
                          {f.type}
                        </span>
                      </td>
                      <td className="px-4 py-3">{f.depthRange}</td>
                      <td className="px-4 py-3">{f.widthInMeters}</td>
                      <td className="px-4 py-3">{f.confidence}%</td>
                      <td className="px-4 py-3 font-mono">{f.score}</td>
                      <td className="px-4 py-3 font-bold text-center">
                        {f.recommended ? <span className="text-green-600 text-lg">✓ Yes</span> : <span className="text-slate-400">—</span>}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr><td colSpan={7} className="px-4 py-6 text-center text-slate-500">No features detected.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* ============================== */}
        {/* SECTION 4: GEOLOGICAL SUMMARY */}
        {/* ============================== */}
        <div id="section-analysis" className="bg-white border rounded-xl shadow-sm p-6" style={{ borderColor: '#e2e8f0' }}>
          <h2 className="text-2xl font-bold mb-4" style={{ color: '#1e293b' }}>Geological Analysis</h2>
          
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
            <Card style={{ borderColor: '#e2e8f0' }}>
              <CardHeader className="pb-2"><CardTitle className="text-sm text-slate-500">Best Drilling Depth</CardTitle></CardHeader>
              <CardContent><span className="text-2xl font-bold text-green-700">{parsedData.recommendedDrillingDepth || parsedData.bestBorewellPoint?.depth || "N/A"}</span></CardContent>
            </Card>
            <Card style={{ borderColor: '#e2e8f0' }}>
              <CardHeader className="pb-2"><CardTitle className="text-sm text-slate-500">Confidence</CardTitle></CardHeader>
              <CardContent><span className="text-2xl font-bold text-blue-700">{parsedData.confidence || "N/A"}</span></CardContent>
            </Card>
          </div>

          <div className="space-y-4">
            <div>
              <h4 className="font-semibold text-slate-700 mb-1">Original Profile Analysis</h4>
              <p className="text-sm leading-relaxed" style={{ color: '#334155' }}>{parsedData.originalProfileAnalysis || "N/A"}</p>
            </div>
            <div>
              <h4 className="font-semibold text-slate-700 mb-1">Processed Profile Analysis</h4>
              <p className="text-sm leading-relaxed" style={{ color: '#334155' }}>{parsedData.processedProfileAnalysis || "N/A"}</p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="text-center text-sm py-4" style={{ color: '#94a3b8' }}>
          Generated by AquaScan AI • Professional Borewell Analysis
        </div>

        {/* Bottom Actions */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pb-8 print:hidden">
          <Button onClick={exportPDF} disabled={isExporting} className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-6 px-8 rounded-lg shadow-lg text-lg w-full sm:w-auto">
            {isExporting ? "Generating PDF..." : "Download PDF Report"}
          </Button>
          {onNewSurvey && (
            <Button onClick={onNewSurvey} variant="outline" className="border-2 border-slate-300 hover:bg-slate-100 text-slate-700 font-bold py-6 px-8 rounded-lg shadow text-lg w-full sm:w-auto">
              Create New Survey
            </Button>
          )}
        </div>

      </div>
    </div>
  );
}
