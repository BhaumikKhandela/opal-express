const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const OpenAI = require("openai");
const Groq = require("groq-sdk");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
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
  const command = new GetObjectCommand({
    Bucket: process.env.BUCKET_NAME,
    Key: source,
  });

  const response = await s3.send(command);

  if (!response.Body) {
    throw new Error("S3 object has no body");
  }

  return response.Body;
};

const transcribeFromS3 = async (key) => {
  const s3Stream = await getVideoStreamFromS3(key);

  const tempPath = path.join("/tmp", path.basename(key));

  await pipeline(s3Stream, fs.createWriteStream(tempPath));

  const transcription = await groqClient.audio.translations.create({
    file: fs.createReadStream(tempPath),
    model: "whisper-large-v3",
  });

  return transcription.text;
};

module.exports = {
  groqClient,
  s3,
  getVideoStreamFromS3,
  transcribeFromS3
};
