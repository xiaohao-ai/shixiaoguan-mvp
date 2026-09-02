import type { Metadata } from "next";
import { HandoffView } from "@/components/handoff-view";

export const metadata: Metadata = { title: "工厂交接" };

export default function HandoffPage() {
  return <HandoffView />;
}
