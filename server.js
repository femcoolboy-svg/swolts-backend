// API URL
const API_URL = 'http://localhost:3000';

// Функции работы с токеном
function setAuthToken(token) {
    localStorage.setItem('swolts_token', token);
}

function getAuthToken() {
    return localStorage.getItem('swolts_token');
}

// Генерация частиц
function createParticles() {
    const container = document.getElementById('particles');
    const particleCount = 50;
    for (let i = 0; i < particleCount; i++) {
        const particle = document.createElement('div');
        particle.classList.add('particle');
        const size = Math.random() * 6 + 2;
        particle.style.width = `${size}px`;
        particle.style.height = `${size}px`;
        particle.style.left = `${Math.random() * 100}%`;
        particle.style.animationDuration = `${Math.random() * 10 + 8}s`;
        particle.style.animationDelay = `${Math.random() * 5}s`;
        particle.style.opacity = Math.random() * 0.5;
        container.appendChild(particle);
    }
}
createParticles();

// ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ
const loginTab = document.getElementById('loginTab');
const registerTab = document.getElementById('registerTab');
const loginSection = document.getElementById('loginSection');
const registerSection = document.getElementById('registerSection');
const verifySection = document.getElementById('verifySection');
const errorMsg = document.getElementById('errorMsg');
const successMsg = document.getElementById('successMsg');

let pendingRegistration = {
    username: '',
    email: '',
    password: ''
};

let timerInterval;
let timeLeft = 120;
let canResend = false;

// Переключение вкладок
loginTab.addEventListener('click', () => {
    loginTab.classList.add('active');
    registerTab.classList.remove('active');
    loginSection.classList.add('active');
    registerSection.classList.remove('active');
    verifySection.classList.remove('active');
    errorMsg.innerText = '';
    successMsg.innerText = '';
});

registerTab.addEventListener('click', () => {
    registerTab.classList.add('active');
    loginTab.classList.remove('active');
    registerSection.classList.add('active');
    loginSection.classList.remove('active');
    verifySection.classList.remove('active');
    errorMsg.innerText = '';
    successMsg.innerText = '';
    refreshCaptcha();
});

// КАПЧА
const goodWords = [
    "ДОБРО", "МИР", "СОЛНЦЕ", "СВЕТ", "РАДОСТЬ", "СЧАСТЬЕ", "УЛЫБКА", "ДРУЖБА",
    "ВЕСНА", "ЦВЕТЫ", "МЕЧТА", "ЗВЕЗДА", "ЛЮБОВЬ", "НАДЕЖДА", "ВЕРА", "КРАСОТА",
    "ГАРМОНИЯ", "СВОБОДА", "ТВОРЧЕСТВО", "ВДОХНОВЕНИЕ", "ЗДОРОВЬЕ", "УСПЕХ",
    "ПОБЕДА", "ЧУДО", "ВОЛШЕБСТВО", "ЛАСКА", "ТЕПЛО", "ЗАБОТА", "ПОМОЩЬ"
];

let currentCaptchaWord = '';
let usedWords = JSON.parse(sessionStorage.getItem('swoltsCaptchaUsed') || '[]');

function getRandomGoodWord() {
    let available = goodWords.filter(w => !usedWords.includes(w));
    if (available.length === 0) {
        usedWords = [];
        sessionStorage.setItem('swoltsCaptchaUsed', JSON.stringify(usedWords));
        available = [...goodWords];
    }
    const word = available[Math.floor(Math.random() * available.length)];
    usedWords.push(word);
    sessionStorage.setItem('swoltsCaptchaUsed', JSON.stringify(usedWords));
    return word;
}

function refreshCaptcha() {
    currentCaptchaWord = getRandomGoodWord();
    document.getElementById('captchaWord').innerText = currentCaptchaWord;
    document.getElementById('captchaInput').value = '';
}

function checkCaptcha() {
    const userInput = document.getElementById('captchaInput').value.trim().toUpperCase();
    return userInput === currentCaptchaWord;
}

refreshCaptcha();
document.getElementById('refreshCaptcha').addEventListener('click', refreshCaptcha);

