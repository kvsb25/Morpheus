import { ChromaClient, Metadata, QueryResult } from "chromadb";
import { GoogleGeminiEmbeddingFunction } from "@chroma-core/google-gemini";
const client = new ChromaClient({
  host: "chroma",
  port: 8000
});

export const collection = await client.getOrCreateCollection({
  name: "morpheus_collection",
  embeddingFunction: new GoogleGeminiEmbeddingFunction({
    apiKey: process.env.GEMINI_API_KEY,
    modelName: "gemini-embedding-2",
  })
});

export type ChromaDocument = QueryResult;