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
          annotatedImage: reportData.annotatedImage,
          processedImage: reportData.processedImage,
          features: reportData.features,
          geminiData: JSON.stringify(reportData.geminiData) // ReportView expects stringified if it parses it, wait, ReportView expects what?
        }} 
        parsedData={reportData.geminiData}
        onNewSurvey={() => setReportData(null)}
      />
    );
  }

  return <SurveyForm onSuccess={(data) => setReportData(data)} />;
}
