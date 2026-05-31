import {collection} from "./db.js";
import { TextLoader } from "@langchain/classic/document_loaders/fs/text"
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

const loader = new TextLoader("../data/runbook.txt")
const docs = await loader.load()

const splitter = new RecursiveCharacterTextSplitter({
  separators: ["---"],
  chunkSize: 1000000,
  chunkOverlap: 0,
});

const texts = await splitter.splitText(docs[0].pageContent);

const ids = texts.map((_, i) => `doc-${i}`);

await collection.add({
    ids,
    documents: texts,
});