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
app.use(express.static('public')); // Статические файлы (HTML, CSS)

// ----- Хранилище в памяти (для примера) -----
const users = [];      // { id, username, passwordHash }
const messages = [];   // { id, userId, username, text, timestamp }
let onlineUsers = new Set(); // socket.id -> userId

// Вспомогательные функции
function getUserById(id) {
  return users.find(u => u.id === id);
}

// ----- API регистрации / логина -----
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

// ----- Socket.IO с аутентификацией -----
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

  // Добавляем в онлайн
  onlineUsers.add(socket.id);
  socket.userId = userId;

  // Отправляем историю сообщений новому пользователю
  socket.emit('messageHistory', messages);

  // Рассылаем всем обновлённый список онлайн
  broadcastOnlineUsers();

  // Обработка нового сообщения
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
    // Рассылаем всем клиентам
    io.emit('newMessage', newMsg);
  });

  // Отключение
  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    broadcastOnlineUsers();
  });
});

function broadcastOnlineUsers() {
  const usersOnline = Array.from(onlineUsers).map(socketId => {
    const socket = io.sockets.sockets.get(socketId);
    return socket ? { id: socket.userId, username: socket.user.username } : null;
  }).filter(Boolean);
  io.emit('onlineUsers', usersOnline);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Сервер запущен на http://localhost:${PORT}`));
