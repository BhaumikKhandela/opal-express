const { Pinecone } = require('@pinecone-database/pinecone');
const dotenv = require('dotenv');
const { GoogleGenAI } = require('@google/genai');

dotenv.config();

// Modern Pinecone initialization - no separate init() call needed
const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
});

// Google GenAI initialization
const gemini = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// Get the index reference
const pineconeIndex = pinecone.index(process.env.PINECONE_INDEX);

// Generate embeddings using Google GenAI
async function getEmbedding(text) {
  const result = await gemini.models.embedContent({
    model: "text-embedding-004",
    contents: text,
  });
  
  const emb = result.embeddings;
  if (!emb || emb.length === 0 || !emb[0].values) {
    throw new Error("No embeddings returned from Gemini API");
  }
  
  console.log(`Embedding dimension: ${emb[0].values.length}`);
  return emb[0].values;
}


// Upsert vectors to Pinecone with namespace support
async function upsertVectors(vectors, namespace) {
  console.log(`Upserting ${vectors.length} vectors to namespace: ${namespace}`);

  const pineconeRecords = vectors.map((vector) => ({
    id: vector.id,
    values: vector.values,
    metadata: vector.metadata,
  }));

  try {
    const response = await pineconeIndex.namespace(namespace).upsert(pineconeRecords);
    console.log(`Upsert response:`, response);
    
    // Return a consistent response object
    return {
      success: true,
      upsertedCount: vectors.length,
      response: response
    };
  } catch (error) {
    console.error('Error upserting to Pinecone:', error);
    throw error;
  }
}

async function queryVectors(namespace, embedding, topK = 5){
   console.log(`Querying namespace: ${namespace} for top ${topK} results`);
  
   try {

    const queryResponse = await pineconeIndex.namespace(namespace).query({
      vector: embedding,
      topK: topK,
      includeMetadata: true,
      includeValues: false
    });

    return queryResponse;
   }catch(error){
    console.error('Error quering to Pinecone:', error);
    throw error;
   }
}

// Chunk transcript into smaller pieces for embedding
function chunkTranscript(text, options = {}) {
  const { maxChunkSize = 500, overlap = 100 } = options;
  
  // Split by sentences first (content-aware chunking)
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  
  const chunks = [];
  let currentChunk = [];
  let currentWordCount = 0;
  
  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/);
    const sentenceWordCount = words.length;
    
    // If adding this sentence exceeds max size, save current chunk
    if (currentWordCount + sentenceWordCount > maxChunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.join(' '));
      
      // Create overlap by keeping last few words
      const overlapWords = currentChunk.join(' ').split(/\s+/).slice(-overlap);
      currentChunk = [overlapWords.join(' ')];
      currentWordCount = overlapWords.length;
    }
    
    currentChunk.push(sentence.trim());
    currentWordCount += sentenceWordCount;
  }
  
  // Add the last chunk
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join(' '));
  }
  
  return chunks;
}

module.exports = {
  pineconeIndex,
  getEmbedding,
  upsertVectors,
  chunkTranscript,
  queryVectors,
};
