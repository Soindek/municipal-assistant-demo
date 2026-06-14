declare module 'word-extractor' {
  interface WordDocument {
    getBody(): string;
    getFootnotes(): string;
    getHeaders(): string;
    getFooters(): string;
    getEndnotes(): string;
  }

  export default class WordExtractor {
    extract(input: string | Buffer): Promise<WordDocument>;
  }
}
