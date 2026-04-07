require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = process.env.JWT_SECRET || 'swolts_supersecret_32chars_minimum';

// Хранилища
const users = new Map();        // username -> { id, passwordHash, username, online: bool, socketId? }
const friendships = new Map();  // userId -> Set of friendIds
const messages = new Map();     // key "userId1:userId2" -> array of messages { from, to, text, timestamp, id }
let nextUserId = 1;
let nextMsgId = 1;

// Вспомогательные
function getUserByUsername(username) { return users.get(username); }
function getUserById(id) {
    for (let u of users.values()) if (u.id === id) return u;
    return null;
}
function generateToken(user) {
    return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
}
function getFriendKey(userA, userB) {
    const [small, large] = [userA, userB].sort((a,b)=>a-b);
    return `${small}:${large}`;
}

// API
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || username.length < 3) return res.status(400).json({ message: 'Логин минимум 3 символа' });
    if (!password || password.length < 4) return res.status(400).json({ message: 'Пароль минимум 4 символа' });
    if (users.has(username)) return res.status(400).json({ message: 'Пользователь уже существует' });

    const hashed = await bcrypt.hash(password, 10);
    const newUser = { id: nextUserId++, username, passwordHash: hashed, online: false };
    users.set(username, newUser);
    friendships.set(newUser.id, new Set());

    const token = generateToken(newUser);
    res.json({ token, userId: newUser.id, username: newUser.username });
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = users.get(username);
    if (!user) return res.status(401).json({ message: 'Неверный логин или пароль' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ message: 'Неверный логин или пароль' });

    const token = generateToken(user);
    res.json({ token, userId: user.id, username: user.username });
});

// Поиск пользователей по нику (для добавления в друзья)
app.get('/api/search-users', (req, res) => {
    const { q, currentUserId } = req.query;
    if (!q || q.length < 2) return res.json([]);
    const results = [];
    for (let user of users.values()) {
        if (user.id == currentUserId) continue;
        if (user.username.toLowerCase().includes(q.toLowerCase())) {
            results.push({ id: user.id, username: user.username });
        }
        if (results.length >= 10) break;
    }
    res.json(results);
});

// Получить список друзей (с их online статусом)
app.get('/api/friends', (req, res) => {
    const userId = parseInt(req.query.userId);
    const friendSet = friendships.get(userId) || new Set();
    const friendsList = [];
    for (let fid of friendSet) {
        const friend = getUserById(fid);
        if (friend) friendsList.push({ id: friend.id, username: friend.username, online: friend.online });
    }
    res.json(friendsList);
});

// Получить историю сообщений с другом
app.get('/api/messages/:friendId', (req, res) => {
    const myId = parseInt(req.query.myId);
    const friendId = parseInt(req.params.friendId);
    const key = getFriendKey(myId, friendId);
    const msgs = messages.get(key) || [];
    res.json(msgs);
});

// Socket.IO с авторизацией
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication error'));
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        socket.user = { id: decoded.id, username: decoded.username };
        next();
    } catch (err) { next(new Error('Authentication error')); }
});

io.on('connection', (socket) => {
    const userId = socket.user.id;
    const user = getUserById(userId);
    if (user) {
        user.online = true;
        user.socketId = socket.id;
    }

    // Отправить список друзей и их статусы
    function broadcastFriendStatus() {
        const friendSet = friendships.get(userId) || new Set();
        for (let friendId of friendSet) {
            const friendSocket = getUserById(friendId)?.socketId;
            if (friendSocket) {
                io.to(friendSocket).emit('friend_status', { userId, online: true });
            }
        }
    }
    broadcastFriendStatus();

    // Принять запрос на добавление друга
    socket.on('add_friend', async ({ targetUsername }) => {
        const target = getUserByUsername(targetUsername);
        if (!target) return socket.emit('friend_error', 'Пользователь не найден');
        if (target.id === userId) return socket.emit('friend_error', 'Нельзя добавить себя');
        const myFriends = friendships.get(userId) || new Set();
        if (myFriends.has(target.id)) return socket.emit('friend_error', 'Уже в друзьях');
        myFriends.add(target.id);
        friendships.set(userId, myFriends);
        // Добавить в друзья у target
        const targetFriends = friendships.get(target.id) || new Set();
        targetFriends.add(userId);
        friendships.set(target.id, targetFriends);
        // Уведомить обе стороны
        const newFriendData = { id: target.id, username: target.username, online: target.online };
        socket.emit('friend_added', newFriendData);
        if (target.socketId) {
            io.to(target.socketId).emit('friend_added', { id: userId, username: user.username, online: true });
        }
    });

    // Отправка личного сообщения
    socket.on('private_message', ({ toUserId, text }) => {
        if (!text || text.trim() === '') return;
        const fromUser = user;
        const toUser = getUserById(toUserId);
        if (!toUser) return;
        // Проверить, что они друзья
        const myFriends = friendships.get(userId) || new Set();
        if (!myFriends.has(toUserId)) return socket.emit('error', 'Нельзя писать не другу');

        const msg = {
            id: nextMsgId++,
            from: userId,
            to: toUserId,
            text: text.slice(0, 500),
            timestamp: Date.now(),
        };
        const key = getFriendKey(userId, toUserId);
        if (!messages.has(key)) messages.set(key, []);
        messages.get(key).push(msg);
        // Отправить получателю, если онлайн
        if (toUser.socketId) {
            io.to(toUser.socketId).emit('new_private_message', msg);
        }
        // Отправить отправителю
        socket.emit('new_private_message', msg);
    });

    socket.on('disconnect', () => {
        if (user) {
            user.online = false;
            user.socketId = null;
            // Уведомить друзей
            const friendSet = friendships.get(userId) || new Set();
            for (let friendId of friendSet) {
                const friendSocket = getUserById(friendId)?.socketId;
                if (friendSocket) {
                    io.to(friendSocket).emit('friend_status', { userId, online: false });
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🔥 Мессенджер на http://localhost:${PORT}`));
