import type { Metadata } from "next";
import { ExperimentView } from "@/components/experiment-view";

export const metadata: Metadata = { title: "实验计划" };

export default function ExperimentPage() {
  return <ExperimentView />;
}
