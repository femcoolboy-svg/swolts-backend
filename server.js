require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'database.json');
const JWT_SECRET = process.env.JWT_SECRET || 'swolts-super-secret-key-2024';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// База данных
async function initDB() {
    try {
        await fs.access(DB_PATH);
    } catch {
        await fs.writeFile(DB_PATH, JSON.stringify({
            users: [],
            verificationCodes: [],
            messages: []
        }, null, 2));
    }
}

async function readDB() {
    return JSON.parse(await fs.readFile(DB_PATH, 'utf-8'));
}

async function writeDB(data) {
    await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2));
}

// Почта (Ethereal для теста)
let transporter;
(async () => {
    const testAccount = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: { user: testAccount.user, pass: testAccount.pass }
    });
    console.log('📧 Тестовый email:', testAccount.user);
    console.log('🔗 Просмотр писем: https://ethereal.email/login');
    console.log('   Логин:', testAccount.user);
    console.log('   Пароль:', testAccount.pass);
})();

async function sendVerificationEmail(email, code) {
    return transporter.sendMail({
        from: '"Swolts" <noreply@swolts.com>',
        to: email,
        subject: 'Код подтверждения Swolts',
        html: `<h1>🐻 Swolts</h1><p>Ваш код: <strong>${code}</strong></p><p>Код действителен 10 минут.</p>`
    });
}

// Генерация кода
function generateCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Очистка старых кодов
setInterval(async () => {
    const db = await readDB();
    const now = Date.now();
    db.verificationCodes = db.verificationCodes.filter(c => c.expiresAt > now);
    await writeDB(db);
}, 5 * 60 * 1000);

// ========== РОУТЫ АВТОРИЗАЦИИ ==========

// Регистрация шаг 1
app.post('/register/step1', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        if (!username || !email || !password) {
            return res.status(400).json({ error: 'Все поля обязательны' });
        }
        if (username.length < 3) {
            return res.status(400).json({ error: 'Никнейм минимум 3 символа' });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Некорректный email' });
        }
        if (password.length < 4) {
            return res.status(400).json({ error: 'Пароль минимум 4 символа' });
        }

        const db = await readDB();
        if (db.users.find(u => u.username === username || u.email === email)) {
            return res.status(400).json({ error: 'Пользователь уже существует' });
        }

        db.verificationCodes = db.verificationCodes.filter(c => c.email !== email);
        const code = generateCode();
        
        db.verificationCodes.push({
            email,
            code,
            expiresAt: Date.now() + 10 * 60 * 1000,
            username,
            passwordHash: await bcrypt.hash(password, 10)
        });

        await writeDB(db);
        await sendVerificationEmail(email, code);

        res.json({ success: true, message: 'Код отправлен' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Подтверждение кода
app.post('/register/verify', async (req, res) => {
    try {
        const { email, code } = req.body;
        const db = await readDB();
        const v = db.verificationCodes.find(c => c.email === email && c.code === code);

        if (!v) return res.status(400).json({ error: 'Неверный код' });
        if (v.expiresAt < Date.now()) return res.status(400).json({ error: 'Код истёк' });

        const newUser = {
            id: crypto.randomUUID(),
            username: v.username,
            email: v.email,
            passwordHash: v.passwordHash,
            createdAt: new Date().toISOString()
        };

        db.users.push(newUser);
        db.verificationCodes = db.verificationCodes.filter(c => c.email !== email);
        await writeDB(db);

        const token = jwt.sign({ id: newUser.id, username: newUser.username }, JWT_SECRET, { expiresIn: '7d' });

        res.json({ success: true, token, user: { id: newUser.id, username: newUser.username } });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Вход
app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const db = await readDB();
        const user = db.users.find(u => u.username === username || u.email === username);

        if (!user || !await bcrypt.compare(password, user.passwordHash)) {
            return res.status(401).json({ error: 'Неверный логин или пароль' });
        }

        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });

        res.json({ success: true, token, user: { id: user.id, username: user.username } });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Повторная отправка кода
app.post('/register/resend-code', async (req, res) => {
    try {
        const { email } = req.body;
        const db = await readDB();
        const v = db.verificationCodes.find(c => c.email === email);
        if (!v) return res.status(400).json({ error: 'Регистрация не найдена' });

        v.code = generateCode();
        v.expiresAt = Date.now() + 10 * 60 * 1000;
        await writeDB(db);
        await sendVerificationEmail(email, v.code);

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ========== SOCKET.IO ЧАТ ==========
const onlineUsers = new Map();

io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Требуется авторизация'));
    try {
        socket.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        next(new Error('Неверный токен'));
    }
});

io.on('connection', async (socket) => {
    const user = socket.user;
    onlineUsers.set(socket.id, user);
    
    console.log(`✅ ${user.username} в чате`);
    io.emit('onlineUsers', [...new Set([...onlineUsers.values()].map(u => u.username))]);

    const db = await readDB();
    socket.emit('messageHistory', db.messages.slice(-50));

    socket.on('sendMessage', async (text) => {
        if (!text || text.length > 500) return;
        
        const message = {
            id: crypto.randomUUID(),
            userId: user.id,
            username: user.username,
            text: text.trim(),
            timestamp: new Date().toISOString()
        };

        db.messages.push(message);
        if (db.messages.length > 200) db.messages = db.messages.slice(-200);
        await writeDB(db);

        io.emit('newMessage', message);
    });

    socket.on('disconnect', () => {
        onlineUsers.delete(socket.id);
        io.emit('onlineUsers', [...new Set([...onlineUsers.values()].map(u => u.username))]);
    });
});

// Запуск
initDB().then(() => {
    server.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
});
