import {collection, ChromaDocument} from "./injestion/db.js";

export default async function retriever(query: string): Promise<ChromaDocument> {
    const results = await collection.query({
        queryTexts: [query],
    });
    return results;
}