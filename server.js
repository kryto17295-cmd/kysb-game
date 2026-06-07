const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const axios = require('axios');
const { MongoClient } = require('mongodb');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;
const SESSION_SECRET = process.env.SESSION_SECRET || 'kysb_secret';
const MONGO_URI = process.env.MONGO_URI;

// MongoDB
let db;
MongoClient.connect(MONGO_URI).then(client => {
    db = client.db('discord_bot');
    console.log('MongoDB подключена');
}).catch(e => console.error('Ошибка MongoDB:', e));

app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

app.use(express.static('public'));

// ─── Discord авторизация ──────────────────────────────────────

app.get('/auth/login', (req, res) => {
    const url = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify`;
    res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect('/');

    try {
        const tokenRes = await axios.post('https://discord.com/api/oauth2/token',
            new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_type: 'authorization_code',
                code,
                redirect_uri: REDIRECT_URI,
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        const userRes = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
        });

        req.session.user = {
            id: userRes.data.id,
            username: userRes.data.username,
            avatar: userRes.data.avatar
                ? `https://cdn.discordapp.com/avatars/${userRes.data.id}/${userRes.data.avatar}.png`
                : `https://cdn.discordapp.com/embed/avatars/0.png`
        };

        res.redirect('/');
    } catch (e) {
        console.error('Ошибка авторизации:', e.message);
        res.redirect('/');
    }
});

app.get('/auth/me', async (req, res) => {
    if (!req.session.user) return res.json(null);

    const user = req.session.user;

    // Берём баланс из MongoDB
    let balance = 0;
    if (db) {
        const doc = await db.collection('voice_time').findOne({ _id: user.id });
        balance = doc ? Math.floor(doc.seconds || 0) : 0;
    }

    res.json({ ...user, balance });
});

app.get('/auth/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// ─── Игровой сервер ───────────────────────────────────────────

const players = {};

io.on('connection', (socket) => {
    console.log('Игрок подключился:', socket.id);

    players[socket.id] = {
        x: 400,
        y: 300,
        name: 'Игрок',
        avatar: null,
        balance: 0
    };

    socket.emit('currentPlayers', players);
    socket.broadcast.emit('newPlayer', { id: socket.id, ...players[socket.id] });

    socket.on('setProfile', (data) => {
        if (players[socket.id]) {
            players[socket.id].name = data.name;
            players[socket.id].avatar = data.avatar;
            players[socket.id].balance = data.balance || 0;
            io.emit('playerUpdated', { id: socket.id, name: data.name, avatar: data.avatar, balance: data.balance });
        }
    });

    socket.on('move', (data) => {
        if (players[socket.id]) {
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
            socket.broadcast.emit('playerMoved', { id: socket.id, x: data.x, y: data.y });
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен: http://localhost:${PORT}`);
});