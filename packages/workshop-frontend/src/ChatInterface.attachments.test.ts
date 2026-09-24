// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { SUGGESTED_MODELS } from "@gadgets/workshop-shared/api";
import { chatAttachmentWillBeConverted } from "./ChatInterface";

const firstModel = (provider: keyof typeof SUGGESTED_MODELS) => Object.keys(SUGGESTED_MODELS[provider])[0];
const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("chatAttachmentWillBeConverted", () => {
  it("keeps PDFs raw (and so under the 1 MB cap) for PDF-native models", () => {
    for (const provider of ["anthropic", "openai", "google"] as const) {
      expect(chatAttachmentWillBeConverted(firstModel(provider), "report.pdf", PDF)).toBe(false);
    }
  });

  it("converts PDFs for other models, unknown models and no model", () => {
    expect(chatAttachmentWillBeConverted(firstModel("cloudflare"), "report.pdf", PDF)).toBe(true);
    expect(chatAttachmentWillBeConverted("qwen3-coder", "report.pdf", PDF)).toBe(true);
    expect(chatAttachmentWillBeConverted(null, "report.pdf", "")).toBe(true);
  });

  it("always converts Office documents, and leaves other files alone", () => {
    expect(chatAttachmentWillBeConverted(firstModel("anthropic"), "memo.docx", DOCX)).toBe(true);
    expect(chatAttachmentWillBeConverted(null, "notes.txt", "text/plain")).toBe(false);
    // A specific MIME type wins over the extension, as on the server.
    expect(chatAttachmentWillBeConverted(null, "notes.pdf", "text/plain")).toBe(false);
  });
});
