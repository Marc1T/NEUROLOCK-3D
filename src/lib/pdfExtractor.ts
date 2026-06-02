// pdfjs-dist is large (~470 kB minified). We dynamically import it the first
// time extractTextFromPDF() runs so it doesn't bloat the initial bundle.

type PdfjsLib = typeof import('pdfjs-dist');

let cachedLib: PdfjsLib | null = null;

async function loadPdfjs(): Promise<PdfjsLib> {
  if (cachedLib) return cachedLib;
  const [mod, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  cachedLib = mod;
  // Vite serves the worker as a static asset URL via ?url
  cachedLib.GlobalWorkerOptions.workerSrc = worker.default;
  return cachedLib;
}

export type PDFExtractionResult = {
  text: string;
  pageCount: number;
  /** Set if the original text was longer than the prompt cap. */
  truncatedAt?: number;
};

export type PDFExtractionProgress = {
  page: number;
  totalPages: number;
};

/** Hard cap on extracted text length — keeps the LLM prompt manageable. */
const MAX_CHARS = 12000;

/** Extract concatenated text content from a PDF file. */
export async function extractTextFromPDF(
  file: File,
  onProgress?: (p: PDFExtractionProgress) => void,
): Promise<PDFExtractionResult> {
  const pdfjsLib = await loadPdfjs();
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;
  const pageCount = pdf.numPages;
  const pages: string[] = [];

  for (let i = 1; i <= pageCount; i++) {
    onProgress?.({ page: i, totalPages: pageCount });
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map(item => ('str' in item ? (item as { str: string }).str : ''))
      .filter(Boolean)
      .join(' ');
    pages.push(text);
    // Early exit if we've already collected enough characters
    if (pages.join(' ').length > MAX_CHARS) break;
  }

  // Clean the result a bit (collapse whitespace runs)
  const raw = pages.join('\n\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (raw.length > MAX_CHARS) {
    return { text: raw.slice(0, MAX_CHARS), pageCount, truncatedAt: MAX_CHARS };
  }
  return { text: raw, pageCount };
}
