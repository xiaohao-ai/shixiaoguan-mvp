import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentPanel, validateAttachment } from "@/components/attachment-panel";

const mocks = vi.hoisted(() => ({
  listAttachments: vi.fn(),
  uploadAttachment: vi.fn(),
  project: undefined as { status?: string; workflow_state?: string } | undefined,
}));

vi.mock("@/components/project-context", () => ({
  useProject: () => ({ projectId: "project-1", project: mocks.project }),
}));

vi.mock("@/lib/api", () => ({
  api: {
    listAttachments: mocks.listAttachments,
    uploadAttachment: mocks.uploadAttachment,
  },
  attachmentContentUrl: (_projectId: string, attachmentId: string) => `http://api.test/${attachmentId}`,
  getErrorMessage: (error: unknown) => error instanceof Error ? error.message : "操作失败",
}));

const attachment = {
  id: "attachment-1",
  project_id: "project-1",
  object_key: "project-1/attachment-1.png",
  original_filename: "shoe.png",
  mime_type: "image/png" as const,
  size_bytes: 128,
  sha256: "b".repeat(64),
  rights_declaration: "项目自制并授权本次 Demo 展示",
  source: "USER_UPLOAD",
  created_at: "2026-09-03T08:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listAttachments.mockResolvedValue([]);
  mocks.uploadAttachment.mockResolvedValue(attachment);
  mocks.project = undefined;
});

describe("image attachment gate", () => {
  it("rejects unsupported types, oversized images, and missing rights", () => {
    const csv = new File(["a,b"], "data.csv", { type: "text/csv" });
    expect(validateAttachment(csv, "已授权")).toMatch(/JPG/);

    const oversized = new File(
      [new Uint8Array(5 * 1024 * 1024 + 1)],
      "large.png",
      { type: "image/png" },
    );
    expect(validateAttachment(oversized, "已授权")).toMatch(/5 MB/);

    const image = new File([new Uint8Array([137, 80, 78, 71])], "shoe.png", { type: "image/png" });
    expect(validateAttachment(image, "  ")).toMatch(/权属声明/);
  });

  it("does not call the upload API when the selected file is not an image", async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<AttachmentPanel />);
    await screen.findByText(/尚未上传项目图片/);

    await user.upload(screen.getByLabelText("图片文件"), new File(["a,b"], "data.csv", { type: "text/csv" }));
    fireEvent.change(screen.getByLabelText("图片权属声明"), { target: { value: "已授权" } });
    await user.click(screen.getByRole("button", { name: /上传并记录权属/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("只允许 JPG、PNG 或 WebP");
    expect(mocks.uploadAttachment).not.toHaveBeenCalled();
  });

  it("uploads a permitted image with rights and renders server metadata", async () => {
    const user = userEvent.setup();
    mocks.listAttachments
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([attachment]);
    render(<AttachmentPanel />);
    await screen.findByText(/尚未上传项目图片/);

    const image = new File([new Uint8Array([137, 80, 78, 71])], "shoe.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("图片文件"), image);
    await user.type(screen.getByLabelText("图片权属声明"), attachment.rights_declaration);
    await user.click(screen.getByRole("button", { name: /上传并记录权属/ }));

    await waitFor(() => expect(mocks.uploadAttachment).toHaveBeenCalledWith(
      "project-1",
      image,
      attachment.rights_declaration,
    ));
    expect(await screen.findByText(attachment.original_filename)).toBeInTheDocument();
    expect(screen.getByText(attachment.sha256)).toBeInTheDocument();
    expect(screen.getByText(attachment.rights_declaration)).toBeInTheDocument();
    expect(screen.getByText("仅展示 · 不识图")).toBeInTheDocument();
  });

  it("keeps the attachment entry read-only after archival", async () => {
    mocks.project = { status: "ARCHIVED", workflow_state: "ARCHIVED" };
    render(<AttachmentPanel />);
    await screen.findByText(/尚未上传项目图片/);

    expect(screen.getByLabelText("图片文件")).toBeDisabled();
    expect(screen.getByLabelText("图片权属声明")).toBeDisabled();
    expect(screen.getByRole("button", { name: /上传并记录权属/ })).toBeDisabled();
    expect(screen.getByText(/现有图片可查看，但不能再上传附件/)).toBeInTheDocument();
    expect(mocks.uploadAttachment).not.toHaveBeenCalled();
  });
});
