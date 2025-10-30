const express = require('express');
const http = require('http');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

server.listen(5000, () => {
    console.log('Server is running on port 3000');
}) 