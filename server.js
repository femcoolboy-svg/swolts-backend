require('dotenv').config();
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Путь к "базе данных" (JSON файл)
const DB_PATH = path.join(__dirname, 'database.json');

// Middleware
app.use(cors({
    origin: ['http://localhost:3000', 'http://127.0.0.1:5500', 'http://localhost:5500'],
    credentials: true
}));
app.use(express.json());
app.use(express.static('public'));
app.use(session({
    secret: process.env.SESSION_SECRET || 'swolts-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24 // 24 часа
    }
}));

// Rate limiting
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 минут
    max: 100, // максимум 100 запросов
    message: { error: 'Слишком много попыток. Попробуйте позже.' }
});

const emailLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 час
    max: 5, // максимум 5 писем в час
    message: { error: 'Превышен лимит отправки писем. Попробуйте через час.' }
});

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

// Чтение базы данных
async function readDB() {
    const data = await fs.readFile(DB_PATH, 'utf-8');
    return JSON.parse(data);
}

// Запись в базу данных
async function writeDB(data) {
    await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2));
}

// Настройка почтового транспорта (используй свои данные в .env)
const transporter = nodemailer.createTransporter ? 
    nodemailer.createTransporter({
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT,
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    }) : 
    // Для тестов используем Ethereal (фейковый SMTP)
    nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: {
            user: 'ethereal-email@ethereal.email', // Сгенерируется автоматически
            pass: 'ethereal-pass'
        }
    });

// Создание тестового аккаунта Ethereal при запуске
async function createTestAccount() {
    const testAccount = await nodemailer.createTestAccount();
    transporter.options.auth.user = testAccount.user;
    transporter.options.auth.pass = testAccount.pass;
    console.log('📧 Тестовый email создан:', testAccount.user);
    console.log('🔗 Просмотр писем: https://ethereal.email');
}

