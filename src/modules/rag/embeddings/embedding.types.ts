export interface EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;

  embed(text: string): Promise<number[]>;
  embedMany(texts: string[]): Promise<number[][]>;
}
