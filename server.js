const { MongoClient, ObjectId } = require('mongodb');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const cors = require('cors');

// Initialize Firebase Admin SDK
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_KEY
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
  : require('./serviceAccountKey.json'); // Fallback for local testing
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const dbFirestore = admin.firestore();

// MongoDB connection
const uri = "mongodb+srv://amalkarthik_ADMIN:Amal1122Karthik@cluster0.w7y8k.mongodb.net/myDatabase?retryWrites=true&w=majority";
const client = new MongoClient(uri, {
  connectTimeoutMS: 5000,
  serverSelectionTimeoutMS: 5000,
  tls: true,
});

const app = express();
const port = process.env.PORT || 3000;
let db;

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

async function connectToDatabase() {
  try {
    await client.connect();
    console.log("Connected to MongoDB Atlas!");
    db = client.db("myDatabase");
    console.log("Database 'myDatabase' is ready for use.");
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error.message);
    console.log("Retrying in 5 seconds...");
    await new Promise(resolve => setTimeout(resolve, 5000));
    await connectToDatabase();
  }
}

async function startServer() {
  await connectToDatabase();
  app.use(express.json());
  app.use(cors({ origin: "*" })); // Add CORS support
  app.use(express.static('public'));

  app.get('/', (req, res) => {
    res.send("Chat server is running and connected to MongoDB Atlas!");
  });

  app.get('/ping', async (req, res) => {
    try {
      await db.command({ ping: 1 });
      res.status(200).json({ message: "Ping successful!" });
    } catch (error) {
      console.error("Ping failed:", error.message);
      res.status(500).json({ error: "Failed to ping MongoDB" });
    }
  });

  app.get('/conversations/:userId', async (req, res) => {
    try {
      const { userId } = req.params;
      console.log(`Fetching conversations for user: ${userId}`); // Debug log
      const conversations = await db.collection('conversations')
        .find({ participants: userId })
        .sort({ 'lastMessage.timestamp': -1 })
        .toArray();

      const populatedConversations = await Promise.all(conversations.map(async (conv) => {
        const otherParticipantId = conv.participants.find(id => id !== userId);
        let participant;
        try {
          const userDoc = await dbFirestore.collection('users').doc(otherParticipantId).get();
          participant = userDoc.exists ? userDoc.data() : null;
        } catch (error) {
          console.error(`Error fetching user ${otherParticipantId} from Firestore:`, error.message);
          participant = null;
        }
        return {
          id: conv._id.toString(),
          name: participant ? `${participant.fname} ${participant.lname || ''}`.trim() : "Unknown",
          avatar: participant?.propic || 'https://randomuser.me/api/portraits/men/1.jpg',
          lastMessage: conv.lastMessage?.content || '',
          time: conv.lastMessage?.timestamp || conv.createdAt,
          unread: await db.collection('messages').countDocuments({
            conversationId: ObjectId(conv._id),
            senderId: { $ne: userId },
            isRead: false
          }),
        };
      }));

      res.status(200).json(populatedConversations);
    } catch (error) {
      console.error("Error fetching conversations:", error.message);
      res.status(500).json({ error: "Failed to fetch conversations" });
    }
  });

  app.post('/messages', async (req, res) => {
    try {
      const { conversationId, senderId, content } = req.body;
      if (!conversationId || !senderId || !content) {
        return res.status(400).json({ error: "conversationId, senderId, and content are required" });
      }

      const newMessage = {
        conversationId: ObjectId(conversationId),
        senderId,
        content,
        timestamp: new Date(),
        isRead: false,
      };

      const messagesCollection = db.collection('messages');
      const result = await messagesCollection.insertOne(newMessage);

      await db.collection('conversations').updateOne(
        { _id: ObjectId(conversationId) },
        {
          $set: {
            lastMessage: {
              content,
              senderId,
              timestamp: newMessage.timestamp,
            },
            updatedAt: new Date(),
          },
        }
      );

      const conversation = await db.collection('conversations').findOne({ _id: ObjectId(conversationId) });
      conversation.participants.forEach(participantId => {
        io.to(participantId).emit('newMessage', { ...newMessage, _id: result.insertedId });
      });

      res.status(201).json({ message: "Message sent", id: result.insertedId });
    } catch (error) {
      console.error("Error sending message:", error.message);
      res.status(500).json({ error: "Failed to send message" });
    }
  });

  app.get('/messages/:conversationId', async (req, res) => {
    try {
      const { conversationId } = req.params;
      const messages = await db.collection('messages')
        .find({ conversationId: ObjectId(conversationId) })
        .sort({ timestamp: 1 })
        .toArray();

      const populatedMessages = await Promise.all(messages.map(async (msg) => {
        let sender;
        try {
          const userDoc = await dbFirestore.collection('users').doc(msg.senderId).get();
          sender = userDoc.exists ? userDoc.data() : null;
        } catch (error) {
          console.error(`Error fetching user ${msg.senderId} from Firestore:`, error.message);
          sender = null;
        }
        return {
          ...msg,
          _id: msg._id.toString(),
          avatar: sender?.propic || 'https://randomuser.me/api/portraits/men/1.jpg',
        };
      }));

      res.status(200).json(populatedMessages);
    } catch (error) {
      console.error("Error fetching messages:", error.message);
      res.status(500).json({ error: "Failed to fetch messages" });
    }
  });

  // Catch-all route for debugging 404 errors
  app.use((req, res) => {
    console.log(`404 - Route not found: ${req.method} ${req.url}`);
    res.status(404).json({ error: "Route not found" });
  });

  io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join', (userId) => {
      socket.join(userId);
      console.log(`User ${userId} joined with socket ${socket.id}`);
    });

    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.id);
    });
  });

  server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });

  process.on('SIGINT', async () => {
    console.log("Shutting down server...");
    await client.close();
    console.log("MongoDB connection closed.");
    process.exit(0);
  });
}

startServer();
