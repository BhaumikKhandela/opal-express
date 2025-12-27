const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const fs = require("fs");
const dotenv = require("dotenv");
const { Readable } = require("stream");
const { default: axios } = require("axios");
const {
  getEmbedding,
  chunkTranscript,
  upsertVectors,
  pineconeIndex,
  queryVectors,
} = require("./pinecone");
dotenv.config();
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const {
  groqClient,
  s3,
  getVideoStreamFromS3,
  transcribeFromS3,
} = require("./utils");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: process.env.ELECTRON_HOST,
    methods: ["GET", "POST"],
  },
});

let recordedChunks = [];

io.on("connection", (socket) => {
  console.log("socket is connected");
  socket.on("video-chunks", async (data) => {
    console.log("video-chunks received at server", data);
    const writeStream = fs.createWriteStream("temp_upload/" + data.filename);
    recordedChunks.push(data.chunks);
    const videoBlob = new Blob(recordedChunks, {
      type: "video/webm; codecs=vp9",
    });

    const buffer = Buffer.from(await videoBlob.arrayBuffer());
    const readStream = Readable.from(buffer);
    readStream.pipe(writeStream).on("finish", () => {
      console.log("Chunk saved");
    });
  });

  socket.on("process-video", async (data) => {
    recordedChunks = [];

    const filePath = `temp_upload/${data.filename}`;

    try {
      const processing = await axios.post(
        `${process.env.NEXT_API_HOST}recording/${data.userId}/processing`,
        { filename: data.filename }
      );

      if (processing.data.status !== 200) {
        console.log("Error in processing status update");
        return;
      }

      const Key = data.filename;
      const Bucket = process.env.BUCKET_NAME;
      const ContentType = "video/webm";

      // ✅ Create a readable stream correctly
      const fileStream = fs.createReadStream(filePath);

      const command = new PutObjectCommand({
        Key,
        Bucket,
        ContentType,
        Body: fileStream, // ✅ Use the stream directly
      });

      const fileStatus = await s3.send(command);

      if (fileStatus["$metadata"].httpStatusCode === 200) {
        console.log("🟢 Video uploaded to AWS");

        console.log("processing plan:", processing);
        if (processing.data.plan === "PRO") {
          console.log("Starting transcription and summary generation...");
          fs.stat(filePath, async (error, stat) => {
            if (!error && stat.size <= 25_000_000) {
              console.log(
                "File size is within limit, proceeding with transcription."
              );
              try {
                const transcription =
                  await groqClient.audio.translations.create({
                    file: fs.createReadStream(filePath),
                    model: "whisper-large-v3",
                    response_format: "text",
                  });

                if (transcription) {
                  const completion = await groqClient.chat.completions.create({
                    model: "llama-3.1-8b-instant",
                    response_format: { type: "json_object" },
                    messages: [
                      {
                        role: "system",
                        content: `You are going to generate a title and a nice description using the speech-to-text transcription provided: transcription(${transcription}) and return it in JSON format as {'title': <Title>, 'summary': <Summary>}`,
                      },
                    ],
                  });

                  const titleAndSummaryGenerated = await axios.post(
                    `${process.env.NEXT_API_HOST}recording/${data.userId}/transcribe`,
                    {
                      filename: data.filename,
                      content: completion.choices[0].message.content,
                      transcript: transcription,
                    }
                  );

                  if (titleAndSummaryGenerated.data.status !== 200) {
                    console.log(
                      `🔴 Error: Something went wrong while creating the title and summary`
                    );
                  }
                  console.log("Title and summary generated successfully");

                  if (
                    titleAndSummaryGenerated.data.status === 200 &&
                    titleAndSummaryGenerated.data.videoId
                  ) {
                    const embeddingResponse = await axios.post(
                      `${process.env.SERVER_HOST}/embed/${titleAndSummaryGenerated.data.videoId}`,
                      {
                        transcription: transcription,
                        title: JSON.parse(completion.choices[0].message.content)
                          .title,
                        summary: JSON.parse(
                          completion.choices[0].message.content
                        ).summary,
                      }
                    );

                    if (embeddingResponse.data.status !== 201) {
                      console.log(
                        "🔴 Embedding failed" +
                          `${embeddingResponse.data.message}`
                      );
                    }
                  }
                }
              } catch (err) {
                console.error(
                  "🔴 Error during transcription or summary generation:",
                  err
                );
              }
            }
          });
        }

        const stopProcessing = await axios.post(
          `${process.env.NEXT_API_HOST}recording/${data.userId}/complete`,
          { filename: data.filename }
        );

        if (stopProcessing.data.status !== 200) {
          console.log(
            "🔴 Error: Something went wrong completing the processing status"
          );
        }

        if (stopProcessing.status === 200) {
          fs.unlink(filePath, (err) => {
            if (!err) console.log(`${data.filename} 🟢 deleted successfully`);
          });
        }
      } else {
        console.log("🔴 Error: Upload failed");
      }
    } catch (err) {
      console.error("🔴 Error in process-video:", err);
    }
  });

  socket.on("disconnect", async (data) => {
    console.log("socket.id is disconnected", socket.id);
  });
});

