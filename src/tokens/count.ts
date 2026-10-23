/**
 * Token counting for the token-efficiency report behind `search --intent
 * code-context --measure-tokens`.
 *
 * One tokenizer (o200k_base, via js-tiktoken) counts both the highlights and
 * the full page text so the per-result reduction is comparable. The ranks are
 * loaded lazily: the default search path never pays for them.
 */

export const TOKENIZER_NAME = "o200k_base";

interface Encoder {
  encode(text: string): number[];
}

let encoderPromise: Promise<Encoder> | undefined;

async function loadEncoder(): Promise<Encoder> {
  if (!encoderPromise) {
    encoderPromise = (async () => {
      const [{ Tiktoken }, ranks] = await Promise.all([
        import("js-tiktoken/lite"),
        import("js-tiktoken/ranks/o200k_base"),
      ]);
      return new Tiktoken(ranks.default);
    })();
  }
  return encoderPromise;
}

/** Count tokens in `text` with the shared tokenizer. Empty input counts as 0. */
export async function countTokens(text: string): Promise<number> {
  if (!text) return 0;
  const encoder = await loadEncoder();
  return encoder.encode(text).length;
}

/** Per-result token report: what the highlights cost versus the full text. */
export interface TokenReport {
  tokenizer: string;
  highlights: number;
  /** Null when the page text was not requested, so no reduction can be measured. */
  text: number | null;
  /** Percentage of tokens saved by shipping highlights instead of text; null when unmeasured. */
  reductionPct: number | null;
}

export async function buildTokenReport(
  highlights: string[],
  text: string | undefined
): Promise<TokenReport> {
  const highlightTokens = await countTokens(highlights.join("\n"));
  if (text === undefined) {
    return { tokenizer: TOKENIZER_NAME, highlights: highlightTokens, text: null, reductionPct: null };
  }
  const textTokens = await countTokens(text);
  const reductionPct =
    textTokens === 0 ? 0 : Math.round(((textTokens - highlightTokens) / textTokens) * 1000) / 10;
  return { tokenizer: TOKENIZER_NAME, highlights: highlightTokens, text: textTokens, reductionPct };
}
