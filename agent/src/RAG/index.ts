import {collection, ChromaDocument} from "./injestion/db.js";

export async function retriever(query: string): Promise<ChromaDocument> {
    const results = await collection.query({
        queryTexts: [query],
        nResults: 2
    });


    return results;
}