app.post("/embed/:id", async (req, res) => {
  try {
    const { id: videoId } = req.params;
    const { transcription, title, summary } = req.body;

    if (!transcription) {
      return res.status(400).json({
        status: 400,
        message: "Transcription is required",
      });
    }

    console.log(`🟢 Starting embedding process for video ${videoId}`);

    const chunks = chunkTranscript(transcription, {
      maxChunkSize: 500,
      overlap: 100,
    });

    console.log(`Created chunks ${chunks.length} chunks from transcript`);

    const vectors = [];

    for (let i = 0; i < chunks.length; i++) {
      try {
        const embedding = await getEmbedding(chunks[i]);

        vectors.push({
          id: `${videoId}-chunk-${i}`,
          values: embedding,
          metadata: {
            videoId: videoId,
            chunkInex: i,
            totalChunks: chunks.length,
            text: chunks[i],
            title: title || "",
            summary: summary || "",
            createdAt: new Date().toISOString,
          },
        });

        console.log(
          `✅ Generated embedding for chunk ${i + 1}/${chunks.length}`
        );
      } catch (error) {
        console.error(`❌ Error generating embedding for chunk ${i}:`, error);

        return res.status(500).json({
          status: 500,
          message: "Internal server error",
        });
      }
    }

    const namespace = `video-${videoId}`;

    const upsertResponse = await upsertVectors(vectors, namespace);

    console.log(
      `🟢 Successfully upserted ${vectors.length} vectors to Pinecone`
    );

    return res.status(201).json({
      status: 201,
      message: "Embeddings created successfully",
      data: {
        videoId,
        chunksProcessed: chunks.length,
        namespace,
        upsertedCount: upsertResponse.upsertedCount || vectors.length,
      },
    });
  } catch (error) {
    console.error("🔴 Error in /embed/:id endpoint:", error);
    return res.status(500).json({
      status: 500,
      message: "Failed to create embeddings",
      error: error.message,
    });
  }
});

app.post("/chat/:videoId", async (req, res) => {
  try {
    const { videoId } = req.params;
    const { question } = req.body;

    if (!question) {
      return res.status(400).json({
        status: 400,
        message: "Question is missing from the body",
      });
    }

    console.log(`🤖 Processing question for video ${videoId}: ${question}`);

    const questionEmbedding = await getEmbedding(question);

    const namespace = `video-${videoId}`;
    const queryResponse = await queryVectors(namespace, questionEmbedding, 3);

    console.log(`📊 Found ${queryResponse.matches.length} relevant chunks`);

    if (!queryResponse.matches || queryResponse.matches.length === 0) {
      return res.status(404).json({
        status: 404,
        message: "No relevant information found for this question",
      });
    }

    const relevantContext = queryResponse.matches
      .map((match) => match.metadata.text)
      .join("\n\n");

    const completion = await groqClient.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        {
          role: "system",
          content: `You are a helpful AI assistant that answers questions about a video based on its transcript. 
          Use the following context from the video to answer the user's question accurately. 
          If the context doesn't contain enough information, say so honestly.

Context from video:
${relevantContext}`,
        },
        {
          role: "user",
          content: question,
        },
      ],
      temperature: 0.7,
      max_tokens: 500,
    });

    const answer = completion.choices[0].message.content;
    console.log(`✅ Generated answer: ${answer.substring(0, 100)}...`);

    return res.status(200).json({
      status: 200,
      message: "Answer generated successfully",
      data: {
        question,
        answer,
        sources: queryResponse.matches.map((match) => ({
          chunkIndex: match.metadata.chunkIndex,
          relevanceScore: match.score,
          text: match.metadata.text.substring(0, 200) + "...",
        })),
      },
    });
  } catch (error) {
    console.error("🔴 Error in /chat/:videoId endpoint:", error);
    return res.status(500).json({
      status: 500,
      message: "Failed to generate answer",
      error: error.message,
    });
  }
});

app.post("/generate/:videoId", async (req, res) => {
  try {
    console.log("Request received");
    let { transcription, source } = req.body;
    const { videoId } = req.params;

    console.log(transcription, source, videoId);
    if (!source) {
      return res.status(404).json({
        status: 404,
        message: "Source not found",
      });
    }

    if (transcription === "" || transcription === null) {
      console.log("Inside transcription");
      const transcribe = await transcribeFromS3(source);
      transcription = transcribe;
      console.log("This is transcription type:" ,typeof(transcription));
      await axios.patch(
        `${process.env.NEXT_API_HOST}update-transcript/${videoId}`,
        {
          transcription,
        }
      );
    }
    const completion = await groqClient.chat.completions.create({
      model: "llama-3.1-8b-instant",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are going to generate a title and a nice description using the speech-to-text transcription provided: transcription(${transcription}) and return it in JSON format as {'title': <Title>, 'summary': <Summary>}`,
        },
      ],
    });

    return res.status(200).json({
      status: 200,
      message: "Title and Description generated successfully",
      title: JSON.parse(completion.choices[0].message.content).title,
      description: JSON.parse(completion.choices[0].message.content).summary,
    });
  } catch (error) {
    console.log("This is catch error", error);
    return res.status(500).json({
      status: 500,
      message: "Internal server error",
    });
  }
});

server.listen(5001, () => {
  console.log("Server is running on port 5001");
});
