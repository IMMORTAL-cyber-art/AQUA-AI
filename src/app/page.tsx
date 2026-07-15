"use client";
import { useState } from "react";
import { SurveyForm } from "@/components/SurveyForm";
import { ReportView } from "@/components/ReportView";

export default function Home() {
  const [reportData, setReportData] = useState<any>(null);

  if (reportData) {
    return (
      <ReportView 
        report={{
          customerName: reportData.customerName,
          originalImage: reportData.originalImage,
          annotatedOriginalImage: reportData.annotatedOriginalImage,
          processedImage: reportData.processedImage,
          annotatedProcessedImage: reportData.annotatedProcessedImage,
          features: reportData.features,
          geminiData: JSON.stringify(reportData.geminiData)
        }} 
        parsedData={reportData.geminiData}
        onNewSurvey={() => setReportData(null)}
      />
    );
  }

  return <SurveyForm onSuccess={(data) => setReportData(data)} />;
}
