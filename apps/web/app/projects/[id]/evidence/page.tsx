import type { Metadata } from "next";
import { EvidenceView } from "@/components/evidence-view";

export const metadata: Metadata = { title: "质检与证据" };

export default function EvidencePage() {
  return <EvidenceView />;
}
