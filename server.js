require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // HTML будет лежать в папке public

// ---- Хранилище пользователей и сообщений (в памяти, для демо) ----
const users = new Map();     // username -> { id, passwordHash }
const messages = [];        // { id, userId, username, text, timestamp }
let nextUserId = 1;

// Секретный ключ (в реальном проекте храните в .env)
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey_32_chars_minimum';

// ---- Вспомогательные функции ----
function generateToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
}

// ---- API эндпоинты ----
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || username.length < 3) return res.status(400).json({ message: 'Логин минимум 3 символа' });
  if (!password || password.length < 4) return res.status(400).json({ message: 'Пароль минимум 4 символа' });
  if (users.has(username)) return res.status(400).json({ message: 'Пользователь уже существует' });

  const hashedPassword = await bcrypt.hash(password, 10);
  const newUser = { id: nextUserId++, username, passwordHash: hashedPassword };
  users.set(username, newUser);

  const token = generateToken(newUser);
  res.json({ token, userId: newUser.id, username: newUser.username });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = users.get(username);
  if (!user) return res.status(401).json({ message: 'Неверный логин или пароль' });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ message: 'Неверный логин или пароль' });

  const token = generateToken(user);
  res.json({ token, userId: user.id, username: user.username });
});

// ---- Socket.IO с авторизацией через токен из handshake (куки) ----
io.use((socket, next) => {
  const token = socket.handshake.auth.token; // токен передаётся из клиента
  if (!token) return next(new Error('Authentication error'));

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.user = { id: decoded.id, username: decoded.username };
    next();
  } catch (err) {
    next(new Error('Authentication error'));
  }
});

// ---- Логика чата ----
const onlineUsers = new Map(); // socket.id -> { userId, username }

io.on('connection', (socket) => {
  const { id, username } = socket.user;
  onlineUsers.set(socket.id, { userId: id, username });
  io.emit('onlineUsers', Array.from(onlineUsers.values()).map(u => u.username));
  io.emit('user_joined', { username, userId: id });

  // Отправляем историю новому пользователю
  socket.emit('messageHistory', messages);

  // Обработка сообщений
  socket.on('sendMessage', (text) => {
    if (!text || text.trim() === '') return;
    const newMsg = {
      id: messages.length + 1,
      userId: id,
      username,
      text: text.slice(0, 500),
      timestamp: Date.now()
    };
    messages.push(newMsg);
    io.emit('newMessage', newMsg);
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    io.emit('onlineUsers', Array.from(onlineUsers.values()).map(u => u.username));
    io.emit('user_left', { username, userId: id });
  });
});

// ---- Отдача HTML (файл index.html должен лежать в папке /public) ----
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Сервер запущен на http://localhost:${PORT}`);
});
