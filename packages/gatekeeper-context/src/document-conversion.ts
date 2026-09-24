// Document-to-Markdown conversion for the Context Library: converting an upload before it is
// stored (ContextApi.importContextDocument), and converting a stored PDF or Office document when
// an agent reads it (LibraryReadSession.read), so agents get text rather than a base64 data: URI.

import { Buffer } from "node:buffer";
import {
  convertDocumentToMarkdown, convertibleDocumentFormat, DocumentConversionError, documentMimeType,
  fileExtension,
  formatByteSize, unsupportedFileTypeMessage,
} from "@gadgets/backend-utils/document-markdown";
import {
  MAX_CONVERTED_MARKDOWN_CHARS, MAX_CONVERTIBLE_UPLOAD_BYTES, MAX_DOCUMENT_BODY_BYTES, VENDOR_ID,
  type ContextDocument,
} from "./context-types.js";
import { obsContext } from "./observability.js";

const logger = obsContext.createLogger({ component: "gatekeeper.context", vendorId: VENDOR_ID });

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Convert an uploaded document (base64) to the Markdown stored in its place at `<path>.md`.
 * Throws a user-readable error for an unsupported type, an oversized upload or result, a missing
 * binding, a failed conversion, or a document with no extractable text.
 */
export async function convertUploadedDocument(
  ai: Ai | undefined,
  path: string,
  base64: string,
): Promise<{ path: string; markdown: string }> {
  let name = fileName(path);
  let mimeType = documentMimeType(undefined, name);
  if (!convertibleDocumentFormat(mimeType)) throw new Error(unsupportedFileTypeMessage(undefined, name));

  // Reject before decoding: base64 is 4/3 of the raw size.
  let rawBytes = Math.floor(base64.length * 3 / 4);
  if (rawBytes > MAX_CONVERTIBLE_UPLOAD_BYTES) {
    throw new Error(
      `${name} is ${formatByteSize(rawBytes)}; documents must be ` +
      `${formatByteSize(MAX_CONVERTIBLE_UPLOAD_BYTES)} or smaller.`);
  }
  let bytes = new Uint8Array(Buffer.from(base64, "base64"));
  let markdown = await convertDocumentToMarkdown(ai, { name, bytes, mimeType });

  // UTF-8 bytes are never fewer than UTF-16 code units, so the character cap binds for mostly
  // Latin text and the byte cap for the rest; the message names whichever was hit.
  let utf8Bytes = new TextEncoder().encode(markdown).byteLength;
  let limit = markdown.length > MAX_CONVERTED_MARKDOWN_CHARS ? MAX_CONVERTED_MARKDOWN_CHARS
    : utf8Bytes > MAX_DOCUMENT_BODY_BYTES ? MAX_DOCUMENT_BODY_BYTES : undefined;
  if (limit !== undefined) {
    throw new Error(
      `${name} converts to ${formatByteSize(utf8Bytes)} of text; the limit is ${formatByteSize(limit)}. ` +
      "Split it or upload only the pages you need.");
  }
  return { path: `${path}.md`, markdown };
}

/**
 * The content an agent's read() returns for a stored binary document. A convertible document
 * (a PDF uploaded before conversion existed, or one synced from Git) is converted to Markdown
 * under a one-line provenance note, or replaced by a short note when that fails: either beats
 * megabytes of base64 the model can't use. Images and other binaries stay data: URIs.
 */
export async function readBinaryDocumentContent(ai: Ai | undefined, doc: ContextDocument): Promise<string> {
  let mimeType = documentMimeType(doc.contentType, doc.name);
  if (!convertibleDocumentFormat(mimeType)) return `data:${doc.contentType};base64,${doc.body}`;

  let label = fileExtension(doc.name).toUpperCase() || mimeType;
  try {
    let markdown = await convertDocumentToMarkdown(ai, {
      name: doc.name, bytes: new Uint8Array(Buffer.from(doc.body, "base64")), mimeType,
    });
    return `> Converted from the stored ${label} file ${doc.name} for reading.\n\n${markdown}`;
  } catch (err) {
    // A deployment without the binding is configuration, not a failure worth a log per read.
    if (!(err instanceof DocumentConversionError && err.kind === "unavailable")) {
      logger.warn("failed to convert stored document on read", {
        event: "document.read.convert.failed", error: err,
      });
    }
    let reason = err instanceof Error ? err.message : String(err);
    return `[${doc.name} is a stored ${label} file that couldn't be shown as text. ${reason}]`;
  }
}