// Отправка кода верификации
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
                <p>Если вы не запрашивали регистрацию, проигнорируйте это письмо.</p>
                <hr>
                <p style="color: #999; font-size: 12px;">© 2024 Swolts. Все права защищены.</p>
            </div>
        `
    };

    const info = await transporter.sendMail(mailOptions);
    
    // Для Ethereal показываем URL просмотра письма
    if (transporter.options.host === 'smtp.ethereal.email') {
        console.log('📨 Письмо отправлено. Просмотр:', nodemailer.getTestMessageUrl(info));
    }
    
    return info;
}

// Генерация 6-значного кода
function generateVerificationCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Очистка устаревших кодов
async function cleanupExpiredCodes() {
    const db = await readDB();
    const now = Date.now();
    db.verificationCodes = db.verificationCodes.filter(c => c.expiresAt > now);
    await writeDB(db);
}

// Middleware для проверки JWT токена
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }

    jwt.verify(token, process.env.JWT_SECRET || 'jwt-secret-key', (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Недействительный токен' });
        }
        req.user = user;
        next();
    });
}

// ========== РОУТЫ ==========

// Регистрация (шаг 1 - отправка кода)
app.post('/register/step1', emailLimiter, async (req, res) => {
    try {
        const { username, email, password } = req.body;

        // Валидация
        if (!username || !email || !password) {
            return res.status(400).json({ error: 'Все поля обязательны' });
        }

        if (username.length < 3) {
            return res.status(400).json({ error: 'Имя пользователя должно быть не менее 3 символов' });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Некорректный email' });
        }

        if (password.length < 4) {
            return res.status(400).json({ error: 'Пароль должен быть не менее 4 символов' });
        }

        const db = await readDB();

        // Проверка существования пользователя
        const existingUser = db.users.find(u => 
            u.username === username || u.email === email
        );
        
        if (existingUser) {
            if (existingUser.username === username) {
                return res.status(400).json({ error: 'Этот никнейм уже занят' });
            } else {
                return res.status(400).json({ error: 'Этот email уже зарегистрирован' });
            }
        }

        // Удаляем старые коды для этого email
        db.verificationCodes = db.verificationCodes.filter(c => c.email !== email);

        // Генерируем код
        const code = generateVerificationCode();
        const expiresAt = Date.now() + 10 * 60 * 1000; // 10 минут

        db.verificationCodes.push({
            email,
            code,
            expiresAt,
            username,
            passwordHash: await bcrypt.hash(password, 10)
        });

        await writeDB(db);

        // Отправляем email
        await sendVerificationEmail(email, code);

        res.json({ 
            success: true, 
            message: 'Код подтверждения отправлен на email' 
        });

    } catch (error) {
        console.error('Ошибка регистрации (шаг 1):', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Подтверждение кода и завершение регистрации
app.post('/register/verify', async (req, res) => {
    try {
        const { email, code } = req.body;

        if (!email || !code) {
            return res.status(400).json({ error: 'Email и код обязательны' });
        }

        const db = await readDB();
        
        // Ищем код верификации
        const verification = db.verificationCodes.find(v => 
            v.email === email && v.code === code
        );

        if (!verification) {
            return res.status(400).json({ error: 'Неверный код подтверждения' });
        }

        if (verification.expiresAt < Date.now()) {
            // Удаляем просроченный код
            db.verificationCodes = db.verificationCodes.filter(v => v.email !== email);
            await writeDB(db);
            return res.status(400).json({ error: 'Код подтверждения истёк' });
        }

        // Создаем пользователя
        const newUser = {
            id: crypto.randomUUID(),
            username: verification.username,
            email: verification.email,
            passwordHash: verification.passwordHash,
            createdAt: new Date().toISOString(),
            emailVerified: true
        };

        db.users.push(newUser);
        
        // Удаляем использованный код
        db.verificationCodes = db.verificationCodes.filter(v => v.email !== email);
        
        await writeDB(db);

        // Создаем JWT токен
        const token = jwt.sign(
            { id: newUser.id, username: newUser.username, email: newUser.email },
            process.env.JWT_SECRET || 'jwt-secret-key',
            { expiresIn: '7d' }
        );

        res.json({
            success: true,
            message: 'Регистрация успешно завершена',
            token,
            user: {
                id: newUser.id,
                username: newUser.username,
                email: newUser.email
            }
        });

    } catch (error) {
        console.error('Ошибка подтверждения:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Вход
app.post('/login', authLimiter, async (req, res) => {
    try {
        const { username, password, remember } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Логин и пароль обязательны' });
        }

        const db = await readDB();
        
        // Ищем пользователя по username или email
        const user = db.users.find(u => 
            u.username === username || u.email === username
        );

        if (!user) {
            return res.status(401).json({ error: 'Неверный логин или пароль' });
        }

        const validPassword = await bcrypt.compare(password, user.passwordHash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Неверный логин или пароль' });
        }

        // Создаем JWT токен
        const expiresIn = remember ? '30d' : '7d';
        const token = jwt.sign(
            { id: user.id, username: user.username, email: user.email },
            process.env.JWT_SECRET || 'jwt-secret-key',
            { expiresIn }
        );

        res.json({
            success: true,
            message: 'Вход выполнен успешно',
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email
            }
        });

    } catch (error) {
        console.error('Ошибка входа:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Повторная отправка кода
app.post('/register/resend-code', emailLimiter, async (req, res) => {
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

        // Генерируем новый код
        const newCode = generateVerificationCode();
        verification.code = newCode;
        verification.expiresAt = Date.now() + 10 * 60 * 1000;

        await writeDB(db);
        await sendVerificationEmail(email, newCode);

        res.json({ 
            success: true, 
            message: 'Новый код отправлен на email' 
        });

    } catch (error) {
        console.error('Ошибка повторной отправки:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Получение профиля пользователя
app.get('/profile', authenticateToken, async (req, res) => {
    try {
        const db = await readDB();
        const user = db.users.find(u => u.id === req.user.id);
        
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }

        res.json({
            id: user.id,
            username: user.username,
            email: user.email,
            createdAt: user.createdAt
        });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Выход (на клиенте просто удаляем токен)
app.post('/logout', (req, res) => {
    res.json({ success: true, message: 'Выход выполнен' });
});

// Проверка токена
app.get('/verify-token', authenticateToken, (req, res) => {
    res.json({ valid: true, user: req.user });
});

// Запуск сервера
app.listen(PORT, async () => {
    await initDatabase();
    if (transporter.options.host === 'smtp.ethereal.email') {
        await createTestAccount();
    }
    console.log(`🚀 Сервер Swolts запущен на порту ${PORT}`);
    
    // Очистка устаревших кодов каждые 5 минут
    setInterval(cleanupExpiredCodes, 5 * 60 * 1000);
});
