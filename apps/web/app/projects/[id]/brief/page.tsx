import type { Metadata } from "next";
import { BriefView } from "@/components/brief-view";

export const metadata: Metadata = { title: "产品 Brief" };

export default function BriefPage() {
  return <BriefView />;
}
