const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const fs = require('fs');
const dotenv = require('dotenv');
const { Readable } = require('stream');
const { default: axios } = require('axios');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

dotenv.config();

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
       });

    });

    socket.on('disconnect', async(data) => {
        console.log('socket.id is disconnected', socket.id);
    })
})

server.listen(5001, () => {
    console.log('Server is running on port 5001');
});

 