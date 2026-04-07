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
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'database.json');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Инициализация базы данных
async function initDatabase() {
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
    const data = await fs.readFile(DB_PATH, 'utf-8');
    return JSON.parse(data);
}

async function writeDB(data) {
    await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2));
}

// Настройка почты
let transporter;
if (process.env.SMTP_HOST) {
    transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    });
} else {
    (async () => {
        const testAccount = await nodemailer.createTestAccount();
        transporter = nodemailer.createTransport({
            host: 'smtp.ethereal.email',
            port: 587,
            secure: false,
            auth: {
                user: testAccount.user,
                pass: testAccount.pass
            }
        });
        console.log('📧 Тестовый email:', testAccount.user);
    })();
}

async function sendVerificationEmail(email, code) {
    const mailOptions = {
        from: '"Swolts" <noreply@swolts.com>',
        to: email,
        subject: 'Код подтверждения Swolts',
        html: `<h1>Swolts</h1><p>Ваш код: <strong>${code}</strong></p>`
    };
    return transporter.sendMail(mailOptions);
}

function generateVerificationCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Роуты авторизации
app.post('/register/step1', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        if (!username || !email || !password) {
            return res.status(400).json({ error: 'Все поля обязательны' });
        }

        const db = await readDB();
        const existing = db.users.find(u => u.username === username || u.email === email);
        if (existing) {
            return res.status(400).json({ error: 'Пользователь уже существует' });
        }

        db.verificationCodes = db.verificationCodes.filter(c => c.email !== email);
        const code = generateVerificationCode();
        const passwordHash = await bcrypt.hash(password, 10);

        db.verificationCodes.push({
            email,
            code,
            expiresAt: Date.now() + 10 * 60 * 1000,
            username,
            passwordHash
        });

        await writeDB(db);
        await sendVerificationEmail(email, code);

        res.json({ success: true, message: 'Код отправлен' });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/register/verify', async (req, res) => {
    try {
        const { email, code } = req.body;
        const db = await readDB();
        const verification = db.verificationCodes.find(v => v.email === email && v.code === code);

        if (!verification) {
            return res.status(400).json({ error: 'Неверный код' });
        }
        if (verification.expiresAt < Date.now()) {
            return res.status(400).json({ error: 'Код истёк' });
        }

        const newUser = {
            id: crypto.randomUUID(),
            username: verification.username,
            email: verification.email,
            passwordHash: verification.passwordHash,
            createdAt: new Date().toISOString()
        };

        db.users.push(newUser);
        db.verificationCodes = db.verificationCodes.filter(v => v.email !== email);
        await writeDB(db);

        const token = jwt.sign(
            { id: newUser.id, username: newUser.username },
            process.env.JWT_SECRET || 'secret',
            { expiresIn: '7d' }
        );

        res.json({ success: true, token, user: { id: newUser.id, username: newUser.username } });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const db = await readDB();
        const user = db.users.find(u => u.username === username || u.email === username);

        if (!user || !await bcrypt.compare(password, user.passwordHash)) {
            return res.status(401).json({ error: 'Неверный логин или пароль' });
        }

        const token = jwt.sign(
            { id: user.id, username: user.username },
            process.env.JWT_SECRET || 'secret',
            { expiresIn: '7d' }
        );

        res.json({ success: true, token, user: { id: user.id, username: user.username } });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Socket.IO — ЧАТ
const onlineUsers = new Map();

io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Требуется авторизация'));
    
    try {
        const user = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        socket.user = user;
        next();
    } catch {
        next(new Error('Неверный токен'));
    }
});

io.on('connection', async (socket) => {
    const user = socket.user;
    onlineUsers.set(socket.id, user);
    
    console.log(`✅ ${user.username} подключился`);
    io.emit('onlineUsers', Array.from(onlineUsers.values()).map(u => u.username));

    // Отправляем историю сообщений
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

        const db = await readDB();
        db.messages.push(message);
        if (db.messages.length > 100) db.messages = db.messages.slice(-100);
        await writeDB(db);

        io.emit('newMessage', message);
    });

    socket.on('disconnect', () => {
        onlineUsers.delete(socket.id);
        console.log(`❌ ${user.username} отключился`);
        io.emit('onlineUsers', Array.from(onlineUsers.values()).map(u => u.username));
    });
});

// Запуск сервера
initDatabase().then(() => {
    server.listen(PORT, () => {
        console.log(`🚀 Сервер Swolts запущен на порту ${PORT}`);
    });
});
