import type { ReactNode } from "react";
import { ProjectProvider } from "@/components/project-context";
import { ProjectShell } from "@/components/project-shell";

export function generateStaticParams() {
  return process.env.NEXT_PUBLIC_STATIC_PREVIEW === "1"
    ? [{ id: "github-pages-demo" }]
    : [];
}

export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <ProjectProvider projectId={id}>
      <ProjectShell>{children}</ProjectShell>
    </ProjectProvider>
  );
}
