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

const MAP_W = 2000;
const MAP_H = 1500;

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
    let balance = 0;
    let inventory = [];
    if (db) {
        const doc = await db.collection('voice_time').findOne({ _id: user.id });
        balance = doc ? Math.floor(doc.coins || 0) : 0;
        inventory = doc ? (doc.inventory || []) : [];
    }
    res.json({ ...user, balance, inventory });
});

app.get('/auth/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// ─── Город и карта ────────────────────────────────────────────

const TREE_POSITIONS = [];
for (let i = 0; i < 60; i++) {
    TREE_POSITIONS.push({
        x: Math.random() * (MAP_W - 100) + 50,
        y: Math.random() * (MAP_H - 100) + 50,
        type: Math.random() > 0.3 ? 'tree' : 'bush'
    });
}

const CITY_CENTER = { x: MAP_W / 2, y: MAP_H / 2 };

const BUILDINGS = [
    { x: CITY_CENTER.x - 200, y: CITY_CENTER.y - 180, w: 160, h: 130, type: 'casino', label: '🎰 Казино' },
    { x: CITY_CENTER.x + 40,  y: CITY_CENTER.y - 180, w: 160, h: 130, type: 'shop',   label: '🛒 Магазин' },
];

const FISHING_ZONES = [
    { x: 200, y: MAP_H - 300, w: 250, h: 160, label: '🎣 Озеро' },
    { x: MAP_W - 450, y: MAP_H - 300, w: 250, h: 160, label: '🎣 Пруд' },
];

const PLAYER_SPEED = 4;

// ─── Игровой сервер ───────────────────────────────────────────

const players = {};
const fishTimers = {};
const discordSockets = {};

io.on('connection', (socket) => {
    console.log('Игрок подключился:', socket.id);

    players[socket.id] = {
        x: CITY_CENTER.x + Math.random() * 100 - 50,
        y: CITY_CENTER.y + Math.random() * 100 - 50,
        name: 'Игрок',
        avatar: null,
        balance: 0,
        discordId: null,
        inventory: []
    };

    socket.emit('mapData', {
        mapW: MAP_W,
        mapH: MAP_H,
        trees: TREE_POSITIONS,
        buildings: BUILDINGS,
        fishingZones: FISHING_ZONES,
        cityCenter: CITY_CENTER
    });
    socket.emit('currentPlayers', players);
    socket.broadcast.emit('newPlayer', { id: socket.id, ...players[socket.id] });

    socket.on('setProfile', (data) => {
        if (players[socket.id]) {
            const oldSocketId = discordSockets[data.discordId];
            if (oldSocketId && oldSocketId !== socket.id) {
                const oldSocket = io.sockets.sockets.get(oldSocketId);
                if (oldSocket) {
                    oldSocket.emit('duplicateSession');
                    oldSocket.disconnect(true);
                }
                if (players[oldSocketId]) {
                    delete players[oldSocketId];
                    io.emit('playerDisconnected', oldSocketId);
                }
            }
            discordSockets[data.discordId] = socket.id;
            players[socket.id].name = data.name;
            players[socket.id].avatar = data.avatar;
            players[socket.id].balance = data.balance || 0;
            players[socket.id].discordId = data.discordId;
            players[socket.id].inventory = data.inventory || [];
            io.emit('playerUpdated', {
                id: socket.id,
                name: data.name,
                avatar: data.avatar,
                balance: data.balance,
                inventory: data.inventory
            });
        }
    });

    socket.on('move', (data) => {
        if (players[socket.id]) {
            players[socket.id].x = Math.max(10, Math.min(MAP_W - 10, data.x));
            players[socket.id].y = Math.max(10, Math.min(MAP_H - 10, data.y));
            socket.broadcast.emit('playerMoved', {
                id: socket.id,
                x: players[socket.id].x,
                y: players[socket.id].y,
                dir: data.dir
            });
        }
    });

    // Рыбалка
    socket.on('startFishing', (data) => {
        const player = players[socket.id];
        if (!player) return;
        const inZone = FISHING_ZONES.some(z =>
            player.x > z.x && player.x < z.x + z.w &&
            player.y > z.y && player.y < z.y + z.h
        );
        if (!inZone) {
            socket.emit('fishingError', { message: 'Нужно быть у водоёма чтобы рыбачить!' });
            return;
        }

        const difficulty = 0.5 + Math.random() * 0.5;
        const fishTypes = [
            { name: '🐟 Карась', price: 10, speed: 0.3 },
            { name: '🐠 Окунь', price: 15, speed: 0.5 },
            { name: '🐡 Фугу', price: 25, speed: 0.7 },
            { name: '🦈 Акула', price: 50, speed: 0.9 },
            { name: '🐳 Кит', price: 100, speed: 1.0 },
        ];
        const fish = fishTypes[Math.floor(Math.random() * fishTypes.length)];

        socket.emit('fishingGame', {
            fish: fish.name,
            price: fish.price,
            speed: fish.speed,
            duration: 5000
        });
    });

    socket.on('fishResult', (data) => {
        const player = players[socket.id];
        if (!player) return;

        if (data.caught) {
            if (db && player.discordId) {
                db.collection('voice_time').updateOne(
                    { _id: player.discordId },
                    {
                        $inc: { coins: data.price },
                        $push: { inventory: { name: data.fish, price: data.price, date: new Date().toISOString() } }
                    },
                    { upsert: true }
                ).catch(e => console.error('Ошибка начисления:', e));
            }
            player.balance += data.price;
            if (!player.inventory) player.inventory = [];
            player.inventory.push({ name: data.fish, price: data.price });
            socket.emit('fishCaught', { fish: data.fish, price: data.price, balance: player.balance, inventory: player.inventory });
            io.emit('playerUpdated', { id: socket.id, balance: player.balance, inventory: player.inventory });
        } else {
            socket.emit('fishLost', { fish: data.fish });
        }
    });

    socket.on('chatMessage', (data) => {
        if (players[socket.id]) {
            io.emit('chatMessage', {
                id: socket.id,
                name: players[socket.id].name,
                text: data.text.substring(0, 100)
            });
        }
    });

    socket.on('disconnect', () => {
        if (fishTimers[socket.id]) {
            clearTimeout(fishTimers[socket.id]);
            delete fishTimers[socket.id];
        }
        const player = players[socket.id];
        if (player && player.discordId && discordSockets[player.discordId] === socket.id) {
            delete discordSockets[player.discordId];
        }
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен: http://localhost:${PORT}`);
});