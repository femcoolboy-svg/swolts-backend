require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*' }
});

app.use(express.json());
app.use(express.static('public'));

// ----- Хранилища -----
const users = [];        // { id, username, passwordHash }
const messages = [];     // { id, userId, username, text, timestamp }
const friendships = [];  // { userId, friendId, status: 'accepted' } (только подтверждённые)
const friendRequests = []; // { id, fromUserId, toUserId, status: 'pending'|'accepted'|'declined' }

let onlineUsers = new Map(); // socket.id -> userId

// Вспомогательные функции
function getUserById(id) {
  return users.find(u => u.id === id);
}

// ----- API -----
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });
  if (users.find(u => u.username === username)) return res.status(400).json({ error: 'Пользователь уже существует' });

  const hashed = await bcrypt.hash(password, 10);
  const newUser = { id: users.length + 1, username, passwordHash: hashed };
  users.push(newUser);

  const token = jwt.sign({ id: newUser.id, username: newUser.username }, process.env.JWT_SECRET);
  res.json({ token, username: newUser.username, id: newUser.id });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username);
  if (!user) return res.status(400).json({ error: 'Неверное имя пользователя' });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(400).json({ error: 'Неверный пароль' });

  const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET);
  res.json({ token, username: user.username, id: user.id });
});

// Поиск пользователей (не друзей и не себя)
app.get('/users/search', (req, res) => {
  const { q } = req.query;
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const currentUserId = decoded.id;
    if (!q || q.length < 1) return res.json([]);
    const lowerQ = q.toLowerCase();
    const results = users.filter(u => 
      u.id !== currentUserId && 
      u.username.toLowerCase().includes(lowerQ) &&
      !friendships.some(f => (f.userId === currentUserId && f.friendId === u.id) || (f.userId === u.id && f.friendId === currentUserId))
    ).map(u => ({ id: u.id, username: u.username }));
    res.json(results);
  } catch(e) {
    res.status(401).json({ error: 'Неверный токен' });
  }
});

// Отправить заявку в друзья
app.post('/friends/request', (req, res) => {
  const { toUserId } = req.body;
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const fromUserId = decoded.id;
    if (fromUserId === toUserId) return res.status(400).json({ error: 'Нельзя добавить себя' });
    // Проверяем, нет ли уже заявки или дружбы
    const existingRequest = friendRequests.find(r => (r.fromUserId === fromUserId && r.toUserId === toUserId) || (r.fromUserId === toUserId && r.toUserId === fromUserId));
    if (existingRequest) return res.status(400).json({ error: 'Заявка уже отправлена или вы уже друзья' });
    const isFriend = friendships.some(f => (f.userId === fromUserId && f.friendId === toUserId) || (f.userId === toUserId && f.friendId === fromUserId));
    if (isFriend) return res.status(400).json({ error: 'Вы уже друзья' });
    
    const newRequest = { id: friendRequests.length + 1, fromUserId, toUserId, status: 'pending' };
    friendRequests.push(newRequest);
    // Уведомляем получателя через сокет, если он онлайн
    const targetSocketId = [...onlineUsers.entries()].find(([_, uid]) => uid === toUserId)?.[0];
    if (targetSocketId) {
      io.to(targetSocketId).emit('friendRequestReceived', { fromUser: getUserById(fromUserId) });
    }
    res.json({ success: true });
  } catch(e) {
    res.status(401).json({ error: 'Ошибка' });
  }
});

// Принять заявку
app.post('/friends/accept', (req, res) => {
  const { requestId } = req.body;
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const currentUserId = decoded.id;
    const request = friendRequests.find(r => r.id === requestId && r.toUserId === currentUserId && r.status === 'pending');
    if (!request) return res.status(404).json({ error: 'Заявка не найдена' });
    request.status = 'accepted';
    friendships.push({ userId: request.fromUserId, friendId: request.toUserId });
    friendships.push({ userId: request.toUserId, friendId: request.fromUserId });
    // Уведомляем отправителя
    const fromSocketId = [...onlineUsers.entries()].find(([_, uid]) => uid === request.fromUserId)?.[0];
    if (fromSocketId) {
      io.to(fromSocketId).emit('friendRequestAccepted', { friend: getUserById(currentUserId) });
    }
    res.json({ success: true });
  } catch(e) {
    res.status(401).json({ error: 'Ошибка' });
  }
});

// Отклонить заявку
app.post('/friends/decline', (req, res) => {
  const { requestId } = req.body;
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const currentUserId = decoded.id;
    const requestIndex = friendRequests.findIndex(r => r.id === requestId && r.toUserId === currentUserId && r.status === 'pending');
    if (requestIndex === -1) return res.status(404).json({ error: 'Заявка не найдена' });
    friendRequests[requestIndex].status = 'declined';
    res.json({ success: true });
  } catch(e) {
    res.status(401).json({ error: 'Ошибка' });
  }
});

// Получить список друзей и входящие заявки
app.get('/friends/list', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.id;
    // Друзья
    const friendIds = friendships.filter(f => f.userId === userId).map(f => f.friendId);
    const friends = friendIds.map(id => getUserById(id)).filter(Boolean);
    // Входящие заявки
    const incomingRequests = friendRequests.filter(r => r.toUserId === userId && r.status === 'pending').map(r => ({
      id: r.id,
      fromUser: getUserById(r.fromUserId)
    }));
    res.json({ friends, incomingRequests });
  } catch(e) {
    res.status(401).json({ error: 'Ошибка' });
  }
});

// ----- Socket.IO -----
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Нет токена'));
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return next(new Error('Неверный токен'));
    socket.user = decoded;
    next();
  });
});

io.on('connection', (socket) => {
  const userId = socket.user.id;
  const username = socket.user.username;

  onlineUsers.set(socket.id, userId);
  socket.userId = userId;

  // Отправляем историю сообщений
  socket.emit('messageHistory', messages);

  // Отправляем список друзей и заявки сразу (через HTTP, но можно и через сокет)
  const friendIds = friendships.filter(f => f.userId === userId).map(f => f.friendId);
  const friends = friendIds.map(id => getUserById(id)).filter(Boolean);
  const incoming = friendRequests.filter(r => r.toUserId === userId && r.status === 'pending').map(r => ({ id: r.id, fromUser: getUserById(r.fromUserId) }));
  socket.emit('friendsList', { friends, incomingRequests: incoming });

  // Рассылаем онлайн-статусы (включая друзей)
  broadcastOnlineUsers();

  socket.on('sendMessage', (text) => {
    if (!text || text.trim() === '') return;
    const newMsg = {
      id: messages.length + 1,
      userId: userId,
      username: username,
      text: text.trim(),
      timestamp: Date.now()
    };
    messages.push(newMsg);
    io.emit('newMessage', newMsg);
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    broadcastOnlineUsers();
  });
});

function broadcastOnlineUsers() {
  const onlineUsersList = Array.from(onlineUsers.values()).map(uid => getUserById(uid)).filter(Boolean);
  io.emit('onlineUsers', onlineUsersList);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Сервер запущен на http://localhost:${PORT}`));
