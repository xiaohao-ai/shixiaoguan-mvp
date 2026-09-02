import type { Metadata } from "next";
import { DecisionView } from "@/components/decision-view";

export const metadata: Metadata = { title: "决策卡" };

export default function DecisionPage() {
  return <DecisionView />;
}
