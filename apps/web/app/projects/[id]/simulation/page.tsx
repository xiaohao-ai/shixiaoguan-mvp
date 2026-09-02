import type { Metadata } from "next";
import { SimulationView } from "@/components/simulation-view";

export const metadata: Metadata = { title: "试销回放" };

export default function SimulationPage() {
  return <SimulationView />;
}
