require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static('public'));

// Хранилища
const users = [];
const messages = [];        // { id, fromUserId, toUserId (null = общий чат), text, timestamp, edited: false }
const friendships = [];     // { userId, friendId }
const friendRequests = [];  // { id, fromUserId, toUserId, status }
const typingUsers = new Map(); // socket.id -> { userId, toUserId? }

let onlineUsers = new Map(); // socket.id -> userId

function getUserById(id) {
    return users.find(u => u.id === id);
}

// API
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Заполните поля' });
    if (users.find(u => u.username === username)) return res.status(400).json({ error: 'Уже есть' });
    const hashed = await bcrypt.hash(password, 10);
    const newUser = { id: users.length + 1, username, passwordHash: hashed };
    users.push(newUser);
    const token = jwt.sign({ id: newUser.id, username: newUser.username }, process.env.JWT_SECRET);
    res.json({ token, username: newUser.username, id: newUser.id });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);
    if (!user) return res.status(400).json({ error: 'Нет пользователя' });
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(400).json({ error: 'Неверный пароль' });
    const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET);
    res.json({ token, username: user.username, id: user.id });
});

app.get('/users/search', (req, res) => {
    const { q } = req.query;
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json([]);
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const currentUserId = decoded.id;
        const lowerQ = q.toLowerCase();
        const results = users.filter(u =>
            u.id !== currentUserId &&
            u.username.toLowerCase().includes(lowerQ) &&
            !friendships.some(f => (f.userId === currentUserId && f.friendId === u.id) || (f.userId === u.id && f.friendId === currentUserId))
        ).map(u => ({ id: u.id, username: u.username }));
        res.json(results);
    } catch(e) { res.status(401).json([]); }
});

app.post('/friends/request', (req, res) => {
    const { toUserId } = req.body;
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Нет токена' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const fromUserId = decoded.id;
        if (fromUserId === toUserId) return res.status(400).json({ error: 'Нельзя себя' });
        if (friendRequests.some(r => (r.fromUserId === fromUserId && r.toUserId === toUserId) || (r.fromUserId === toUserId && r.toUserId === fromUserId)))
            return res.status(400).json({ error: 'Заявка уже есть' });
        if (friendships.some(f => (f.userId === fromUserId && f.friendId === toUserId)))
            return res.status(400).json({ error: 'Уже друзья' });
        const newRequest = { id: friendRequests.length + 1, fromUserId, toUserId, status: 'pending' };
        friendRequests.push(newRequest);
        const targetSocketId = [...onlineUsers.entries()].find(([_, uid]) => uid === toUserId)?.[0];
        if (targetSocketId) {
            io.to(targetSocketId).emit('friendRequestReceived', { fromUser: getUserById(fromUserId) });
        }
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Ошибка' }); }
});

app.post('/friends/accept', (req, res) => {
    const { requestId } = req.body;
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Нет токена' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const currentUserId = decoded.id;
        const request = friendRequests.find(r => r.id === requestId && r.toUserId === currentUserId && r.status === 'pending');
        if (!request) return res.status(404).json({ error: 'Не найдено' });
        request.status = 'accepted';
        friendships.push({ userId: request.fromUserId, friendId: request.toUserId });
        friendships.push({ userId: request.toUserId, friendId: request.fromUserId });
        const fromSocketId = [...onlineUsers.entries()].find(([_, uid]) => uid === request.fromUserId)?.[0];
        if (fromSocketId) {
            io.to(fromSocketId).emit('friendRequestAccepted', { friend: getUserById(currentUserId) });
        }
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Ошибка' }); }
});

app.post('/friends/decline', (req, res) => {
    const { requestId } = req.body;
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Нет токена' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const currentUserId = decoded.id;
        const request = friendRequests.find(r => r.id === requestId && r.toUserId === currentUserId && r.status === 'pending');
        if (!request) return res.status(404).json({ error: 'Не найдено' });
        request.status = 'declined';
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Ошибка' }); }
});

