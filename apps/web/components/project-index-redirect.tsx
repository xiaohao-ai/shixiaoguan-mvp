"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { ArrowRight } from "lucide-react";
import { LoadingPanel } from "@/components/ui";

export function ProjectIndexRedirect({ projectId }: { projectId: string }) {
  const router = useRouter();
  const briefPath = `/projects/${projectId}/brief`;

  useEffect(() => {
    router.replace(briefPath);
  }, [briefPath, router]);

  return (
    <div className="stack">
      <LoadingPanel label="正在进入 Product Brief…" />
      <Link className="button w-fit" href={briefPath}>
        直接进入 Product Brief <ArrowRight className="size-4" />
      </Link>
    </div>
  );
}
