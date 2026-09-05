declare module "@xenova/transformers" {
  export function pipeline(
    task: string,
    model: string,
    options?: { quantized?: boolean | null },
  ): Promise<any>;
}
