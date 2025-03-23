require('dotenv').config({ path: './../.env' });
const { MongoClient } = require('mongodb');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const uri = process.env.MONGO_URL;
console.log("MongoDB URI:", uri);

if (!uri) {
  console.error("Error: MONGO_URL is not defined in the .env file or not loaded properly.");
  process.exit(1);
}

const client = new MongoClient(uri, {
  connectTimeoutMS: 5000,
  serverSelectionTimeoutMS: 5000,
});

const app = express();
const port = process.env.PORT || 3000;
let db;

const server = http.createServer(app);
const io = new Server(server);

async function connectToDatabase() {
  await client.connect();
  console.log("Connected to MongoDB Atlas!");
  db = client.db("myDatabase");
  console.log("Database 'myDatabase' is ready for use.");
}

async function startServer() {
  await connectToDatabase();
  app.use(express.json());

  // Serve static files (e.g., for React Native Web or testing)
  app.use(express.static('public'));

  app.get('/', (req, res) => {
    res.send("Chat server is running and connected to MongoDB Atlas!");
  });

  app.get('/ping', async (req, res) => {
    try {
      await db.command({ ping: 1 });
      res.status(200).json({ message: "Ping successful!" });
    } catch (error) {
      res.status(500).json({ error: "Failed to ping MongoDB", details: error.message });
    }
  });

  app.post('/messages', async (req, res) => {
    try {
      const { conversationId, senderId, content } = req.body;
      if (!conversationId || !senderId || !content) {
        return res.status(400).json({ error: "conversationId, senderId, and content are required" });
      }
      const collection = db.collection("messages");
      const newMessage = {
        conversationId,
        senderId,
        content,
        timestamp: new Date(),
        isRead: false,
      };
      const result = await collection.insertOne(newMessage);
      res.status(201).json({ message: "Message sent", id: result.insertedId });

      // Emit to all participants in the conversation
      const conversation = await db.collection("conversations").findOne({ _id: conversationId });
      if (conversation) {
        conversation.participants.forEach(participantId => {
          io.to(participantId).emit('newMessage', newMessage);
        });
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to send message", details: error.message });
    }
  });

  app.get('/messages/:conversationId', async (req, res) => {
    try {
      const { conversationId } = req.params;
      const collection = db.collection("messages");
      const messages = await collection
        .find({ conversationId })
        .sort({ timestamp: -1 })
        .limit(50)
        .toArray();
      res.status(200).json(messages);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch messages", details: error.message });
    }
  });

  io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join', (userId) => {
      socket.join(userId);
      db.collection("users").updateOne({ _id: userId }, { $set: { status: 'online', socketId: socket.id } });
      console.log(`User ${userId} joined with socket ${socket.id}`);
    });

    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.id);
      db.collection("users").updateOne({ socketId: socket.id }, { $set: { status: 'offline', socketId: null } });
    });
  });

  server.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
  });

  process.on('SIGINT', async () => {
    console.log("Shutting down server...");
    await client.close();
    console.log("MongoDB connection closed.");
    process.exit(0);
  });
}

startServer();