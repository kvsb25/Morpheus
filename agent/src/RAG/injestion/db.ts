import { ChromaClient, Metadata, QueryResult } from "chromadb";
const client = new ChromaClient({
  host: "localhost",
  port: 8000
});

export const collection = await client.createCollection({
  name: "morpheus_collection",
});

export type ChromaDocument = QueryResult;