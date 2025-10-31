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
dotenv.config();

const openai = new OpenAI({
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
       fs.readStream('temp_upload/' + data.filename, async(error,file) => {
        const processing = await axios.post(`${process.env.NEXT_API_HOST}recording/${data.userId}/processing`)

        if(processing.data.status !== 200) return console.log('Error in processing status update');

        const Key = data.filename;
        const Bucket = process.env.BUCKET_NAME;
        const ContentType = 'video/webm';
        const command = new PutObjectCommand({
            Key,
            Bucket,
            ContentType,
            Body: file
        })

          const fileStatus = await s3.send(command);

          if(fileStatus['$metadata'].httpStatusCode === 200) {
             console.log('🟢 Video uploaded to aws');

             if(processing.data.plan === 'PRO'){
                fs.stat('temp_upload/' + data.filename, async(error, stat) => {
                    if(!error){
                        if(stat.size <= 25000000){
                            const transcription = await openai.audio.transcriptions.create({
                                file: fs.createReadStream('temp_upload/' + data.filename),
                                model: 'whisper-1',
                                response_format: 'text'
                            })

                            if(transcription){
                                const completion = await openai.chat.completions.create({
                                    model: 'gpt-3.5-turbo',
                                    response_format: { type: 'json_object' },
                                    messages: [
                                        {
                                            role: 'system',
                                            content: `You are going to generate a title and a nice discription using the speech to text transcription provided: transacription(${transcription}) and the return it in json format as {'title': <Title you gave>, 'summary': <the summary you created>}`
                                        }
                                    ]
                                })

                                const titleAndSummaryGenerated = await axios.post(`${process.env.NEXT_API_HOST}recording/${data.userId}/transcribe`,
                                    {
                                        filename: data.filename,
                                        content: completion.choices[0].message.content,
                                        transcript: transcription,

                                    }
                                )
                                
                                if(titleAndSummaryGenerated.data.status !== 200){
                                    console.log(`🔴 Error: Somethign went wrong with creating the title and summary`);
                                }
                            }
                        }
                    }
                })
             }
             const stopProcessing = await axios.post(`${process.env.NEXT_API_HOST}recording/${data.userId}/complete`,{
                filename: data.filename
             });

             if (stopProcessing.data.status !== 200){
                console.log('🔴 Error: Something went wrong with completing the processing status');
             }
             if(stopProcessing.status === 200){
                fs.unlink('temp_upload/' + data.filename, (err) => {
                 if(!err){
                    console.log(data.filename + ' ' + '🟢 deleted successfully');
                 }
                })
             }
          } else {
            console.log('🔴 Error: Upload failed');
          }
       });

    });

    socket.on('disconnect', async(data) => {
        console.log('socket.id is disconnected', socket.id);
    })
})

server.listen(5001, () => {
    console.log('Server is running on port 5001');
});

 