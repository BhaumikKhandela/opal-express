const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const io = new Server(server, {
    cors: {
        origin: process.env.ELECTRON_HOST,
        methods: ['GET', 'POST']

    }
})

io.on('connection', (socket) => {
    console.log('socket is connected')
    socket.on('video-chunks', async (data) => {
        console.log('video-chunks received at server', data);
    });

    socket.on('process-video', async (data) => {
        console.log('processing video', data);
    });

    socket.on('disconnect', async(data) => {
        console.log('socket.id is disconnected', socket.id);
    })
})

server.listen(5001, () => {
    console.log('Server is running on port 5001');
});

 