// ТАЙМЕР ДЛЯ КОДА
function startTimer() {
    clearInterval(timerInterval);
    timeLeft = 120;
    canResend = false;
    document.getElementById('resendBtn').disabled = true;
    
    timerInterval = setInterval(() => {
        timeLeft--;
        const minutes = Math.floor(timeLeft / 60);
        const seconds = timeLeft % 60;
        document.getElementById('timer').innerText = 
            `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        
        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            document.getElementById('timer').innerText = '00:00';
            canResend = true;
            document.getElementById('resendBtn').disabled = false;
        }
    }, 1000);
}

// АВТОПЕРЕХОД В ПОЛЯХ КОДА
const codeInputs = document.querySelectorAll('.code-digit');
codeInputs.forEach((input, index) => {
    input.addEventListener('input', (e) => {
        if (e.target.value.length === 1 && index < 5) {
            codeInputs[index + 1].focus();
        }
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && index > 0 && !e.target.value) {
            codeInputs[index - 1].focus();
        }
    });

    input.addEventListener('beforeinput', (e) => {
        if (e.data && !/^\d+$/.test(e.data)) {
            e.preventDefault();
        }
    });
});

// ОТПРАВКА ФОРМЫ ВХОДА
document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    const remember = document.getElementById('remember').checked;

    errorMsg.innerText = '';
    successMsg.innerText = '';

    if (!username || !password) {
        errorMsg.innerText = '❌ Заполните все поля';
        return;
    }

    try {
        const res = await fetch(`${API_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, remember })
        });

        const data = await res.json();

        if (data.success) {
            setAuthToken(data.token);
            successMsg.innerText = '✅ Вход выполнен! Перенаправление...';
            document.getElementById('authContainer').classList.add('fade-out');
            setTimeout(() => {
                window.location.href = 'dashboard.html';
            }, 500);
        } else {
            errorMsg.innerText = '❌ ' + data.error;
        }
    } catch (error) {
        errorMsg.innerText = '❌ Ошибка соединения с сервером';
    }
});

// ОТПРАВКА ФОРМЫ РЕГИСТРАЦИИ (ШАГ 1)
document.getElementById('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('regUsername').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value;
    const confirm = document.getElementById('regConfirm').value;

    errorMsg.innerText = '';
    successMsg.innerText = '';

    if (!username || !email || !password || !confirm) {
        errorMsg.innerText = '❌ Заполните все поля';
        return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        errorMsg.innerText = '❌ Введите корректный email';
        return;
    }

    if (password !== confirm) {
        errorMsg.innerText = '❌ Пароли не совпадают';
        return;
    }

    if (password.length < 4) {
        errorMsg.innerText = '❌ Пароль должен быть не менее 4 символов';
        return;
    }

    if (!checkCaptcha()) {
        errorMsg.innerText = '❌ Неправильно введено слово с капчи';
        refreshCaptcha();
        return;
    }

    pendingRegistration = { username, email, password };

    try {
        const res = await fetch(`${API_URL}/register/step1`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, email, password })
        });

        const data = await res.json();

        if (data.success) {
            registerSection.classList.remove('active');
            verifySection.classList.add('active');
            document.getElementById('displayEmail').innerText = email;
            
            startTimer();
            codeInputs.forEach(i => i.value = '');
            codeInputs[0].focus();
            
            successMsg.innerText = '📧 Код отправлен на ваш email';
        } else {
            errorMsg.innerText = '❌ ' + data.error;
        }
    } catch (error) {
        errorMsg.innerText = '❌ Ошибка соединения с сервером';
    }
});

// ПОДТВЕРЖДЕНИЕ КОДА
document.getElementById('verifyCodeBtn').addEventListener('click', async () => {
    const enteredCode = Array.from(codeInputs).map(i => i.value).join('');
    
    errorMsg.innerText = '';
    successMsg.innerText = '';

    if (enteredCode.length !== 6) {
        errorMsg.innerText = '❌ Введите 6-значный код';
        return;
    }

    try {
        const res = await fetch(`${API_URL}/register/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: pendingRegistration.email,
                code: enteredCode
            })
        });

        const data = await res.json();

        if (data.success) {
            setAuthToken(data.token);
            clearInterval(timerInterval);
            successMsg.innerText = '✅ Аккаунт создан! Перенаправление...';
            document.getElementById('authContainer').classList.add('fade-out');
            setTimeout(() => {
                window.location.href = 'dashboard.html';
            }, 500);
        } else {
            errorMsg.innerText = '❌ ' + data.error;
        }
    } catch (error) {
        errorMsg.innerText = '❌ Ошибка соединения с сервером';
    }
});

// ПОВТОРНАЯ ОТПРАВКА КОДА
document.getElementById('resendBtn').addEventListener('click', async () => {
    if (!canResend) return;
    
    try {
        const res = await fetch(`${API_URL}/register/resend-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: pendingRegistration.email })
        });

        const data = await res.json();

        if (data.success) {
            successMsg.innerText = '📧 Новый код отправлен на email';
            startTimer();
            codeInputs.forEach(i => i.value = '');
            codeInputs[0].focus();
        } else {
            errorMsg.innerText = '❌ ' + data.error;
        }
    } catch (error) {
        errorMsg.innerText = '❌ Ошибка соединения с сервером';
    }
});

// ВЕРНУТЬСЯ К РЕГИСТРАЦИИ
document.getElementById('backToRegisterBtn').addEventListener('click', () => {
    clearInterval(timerInterval);
    verifySection.classList.remove('active');
    registerSection.classList.add('active');
    errorMsg.innerText = '';
    successMsg.innerText = '';
});
