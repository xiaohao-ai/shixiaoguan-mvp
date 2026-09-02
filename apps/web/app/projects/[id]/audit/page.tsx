import type { Metadata } from "next";
import { AuditView } from "@/components/audit-view";

export const metadata: Metadata = { title: "审计回放" };

export default function AuditPage() {
  return <AuditView />;
}
