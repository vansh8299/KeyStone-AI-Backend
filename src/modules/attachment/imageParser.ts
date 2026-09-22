import { createImageReaderTool } from "../rag/langchain/tools/imageReaderTool";

export class ImageParseError extends Error {}

const imageReader = createImageReaderTool();

export async function parseImage(data: Buffer, mimeType: string): Promise<string> {
  const text = await imageReader.invoke({
    imageBase64: data.toString("base64"),
    mimeType: mimeType as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
  });
  if (!text.trim()) throw new ImageParseError("The image couldn't be read.");
  return text;
}
