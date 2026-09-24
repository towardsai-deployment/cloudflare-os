import { isTextLikeAttachmentMimeType } from "@gadgets/workshop-shared/api";
import type { AiModelConfig, AiModelProvider, ChatAttachmentUpload } from "@gadgets/workshop-shared/api";
import {
  convertDocumentToMarkdown, convertibleDocumentFormat, documentMimeType, formatByteSize,
  unsupportedFileTypeMessage,
} from "@gadgets/backend-utils/document-markdown";
import { PDF_MIME_TYPE } from "./chat-attachment-pdf";

// Bounds attachment storage and the bytes replayed into model requests.
const MAX_CHAT_ATTACHMENT_BYTES = 1024 * 1024;

/** Raw size cap for a document that is converted to Markdown at upload; only its text is stored. */
export const MAX_CONVERTIBLE_CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// A converted document's text is replayed into every turn like any text attachment, and conversion
// makes large ones common, so it is capped well below MAX_CHAT_ATTACHMENT_BYTES: 256 KB is roughly
// 64k tokens, a quarter of the deployed models' context window.
const MAX_CONVERTED_CHAT_ATTACHMENT_BYTES = 256 * 1024;

const IMAGE_SIGNATURES = new Map<string, readonly (number | null)[]>([
  ["image/jpeg", [0xFF, 0xD8, 0xFF]],
  ["image/png", [0x89, 0x50, 0x4E, 0x47]],
  ["image/webp", [
    0x52, 0x49, 0x46, 0x46,
    null, null, null, null,
    0x57, 0x45, 0x42, 0x50,
  ]],
]);

// Magic-number prefixes checked at upload. Like the image signatures, the PDF one ("%PDF-")
// only stops mislabeled uploads at the door; nothing here parses the content.
const CONTENT_SIGNATURES = new Map<string, readonly (number | null)[]>([
  ...IMAGE_SIGNATURES,
  [PDF_MIME_TYPE, [0x25, 0x50, 0x44, 0x46, 0x2D]],
]);

const isTextOrImageMime = (mimeType: string) =>
  isTextLikeAttachmentMimeType(mimeType) || IMAGE_SIGNATURES.has(mimeType);

const isTextImageOrPdfMime = (mimeType: string) =>
  isTextOrImageMime(mimeType) || mimeType === PDF_MIME_TYPE;

// pi-ai encodes only text and image content parts, so text + images are universal. PDFs ride an
// image part and are bridged to a provider's native document input where one exists: Gemini takes
// application/pdf inline data as-is, and Anthropic/OpenAI payloads are rewritten in flight (see
// chat-attachment-pdf.ts). Workers AI and Ollama chat endpoints have no document input at all.
// The deployment's open models are declared text-only, so they take text attachments alone.
const ATTACHMENT_SUPPORT_BY_PROVIDER = {
  anthropic: isTextImageOrPdfMime,
  openai: isTextImageOrPdfMime,
  google: isTextImageOrPdfMime,
  cloudflare: isTextOrImageMime,
  ollama: isTextOrImageMime,
  "gateway-openai": isTextLikeAttachmentMimeType,
} satisfies Record<AiModelProvider, (mimeType: string) => boolean>;

function sanitizeChatAttachmentMimeType(mimeType: string | undefined): string {
  if (!mimeType || /[\r\n]/.test(mimeType)) return "application/octet-stream";
  return mimeType.split(";", 1)[0].trim().toLowerCase() || "application/octet-stream";
}

function sanitizeChatAttachmentName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  let result = name.replace(/[\r\n]/g, " ").slice(0, 255).trim();
  return result || undefined;
}

