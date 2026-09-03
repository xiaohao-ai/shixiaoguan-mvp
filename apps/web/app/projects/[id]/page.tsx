import { ProjectIndexRedirect } from "@/components/project-index-redirect";

export default async function ProjectIndex({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProjectIndexRedirect projectId={id} />;
}
