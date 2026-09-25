import { describe, expect, it, vi } from "vitest";

// library-read.ts imports workerd's RpcStub only as a type, and the @validateRpc() transform
// only runs in the Wrangler build (untransformed it throws), so both are stubbed for Node.
vi.mock("cloudflare:workers", () => ({ RpcStub: class {} }));
vi.mock("capnweb-validate", () => ({ validateRpc: () => (target: unknown) => target }));

const { LibraryReadSession } = await import("../src/library-read.js");
type ContextDocument = import("../src/context-types.js").ContextDocument;
const { MAX_CONVERTED_MARKDOWN_CHARS, MAX_DOCUMENT_BODY_BYTES } = await import("../src/context-types.js");

const PDF_BODY = Buffer.from("%PDF-1.7 legacy").toString("base64");
const TEXT = "# old.pdf\n\n## Contents\n\nThe onboarding checklist covers laptops, accounts and badges.";

function storedDoc(path: string, contentType: string, body: string): ContextDocument {
  return {
    path, name: path, description: "", contentType, body, lastUpdated: new Date(0),
  };
}

function makeSession(doc: ContextDocument, ai?: Ai) {
  let namespace = (stub: object) => ({ idFromName: (name: string) => name, get: () => stub });
  let authorizer = { authorizeObservation: vi.fn(async () => {}) };
  return new LibraryReadSession(
    namespace({ getContextDocument: async () => doc }) as never,
    namespace({ getEnabledCollections: async () => new Map([["c1", "private"]]) }) as never,
    "workshop.example", "account-1", authorizer as never,
    async () => ({ pendingCollections: [], commit() {} }),
    ai,
  );
}

function aiReturning(data: string) {
  let toMarkdown = vi.fn(async (doc: { name: string; blob: Blob }) => ({
    id: "x", name: doc.name, mimeType: doc.blob.type, format: "markdown" as const, tokens: 1, data,
  }));
  return { ai: { toMarkdown } as unknown as Ai, toMarkdown };
}

describe("LibraryReadSession.read of stored binaries", () => {
  it("returns a legacy PDF as Markdown when Workers AI is bound", async () => {
    let { ai, toMarkdown } = aiReturning(TEXT);
    let session = makeSession(storedDoc("old.pdf", "application/pdf", PDF_BODY), ai);

    let result = await session.read("c1/old.pdf");

    expect(result?.content).toBe(`> Converted from the stored PDF file old.pdf for reading.\n\n${TEXT}`);
    let [sent] = toMarkdown.mock.calls[0];
    expect(new TextDecoder().decode(await sent.blob.arrayBuffer())).toBe("%PDF-1.7 legacy");
  });

  it("returns a short note instead of base64 when there is no binding", async () => {
    let session = makeSession(storedDoc("old.pdf", "application/pdf", PDF_BODY));

    let result = await session.read("c1/old.pdf");

    expect(result?.content).toBe(
      "[old.pdf is a stored PDF file that couldn't be shown as text. " +
      "Document conversion isn't available on this deployment (Workers AI isn't bound).]");
  });

  it("cuts converted text at the character cap, with a note saying why", async () => {
    let { ai } = aiReturning("x".repeat(1_000_000));
    let session = makeSession(storedDoc("big.pdf", "application/pdf", PDF_BODY), ai);

    let content = (await session.read("c1/big.pdf"))!.content;
    let [header, body] = content.split("\n\n");

    expect(header).toBe(
      "> Converted from the stored PDF file big.pdf for reading.\n" +
      "> Truncated: its text is longer than the 900,000 characters one read returns; this is the start. " +
      "Split the file and upload the parts to read the rest.");
    expect(body.length).toBe(MAX_CONVERTED_MARKDOWN_CHARS);
  });

  it("cuts non-Latin text at the byte cap, on a character boundary", async () => {
    // Three UTF-8 bytes each: 600,000 characters (under the character cap) are 1.8 MB.
    let { ai } = aiReturning("\u6f22".repeat(600_000));
    let session = makeSession(storedDoc("big.pdf", "application/pdf", PDF_BODY), ai);

    let content = (await session.read("c1/big.pdf"))!.content;
    let body = content.slice(content.indexOf("\n\n") + 2);

    expect(content).toContain("longer than the 1.4 MB one read returns");
    expect(body).toBe("\u6f22".repeat(Math.floor(MAX_DOCUMENT_BODY_BYTES / 3)));
  });

  it("leaves text within the caps whole", async () => {
    let { ai } = aiReturning(TEXT);
    let session = makeSession(storedDoc("old.pdf", "application/pdf", PDF_BODY), ai);

    expect((await session.read("c1/old.pdf"))!.content).not.toContain("Truncated");
  });

  it("still returns images as data: URIs", async () => {
    let { ai, toMarkdown } = aiReturning(TEXT);
    let session = makeSession(storedDoc("logo.png", "image/png", "iVBORw0KGgo="), ai);

    let result = await session.read("c1/logo.png");

    expect(result?.content).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(toMarkdown).not.toHaveBeenCalled();
  });
});
