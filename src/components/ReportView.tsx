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
      
      const sections = ['section-original', 'section-annotated-orig', 'section-processed', 'section-annotated-proc', 'section-analysis'];
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

  const hasDrillingPoint = parsedData.recommendedDrillingDepth && parsedData.recommendedDrillingDepth !== "No reliable drilling point detected.";
  const bestDrillingPointVal = hasDrillingPoint ? (parsedData.bestBorewellPoint?.id || "Water Zone 1") : "No reliable drilling point detected.";
  const recommendedRangeVal = parsedData.recommendedDrillingDepth || parsedData.bestBorewellPoint?.depth || "N/A";
  const startDepthVal = hasDrillingPoint ? (parsedData.startDepth || parsedData.bestBorewellPoint?.startDepth || "N/A") : "N/A";
  const endDepthVal = hasDrillingPoint ? (parsedData.endDepth || parsedData.bestBorewellPoint?.endDepth || "N/A") : "N/A";

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-8">
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
        
        {/* 1. ORIGINAL PROFILE */}
        <div id="section-original" className="bg-white border rounded-xl shadow-sm p-6" style={{ borderColor: '#e2e8f0' }}>
          <h2 className="text-2xl font-bold mb-1" style={{ color: '#1e293b' }}>1. Original Profile</h2>
          <div className="flex flex-wrap gap-x-8 gap-y-1 text-sm mb-4" style={{ color: '#64748b' }}>
            <span><strong>Customer:</strong> {report.customerName}</span>
            <span><strong>Date:</strong> {surveyDate}</span>
          </div>
          <div className="relative w-full border rounded overflow-hidden" style={{ borderColor: '#e2e8f0' }}>
            <img src={report.originalImage} alt="Original PQWT Profile" className="w-full h-auto object-contain block" crossOrigin="anonymous" />
          </div>
        </div>

        {/* 2. AI ANNOTATED ORIGINAL PROFILE */}
        <div id="section-annotated-orig" className="bg-white border rounded-xl shadow-sm p-6" style={{ borderColor: '#e2e8f0' }}>
          <h2 className="text-2xl font-bold mb-1" style={{ color: '#1e293b' }}>2. AI Annotated Original Profile</h2>
          <div className="relative w-full border rounded overflow-hidden" style={{ borderColor: '#e2e8f0' }}>
            <img src={report.annotatedOriginalImage} alt="Annotated Original Profile" className="w-full h-auto object-contain block" crossOrigin="anonymous" />
          </div>
        </div>

        {/* 3. AI PROCESSED DETECTION MAP */}
        <div id="section-processed" className="bg-white border rounded-xl shadow-sm p-6" style={{ borderColor: '#e2e8f0' }}>
          <h2 className="text-2xl font-bold mb-1" style={{ color: '#1e293b' }}>3. Processed Map</h2>
          <div className="relative w-full border rounded overflow-hidden" style={{ borderColor: '#e2e8f0' }}>
            <img src={report.processedImage} alt="Processed Map" className="w-full h-auto object-contain block" crossOrigin="anonymous" />
          </div>
        </div>

        {/* 4. AI ANNOTATED PROCESSED MAP */}
        <div id="section-annotated-proc" className="bg-white border rounded-xl shadow-sm p-6" style={{ borderColor: '#e2e8f0' }}>
          <h2 className="text-2xl font-bold mb-1" style={{ color: '#1e293b' }}>4. AI Annotated Processed Map</h2>
          
          {/* 5. GEOLOGICAL LEGEND */}
          <div className="flex flex-wrap gap-4 mb-4 bg-slate-50 p-4 border rounded">
            <h3 className="w-full font-bold text-sm mb-2">5. Geological Legend</h3>
            <div className="flex items-center gap-2"><div className="w-5 h-5 rounded bg-green-500"></div><span className="text-xs font-semibold text-slate-600">Soft Rock</span></div>
            <div className="flex items-center gap-2"><div className="w-5 h-5 rounded bg-orange-500"></div><span className="text-xs font-semibold text-slate-600">Hard Rock</span></div>
            <div className="flex items-center gap-2"><div className="w-5 h-5 rounded bg-blue-800"></div><span className="text-xs font-semibold text-slate-600">Water-bearing Cavity</span></div>
            <div className="flex items-center gap-2"><div className="w-5 h-3 border-t-2 border-dashed border-yellow-400"></div><span className="text-xs font-semibold text-slate-600">Water Zone Boundary</span></div>
            <div className="flex items-center gap-2"><div className="w-5 h-3 border-t-2 border-green-500"></div><span className="text-xs font-semibold text-slate-600">Drilling Line</span></div>
            <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-red-600"></div><span className="text-xs font-semibold text-slate-600">Best Drilling Point</span></div>
          </div>

          <div className="relative w-full border rounded overflow-hidden" style={{ borderColor: '#e2e8f0' }}>
            <img src={report.annotatedProcessedImage} alt="Annotated Processed Map" className="w-full h-auto object-contain block" crossOrigin="anonymous" />
          </div>
        </div>

        {/* 6. GEOLOGICAL ANALYSIS */}
        <div id="section-analysis" className="bg-white border rounded-xl shadow-sm p-6" style={{ borderColor: '#e2e8f0' }}>
          <h2 className="text-2xl font-bold mb-4" style={{ color: '#1e293b' }}>6. Geological Analysis</h2>
          
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
            <Card style={{ borderColor: '#e2e8f0' }}>
              <CardHeader className="pb-2"><CardTitle className="text-sm text-slate-500">Best Drilling Point</CardTitle></CardHeader>
              <CardContent><span className="text-lg font-bold text-slate-800">{bestDrillingPointVal}</span></CardContent>
            </Card>
            <Card style={{ borderColor: '#e2e8f0' }}>
              <CardHeader className="pb-2"><CardTitle className="text-sm text-slate-500">Recommended Drilling Range</CardTitle></CardHeader>
              <CardContent><span className="text-lg font-bold text-green-700">{recommendedRangeVal}</span></CardContent>
            </Card>
            <Card style={{ borderColor: '#e2e8f0' }}>
              <CardHeader className="pb-2"><CardTitle className="text-sm text-slate-500">Start Depth</CardTitle></CardHeader>
              <CardContent><span className="text-lg font-bold text-blue-700">{startDepthVal}</span></CardContent>
            </Card>
            <Card style={{ borderColor: '#e2e8f0' }}>
              <CardHeader className="pb-2"><CardTitle className="text-sm text-slate-500">End Depth</CardTitle></CardHeader>
              <CardContent><span className="text-lg font-bold text-blue-700">{endDepthVal}</span></CardContent>
            </Card>
            <Card style={{ borderColor: '#e2e8f0' }}>
              <CardHeader className="pb-2"><CardTitle className="text-sm text-slate-500">Confidence</CardTitle></CardHeader>
              <CardContent><span className="text-lg font-bold text-purple-700">{parsedData.confidence || "N/A"}</span></CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <div>
              <h4 className="font-semibold text-slate-700 mb-1">Original Profile Analysis</h4>
              <p className="text-sm leading-relaxed" style={{ color: '#334155' }}>{parsedData.originalProfileAnalysis || "N/A"}</p>
            </div>
            <div>
              <h4 className="font-semibold text-slate-700 mb-1">Processed Map Analysis</h4>
              <p className="text-sm leading-relaxed" style={{ color: '#334155' }}>{parsedData.processedProfileAnalysis || "N/A"}</p>
            </div>
          </div>
        </div>

        <div className="text-center text-sm py-4" style={{ color: '#94a3b8' }}>
          Generated by AquaScan AI • Professional Borewell Analysis
        </div>

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
