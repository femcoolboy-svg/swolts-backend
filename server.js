require('dotenv').config();
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Путь к "базе данных"
const DB_PATH = path.join(__dirname, 'database.json');

// Middleware
app.use(cors({
    origin: ['http://localhost:3000', 'http://127.0.0.1:5500', 'http://localhost:5500', 'null'],
    credentials: true
}));
app.use(express.json());
app.use(express.static('public'));

// Инициализация базы данных
async function initDatabase() {
    try {
        await fs.access(DB_PATH);
    } catch {
        await fs.writeFile(DB_PATH, JSON.stringify({
            users: [],
            verificationCodes: []
        }, null, 2));
    }
}

// Чтение базы
async function readDB() {
    const data = await fs.readFile(DB_PATH, 'utf-8');
    return JSON.parse(data);
}

// Запись в базу
async function writeDB(data) {
    await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2));
}

// Настройка почты (Ethereal для теста, или SMTP из .env)
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
    // Тестовый аккаунт Ethereal (создаётся автоматически)
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
        console.log('📧 Ethereal email:', testAccount.user);
        console.log('🔗 Просмотр писем: https://ethereal.email/login');
    })();
}

// Отправка письма с кодом
async function sendVerificationEmail(email, code) {
    const mailOptions = {
        from: `"Swolts" <${process.env.SMTP_FROM || 'noreply@swolts.com'}>`,
        to: email,
        subject: 'Подтверждение регистрации Swolts',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h1 style="color: #7c83ff;">🐻 Swolts</h1>
                <h2>Подтверждение email</h2>
                <p>Ваш код подтверждения:</p>
                <div style="background: #f0f0f0; padding: 20px; text-align: center; border-radius: 10px;">
                    <span style="font-size: 32px; font-weight: bold; letter-spacing: 10px; color: #7c83ff;">${code}</span>
                </div>
                <p>Код действителен 10 минут.</p>
            </div>
        `
    };
    return transporter.sendMail(mailOptions);
}

// Генерация 6-значного кода
function generateVerificationCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Очистка просроченных кодов
async function cleanupExpiredCodes() {
    const db = await readDB();
    const now = Date.now();
    db.verificationCodes = db.verificationCodes.filter(c => c.expiresAt > now);
    await writeDB(db);
}

// Регистрация: шаг 1 — отправка кода
app.post('/register/step1', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        if (!username || !email || !password) {
            return res.status(400).json({ error: 'Все поля обязательны' });
        }
        if (username.length < 3) {
            return res.status(400).json({ error: 'Никнейм минимум 3 символа' });
        }
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Некорректный email' });
        }
        if (password.length < 4) {
            return res.status(400).json({ error: 'Пароль минимум 4 символа' });
        }

        const db = await readDB();
        const existing = db.users.find(u => u.username === username || u.email === email);
        if (existing) {
            return res.status(400).json({ error: 'Пользователь с таким именем или email уже существует' });
        }

        // Удаляем старые коды для этого email
        db.verificationCodes = db.verificationCodes.filter(c => c.email !== email);

        const code = generateVerificationCode();
        const expiresAt = Date.now() + 10 * 60 * 1000; // 10 минут
        const passwordHash = await bcrypt.hash(password, 10);

        db.verificationCodes.push({
            email,
            code,
            expiresAt,
            username,
            passwordHash
        });

        await writeDB(db);
        await sendVerificationEmail(email, code);

        res.json({ success: true, message: 'Код отправлен на email' });
    } catch (error) {
        console.error('Ошибка регистрации (шаг 1):', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Подтверждение кода и создание аккаунта
app.post('/register/verify', async (req, res) => {
    try {
        const { email, code } = req.body;
        if (!email || !code) {
            return res.status(400).json({ error: 'Email и код обязательны' });
        }

        const db = await readDB();
        const verification = db.verificationCodes.find(v => v.email === email && v.code === code);
        if (!verification) {
            return res.status(400).json({ error: 'Неверный код' });
        }
        if (verification.expiresAt < Date.now()) {
            db.verificationCodes = db.verificationCodes.filter(v => v.email !== email);
            await writeDB(db);
            return res.status(400).json({ error: 'Код истёк' });
        }

        const newUser = {
            id: crypto.randomUUID(),
            username: verification.username,
            email: verification.email,
            passwordHash: verification.passwordHash,
            createdAt: new Date().toISOString(),
            emailVerified: true
        };

        db.users.push(newUser);
        db.verificationCodes = db.verificationCodes.filter(v => v.email !== email);
        await writeDB(db);

        const token = jwt.sign(
            { id: newUser.id, username: newUser.username, email: newUser.email },
            process.env.JWT_SECRET || 'jwt-secret-key',
            { expiresIn: '7d' }
        );

        res.json({
            success: true,
            message: 'Аккаунт создан',
            token,
            user: { id: newUser.id, username: newUser.username, email: newUser.email }
        });
    } catch (error) {
        console.error('Ошибка подтверждения:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Вход
app.post('/login', async (req, res) => {
    try {
        const { username, password, remember } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Логин и пароль обязательны' });
        }

        const db = await readDB();
        const user = db.users.find(u => u.username === username || u.email === username);
        if (!user) {
            return res.status(401).json({ error: 'Неверный логин или пароль' });
        }

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) {
            return res.status(401).json({ error: 'Неверный логин или пароль' });
        }

        const expiresIn = remember ? '30d' : '7d';
        const token = jwt.sign(
            { id: user.id, username: user.username, email: user.email },
            process.env.JWT_SECRET || 'jwt-secret-key',
            { expiresIn }
        );

        res.json({
            success: true,
            message: 'Вход выполнен',
            token,
            user: { id: user.id, username: user.username, email: user.email }
        });
    } catch (error) {
        console.error('Ошибка входа:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Повторная отправка кода
app.post('/register/resend-code', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ error: 'Email обязателен' });
        }

        const db = await readDB();
        const verification = db.verificationCodes.find(v => v.email === email);
        if (!verification) {
            return res.status(400).json({ error: 'Регистрация не найдена. Начните заново.' });
        }

        const newCode = generateVerificationCode();
        verification.code = newCode;
        verification.expiresAt = Date.now() + 10 * 60 * 1000;

        await writeDB(db);
        await sendVerificationEmail(email, newCode);

        res.json({ success: true, message: 'Новый код отправлен' });
    } catch (error) {
        console.error('Ошибка повторной отправки:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Запуск сервера
initDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Сервер Swolts запущен на порту ${PORT}`);
        // Очистка старых кодов каждые 5 минут
        setInterval(cleanupExpiredCodes, 5 * 60 * 1000);
    });
});
