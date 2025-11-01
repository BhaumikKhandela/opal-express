const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const fs = require('fs');
const dotenv = require('dotenv');
const { Readable } = require('stream');
const { default: axios } = require('axios');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const OpenAI = require('openai');
const Groq = require('groq-sdk');
dotenv.config();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const groqClient = new Groq({
    apiKey: process.env.OPENAI_API_KEY,
});


const s3 = new S3Client({
    credentials: {
        accessKeyId: process.env.ACCESS_KEY,
        secretAccessKey: process.env.SECRET_KEY
    },
    region: process.env.BUCKET_REGION,
})

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const io = new Server(server, {
    cors: {
        origin: process.env.ELECTRON_HOST,
        methods: ['GET', 'POST']

    }
});

let recordedChunks = [];

io.on('connection', (socket) => {
    console.log('socket is connected')
    socket.on('video-chunks', async (data) => {
        console.log('video-chunks received at server', data);
        const writeStream = fs.createWriteStream('temp_upload/' + data.filename);
        recordedChunks.push(data.chunks);
        const videoBlob = new Blob(recordedChunks, {type: 'video/webm; codecs=vp9'});

        const buffer = Buffer.from(await videoBlob.arrayBuffer());
        const readStream = Readable.from(buffer);
        readStream.pipe(writeStream).on('finish', () => {
            console.log('Chunk saved');
        })

    });
 
    socket.on('process-video', async (data) => {
  recordedChunks = [];

  const filePath = `temp_upload/${data.filename}`;

  try {
    const processing = await axios.post(
      `${process.env.NEXT_API_HOST}recording/${data.userId}/processing`,
      { filename: data.filename }
    );

    if (processing.data.status !== 200) {
      console.log('Error in processing status update');
      return;
    }

    const Key = data.filename;
    const Bucket = process.env.BUCKET_NAME;
    const ContentType = 'video/webm';

    // ✅ Create a readable stream correctly
    const fileStream = fs.createReadStream(filePath);

    const command = new PutObjectCommand({
      Key,
      Bucket,
      ContentType,
      Body: fileStream, // ✅ Use the stream directly
    });

    const fileStatus = await s3.send(command);

    if (fileStatus['$metadata'].httpStatusCode === 200) {
      console.log('🟢 Video uploaded to AWS');

      console.log('processing plan:', processing);
      if (processing.data.plan === 'PRO') {
        console.log('Starting transcription and summary generation...');
        fs.stat(filePath, async (error, stat) => {
          if (!error && stat.size <= 25_000_000) {
            console.log('File size is within limit, proceeding with transcription.');
            try {
              const transcription = await groqClient.audio.translations.create({
                file: fs.createReadStream(filePath),
                model: 'whisper-large-v3',
                response_format: 'text',
              });

              if (transcription) {
                console.log('Transcription completed:', transcription);
                const completion = await groqClient.chat.completions.create({
                  model: 'llama-3.1-8b-instant',
                  response_format: { type: 'json_object' },
                  messages: [
                    {
                      role: 'system',
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
                  console.log(`🔴 Error: Something went wrong while creating the title and summary`);
                }
                console.log('Title and summary generated successfully');
              }
            } catch (err) {
              console.error('🔴 Error during transcription or summary generation:', err);
            }
          }
        });
      }

      const stopProcessing = await axios.post(
        `${process.env.NEXT_API_HOST}recording/${data.userId}/complete`,
        { filename: data.filename }
      );

      if (stopProcessing.data.status !== 200) {
        console.log('🔴 Error: Something went wrong completing the processing status');
      }

      if (stopProcessing.status === 200) {
        fs.unlink(filePath, (err) => {
          if (!err) console.log(`${data.filename} 🟢 deleted successfully`);
        });
      }
    } else {
      console.log('🔴 Error: Upload failed');
    }
  } catch (err) {
    console.error('🔴 Error in process-video:', err);
  }
});


    socket.on('disconnect', async(data) => {
        console.log('socket.id is disconnected', socket.id);
    })
})

server.listen(5001, () => {
    console.log('Server is running on port 5001');
});

 