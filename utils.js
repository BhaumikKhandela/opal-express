const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const Groq = require("groq-sdk");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");

console.log("[INIT] Loading Groq + S3 clients");

const groqClient = new Groq({
  apiKey: process.env.OPENAI_API_KEY,
});

const s3 = new S3Client({
  credentials: {
    accessKeyId: process.env.ACCESS_KEY,
    secretAccessKey: process.env.SECRET_KEY,
  },
  region: process.env.BUCKET_REGION,
});

const getVideoStreamFromS3 = async (source) => {
  console.log("[S3] Fetching object from S3");
  console.log("[S3] Bucket:", process.env.BUCKET_NAME);
  console.log("[S3] Key:", source);

  const command = new GetObjectCommand({
    Bucket: process.env.BUCKET_NAME,
    Key: source,
  });

  const start = Date.now();
  const response = await s3.send(command);
  console.log("[S3] GetObject response in", Date.now() - start, "ms");

  if (!response.Body) {
    console.error("[S3] ERROR: response.Body is empty");
    throw new Error("S3 object has no body");
  }

  console.log("[S3] Stream received successfully");
  return response.Body;
};

const transcribeFromS3 = async (key) => {
  console.log("\n[TRANSCRIBE] Starting transcription");
  console.log("[TRANSCRIBE] S3 key:", key);

  const s3Stream = await getVideoStreamFromS3(key);

  const tempPath = path.join("/tmp", path.basename(key));
  console.log("[FS] Writing temp file:", tempPath);

  const writeStart = Date.now();
  await pipeline(s3Stream, fs.createWriteStream(tempPath));
  console.log("[FS] File written in", Date.now() - writeStart, "ms");

  const stats = fs.statSync(tempPath);
  console.log(
    "[FS] File size:",
    (stats.size / 1024 / 1024).toFixed(2),
    "MB"
  );

  console.log("[GROQ] Sending audio for transcription");
  console.log("[GROQ] Model: whisper-large-v3");

  const groqStart = Date.now();

  try {
    const transcription = await groqClient.audio.translations.create({
      file: fs.createReadStream(tempPath),
      model: "whisper-large-v3",
    });

    console.log(
      "[GROQ] Transcription completed in",
      Date.now() - groqStart,
      "ms"
    );

    console.log(
      "[GROQ] Transcription length:",
      transcription.text?.length ?? 0
    );

    return transcription.text;
  } catch (err) {
    console.error("[GROQ] ERROR during transcription");
    console.error("Name:", err.name);
    console.error("Message:", err.message);
    console.error("Status:", err.status);
    console.error("Cause:", err.cause);
    throw err;
  }
};

module.exports = {
  groqClient,
  s3,
  getVideoStreamFromS3,
  transcribeFromS3,
};