app.get('/friends/list', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Нет токена' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.id;
        const friendIds = friendships.filter(f => f.userId === userId).map(f => f.friendId);
        const friends = friendIds.map(id => getUserById(id)).filter(Boolean);
        const incomingRequests = friendRequests.filter(r => r.toUserId === userId && r.status === 'pending').map(r => ({ id: r.id, fromUser: getUserById(r.fromUserId) }));
        res.json({ friends, incomingRequests });
    } catch(e) { res.status(401).json({ error: 'Ошибка' }); }
});

// Socket.IO
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

    // Отправляем историю ОБЩЕГО чата (toUserId === null)
    const publicMessages = messages.filter(m => m.toUserId === null);
    socket.emit('messageHistory', publicMessages);

    // Список друзей и заявок
    const friendIds = friendships.filter(f => f.userId === userId).map(f => f.friendId);
    const friends = friendIds.map(id => getUserById(id)).filter(Boolean);
    const incoming = friendRequests.filter(r => r.toUserId === userId && r.status === 'pending').map(r => ({ id: r.id, fromUser: getUserById(r.fromUserId) }));
    socket.emit('friendsList', { friends, incomingRequests: incoming });

    broadcastOnlineUsers();

    // Отправка сообщения (общий чат или личное)
    socket.on('sendMessage', ({ text, toUserId = null }) => {
        if (!text || !text.trim()) return;
        const newMsg = {
            id: messages.length + 1,
            fromUserId: userId,
            toUserId: toUserId,
            username: username,
            text: text.trim(),
            timestamp: Date.now(),
            edited: false
        };
        messages.push(newMsg);
        if (toUserId === null) {
            // общий чат
            io.emit('newMessage', newMsg);
        } else {
            // личное сообщение: отправляем только получателю и отправителю
            const targetSocketId = [...onlineUsers.entries()].find(([_, uid]) => uid === toUserId)?.[0];
            if (targetSocketId) {
                io.to(targetSocketId).emit('newPrivateMessage', newMsg);
            }
            socket.emit('newPrivateMessage', newMsg);
        }
    });

    // Редактирование сообщения
    socket.on('editMessage', ({ messageId, newText }) => {
        const msg = messages.find(m => m.id === messageId && m.fromUserId === userId);
        if (msg && newText.trim()) {
            msg.text = newText.trim();
            msg.edited = true;
            if (msg.toUserId === null) {
                io.emit('messageEdited', { id: messageId, newText: msg.text, edited: true });
            } else {
                const targetSocketId = [...onlineUsers.entries()].find(([_, uid]) => uid === msg.toUserId)?.[0];
                if (targetSocketId) io.to(targetSocketId).emit('messageEdited', { id: messageId, newText: msg.text, edited: true });
                socket.emit('messageEdited', { id: messageId, newText: msg.text, edited: true });
            }
        }
    });

    // Удаление сообщения
    socket.on('deleteMessage', ({ messageId }) => {
        const index = messages.findIndex(m => m.id === messageId && m.fromUserId === userId);
        if (index !== -1) {
            const msg = messages[index];
            messages.splice(index, 1);
            if (msg.toUserId === null) {
                io.emit('messageDeleted', messageId);
            } else {
                const targetSocketId = [...onlineUsers.entries()].find(([_, uid]) => uid === msg.toUserId)?.[0];
                if (targetSocketId) io.to(targetSocketId).emit('messageDeleted', messageId);
                socket.emit('messageDeleted', messageId);
            }
        }
    });

    // Печатает...
    socket.on('typing', ({ toUserId, isTyping }) => {
        if (toUserId) {
            const targetSocketId = [...onlineUsers.entries()].find(([_, uid]) => uid === toUserId)?.[0];
            if (targetSocketId) {
                io.to(targetSocketId).emit('userTyping', { userId, username, isTyping });
            }
        } else {
            // общий чат
            socket.broadcast.emit('userTyping', { userId, username, isTyping });
        }
    });

    socket.on('disconnect', () => {
        onlineUsers.delete(socket.id);
        broadcastOnlineUsers();
    });
});

function broadcastOnlineUsers() {
    const onlineList = Array.from(onlineUsers.values()).map(uid => getUserById(uid)).filter(Boolean);
    io.emit('onlineUsers', onlineList);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Сервер на http://localhost:${PORT}`));