/** Reject an attachment type that the selected provider cannot accept. */
export function assertChatAttachmentSupportedByProvider(
  provider: AiModelProvider | undefined,
  mimeType: string,
  byteLength: number,
  name?: string,
): void {
  if (byteLength > MAX_CHAT_ATTACHMENT_BYTES) {
    throw new Error("Chat attachment is too large.");
  }

  if (provider ? ATTACHMENT_SUPPORT_BY_PROVIDER[provider](mimeType) : isTextOrImageMime(mimeType)) return;

  throw new Error(unsupportedFileTypeMessage(mimeType, name));
}

/**
 * Whether an upload is a convertible document (PDF, Office, ...) that the provider can't take
 * natively, so it is stored as its Markdown text instead (see convertChatAttachmentToMarkdown).
 * With no model selected no provider is known to take documents, so they are always converted.
 */
export function chatAttachmentNeedsConversion(
  provider: AiModelProvider | undefined,
  mimeType: string | undefined,
  name?: string,
): boolean {
  let documentType = documentMimeType(sanitizeChatAttachmentMimeType(mimeType), name);
  if (!convertibleDocumentFormat(documentType)) return false;
  return !provider || !ATTACHMENT_SUPPORT_BY_PROVIDER[provider](documentType);
}

/**
 * Replace a document upload with its Markdown text, as `<name>.md` of type text/markdown, which
 * every provider accepts and replay inlines like any text file. Throws a user-readable error when
 * the document is too large, can't be converted, or converts to more text than a chat may carry.
 */
export async function convertChatAttachmentToMarkdown(
  ai: Ai | undefined,
  gateway: GatewayOptions | undefined,
  attachment: ChatAttachmentUpload,
): Promise<ChatAttachmentUpload> {
  let name = sanitizeChatAttachmentName(attachment.name) ?? "document";
  if (attachment.content.byteLength > MAX_CONVERTIBLE_CHAT_ATTACHMENT_BYTES) {
    throw new Error(
        `${name} is ${formatByteSize(attachment.content.byteLength)}; documents must be ` +
        `${formatByteSize(MAX_CONVERTIBLE_CHAT_ATTACHMENT_BYTES)} or smaller.`);
  }
  let mimeType = documentMimeType(sanitizeChatAttachmentMimeType(attachment.mimeType), name);
  let markdown = await convertDocumentToMarkdown(ai, {name, bytes: attachment.content, mimeType}, {gateway});
  let content = new TextEncoder().encode(markdown);
  if (content.byteLength > MAX_CONVERTED_CHAT_ATTACHMENT_BYTES) {
    throw new Error(
        `${name} converts to ${formatByteSize(content.byteLength)} of text; the limit is ` +
        `${formatByteSize(MAX_CONVERTED_CHAT_ATTACHMENT_BYTES)}. Split it or upload only the pages you need.`);
  }
  // Leave room for the suffix within the 255-character name limit.
  return {mimeType: "text/markdown", name: `${name.slice(0, 252)}.md`, content};
}

/** Normalize and validate attachment bytes before staging them in chat storage. */
export function validateChatAttachmentUpload(
  attachment: ChatAttachmentUpload,
  provider?: AiModelConfig["provider"],
): ChatAttachmentUpload {
  attachment.name = sanitizeChatAttachmentName(attachment.name);
  attachment.mimeType = sanitizeChatAttachmentMimeType(attachment.mimeType);
  assertChatAttachmentSupportedByProvider(
    provider, attachment.mimeType, attachment.content.byteLength, attachment.name);

  let signature = CONTENT_SIGNATURES.get(attachment.mimeType);
  if (signature) {
    for (let [index, expected] of signature.entries()) {
      if (expected !== null && attachment.content[index] !== expected) {
        throw new Error("Chat attachment content does not match its MIME type.");
      }
    }
  }

  return attachment;
}

/** Whether a MIME type is one of the image encodings Workshop accepts for chat attachments. */
export function isAllowedChatAttachmentImageMimeType(mimeType: string | undefined): boolean {
  return IMAGE_SIGNATURES.has(sanitizeChatAttachmentMimeType(mimeType));
}
