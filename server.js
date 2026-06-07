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

const MAP_W = 2400;
const MAP_H = 1800;

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
            new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        const userRes = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
        });
        req.session.user = {
            id: userRes.data.id,
            username: userRes.data.username,
            avatar: userRes.data.avatar ? `https://cdn.discordapp.com/avatars/${userRes.data.id}/${userRes.data.avatar}.png` : `https://cdn.discordapp.com/embed/avatars/0.png`
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
    let balance = 0, inventory = [], health = 100, house = null;
    if (db) {
        const doc = await db.collection('voice_time').findOne({ _id: user.id });
        balance = doc ? Math.floor(doc.coins || 0) : 0;
        inventory = doc ? (doc.inventory || []) : [];
        health = doc ? (doc.health || 100) : 100;
        house = doc ? (doc.house || null) : null;
    }
    res.json({ ...user, balance, inventory, health, house });
});

app.get('/auth/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// ─── Карта ────────────────────────────────────────────────────

const CITY_CENTER = { x: MAP_W / 2, y: MAP_H / 2 };

const TREE_POSITIONS = [];
for (let i = 0; i < 100; i++) {
    const x = Math.random() * (MAP_W - 100) + 50;
    const y = Math.random() * (MAP_H - 100) + 50;
    const distFromCity = Math.hypot(x - CITY_CENTER.x, y - CITY_CENTER.y);
    if (distFromCity > 400) {
        TREE_POSITIONS.push({ x, y, type: Math.random() > 0.3 ? 'tree' : 'bush' });
    }
}

const ROAD_TILES = [];
for (let rx = CITY_CENTER.x - 350; rx < CITY_CENTER.x + 350; rx += 32) {
    for (let ry = CITY_CENTER.y - 280; ry < CITY_CENTER.y + 280; ry += 32) {
        if (Math.abs(rx - CITY_CENTER.x) < 64 || Math.abs(ry - CITY_CENTER.y) < 64) {
            ROAD_TILES.push({ x: rx, y: ry });
        }
    }
}

const BUILDINGS = [
    { x: CITY_CENTER.x - 340, y: CITY_CENTER.y - 260, w: 180, h: 150, type: 'casino', label: '🎰 Казино' },
    { x: CITY_CENTER.x + 160, y: CITY_CENTER.y - 260, w: 180, h: 150, type: 'shop',   label: '🛒 Магазин' },
    { x: CITY_CENTER.x - 90,  y: CITY_CENTER.y - 260, w: 250, h: 150, type: 'tavern', label: '🍺 Таверна' },
];

const LAMPS = [];
for (let lx = CITY_CENTER.x - 300; lx < CITY_CENTER.x + 350; lx += 120) {
    for (let ly = CITY_CENTER.y - 280; ly < CITY_CENTER.y + 280; ly += 100) {
        if (Math.abs(lx - CITY_CENTER.x) < 64 || Math.abs(ly - CITY_CENTER.y) < 64) {
            LAMPS.push({ x: lx, y: ly });
        }
    }
}

const FISHING_ZONES = [
    { x: 200, y: MAP_H - 350, w: 280, h: 200, label: '🎣 Лесное озеро' },
    { x: MAP_W - 480, y: MAP_H - 350, w: 280, h: 200, label: '🎣 Тихий пруд' },
];

// ─── Игровой сервер ───────────────────────────────────────────

const players = {};
const fishTimers = {};
const discordSockets = {};
const houses = {};
const coffeeTimers = {};

// Загружаем домики из БД
(async () => {
    if (db) {
        const docs = await db.collection('voice_time').find({ house: { $exists: true } }).toArray();
        for (const doc of docs) {
            if (doc.house) houses[doc._id] = doc.house;
        }
    }
})();

io.on('connection', (socket) => {
    console.log('Игрок подключился:', socket.id);

    players[socket.id] = {
        x: CITY_CENTER.x + Math.random() * 100 - 50,
        y: CITY_CENTER.y + Math.random() * 100 - 50,
        name: 'Игрок', avatar: null, balance: 0, discordId: null,
        inventory: [], health: 100, speed: 4, house: null, dir: 'down', emoji: null
    };

    socket.emit('mapData', {
        mapW: MAP_W, mapH: MAP_H,
        trees: TREE_POSITIONS, roadTiles: ROAD_TILES,
        buildings: BUILDINGS, lamps: LAMPS,
        fishingZones: FISHING_ZONES,
        cityCenter: CITY_CENTER, houses
    });
    socket.emit('currentPlayers', players);
    socket.broadcast.emit('newPlayer', { id: socket.id, ...players[socket.id] });

    socket.on('setProfile', (data) => {
        if (players[socket.id]) {
            const oldSocketId = discordSockets[data.discordId];
            if (oldSocketId && oldSocketId !== socket.id && players[oldSocketId]) {
                delete players[oldSocketId];
                io.emit('playerDisconnected', oldSocketId);
            }
            discordSockets[data.discordId] = socket.id;
            players[socket.id].name = data.name;
            players[socket.id].avatar = data.avatar;
            players[socket.id].balance = data.balance || 0;
            players[socket.id].discordId = data.discordId;
            players[socket.id].inventory = data.inventory || [];
            players[socket.id].health = data.health || 100;
            players[socket.id].house = data.house || null;
            io.emit('playerUpdated', {
                id: socket.id, name: data.name, avatar: data.avatar,
                balance: data.balance, inventory: data.inventory, health: data.health, house: data.house
            });
        }
    });

    socket.on('move', (data) => {
        if (players[socket.id]) {
            players[socket.id].x = Math.max(10, Math.min(MAP_W - 10, data.x));
            players[socket.id].y = Math.max(10, Math.min(MAP_H - 10, data.y));
            players[socket.id].dir = data.dir;
            socket.broadcast.emit('playerMoved', { id: socket.id, x: players[socket.id].x, y: players[socket.id].y, dir: data.dir });
        }
    });

    // Эмодзи
    socket.on('emoji', (data) => {
        if (players[socket.id]) {
            players[socket.id].emoji = data.emoji;
            players[socket.id].emojiTime = Date.now();
            io.emit('playerEmoji', { id: socket.id, emoji: data.emoji });
            setTimeout(() => {
                if (players[socket.id]) players[socket.id].emoji = null;
                io.emit('playerEmoji', { id: socket.id, emoji: null });
            }, 3000);
        }
    });

    // Рыбалка
    socket.on('startFishing', () => {
        const player = players[socket.id];
        if (!player) return;
        const inZone = FISHING_ZONES.some(z =>
            player.x > z.x && player.x < z.x + z.w && player.y > z.y && player.y < z.y + z.h
        );
        if (!inZone) { socket.emit('fishingError', { message: 'Нужно быть у водоёма!' }); return; }
        socket.emit('fishingStarted');
        const catchTime = 3000 + Math.random() * 4000;
        fishTimers[socket.id] = setTimeout(() => {
            const fishTypes = [
                { name: '🐟 Карась', price: 10, icon: 'fish1' },
                { name: '🐠 Окунь', price: 15, icon: 'fish2' },
            ];
            const fish = fishTypes[Math.floor(Math.random() * fishTypes.length)];
            const caught = Math.random() > 0.3;
            if (caught && db && player.discordId) {
                db.collection('voice_time').updateOne(
                    { _id: player.discordId },
                    { $inc: { coins: fish.price }, $push: { inventory: { name: fish.name, price: fish.price, icon: fish.icon, date: new Date().toISOString() } } },
                    { upsert: true }
                ).catch(e => console.error('Ошибка начисления:', e));
                player.balance += fish.price;
                if (!player.inventory) player.inventory = [];
                player.inventory.push({ name: fish.name, price: fish.price, icon: fish.icon });
                socket.emit('fishCaught', { fish: fish.name, price: fish.price, balance: player.balance, inventory: player.inventory, icon: fish.icon });
                io.emit('playerUpdated', { id: socket.id, balance: player.balance, inventory: player.inventory });
            } else {
                socket.emit('fishLost', { fish: fish.name });
            }
            delete fishTimers[socket.id];
        }, catchTime);
    });

    socket.on('cancelFishing', () => {
        if (fishTimers[socket.id]) { clearTimeout(fishTimers[socket.id]); delete fishTimers[socket.id]; }
    });

    // Продажа рыбы
    socket.on('sellFish', (data) => {
        const player = players[socket.id];
        if (!player || !player.inventory) return;
        const idx = player.inventory.findIndex(item => item.name === data.fishName && item.price === data.price);
        if (idx === -1) return;
        const sold = player.inventory.splice(idx, 1)[0];
        player.balance += sold.price;
        if (db && player.discordId) {
            db.collection('voice_time').updateOne(
                { _id: player.discordId },
                { $inc: { coins: sold.price }, $set: { inventory: player.inventory } }
            ).catch(e => console.error('Ошибка продажи:', e));
        }
        socket.emit('fishSold', { fish: sold.name, price: sold.price, balance: player.balance, inventory: player.inventory });
        io.emit('playerUpdated', { id: socket.id, balance: player.balance, inventory: player.inventory });
    });

    // Домик
    socket.on('placeHouse', (data) => {
        const player = players[socket.id];
        if (!player || player.balance < 5000 || player.house) return;
        const hx = data.x, hy = data.y;
        const distFromCity = Math.hypot(hx - CITY_CENTER.x, hy - CITY_CENTER.y);
        if (distFromCity < 450) { socket.emit('houseError', { message: 'Слишком близко к городу!' }); return; }
        for (const z of FISHING_ZONES) {
            if (hx > z.x && hx < z.x + z.w && hy > z.y && hy < z.y + z.h) {
                socket.emit('houseError', { message: 'Нельзя строить на воде!' }); return;
            }
        }
        for (const h of Object.values(houses)) {
            if (Math.abs(hx - h.x) < 80 && Math.abs(hy - h.y) < 80) {
                socket.emit('houseError', { message: 'Слишком близко к другому домику!' }); return;
            }
        }
        player.balance -= 5000;
        player.house = { x: hx, y: hy, owner: player.name };
        houses[player.discordId] = player.house;
        if (db && player.discordId) {
            db.collection('voice_time').updateOne(
                { _id: player.discordId },
                { $set: { coins: player.balance, house: player.house } }
            ).catch(e => console.error('Ошибка домика:', e));
        }
        io.emit('housePlaced', { ownerId: player.discordId, house: player.house, balance: player.balance });
        io.emit('playerUpdated', { id: socket.id, balance: player.balance, house: player.house });
    });

    // Кофе
    socket.on('drinkCoffee', () => {
        const player = players[socket.id];
        if (!player) return;
        const now = Date.now();
        const lastCoffee = coffeeTimers[player.discordId] || 0;
        if (now - lastCoffee < 300000) {
            const remaining = Math.ceil((300000 - (now - lastCoffee)) / 60000);
            socket.emit('coffeeError', { message: `Кофе будет готов через ${remaining} мин.` });
            return;
        }
        coffeeTimers[player.discordId] = now;
        player.speed = 6;
        socket.emit('coffeeActive', { speed: 6 });
        setTimeout(() => {
            if (players[socket.id]) {
                players[socket.id].speed = 4;
                socket.emit('coffeeExpired', { speed: 4 });
            }
        }, 60000);
    });

    // Чат
    socket.on('chatMessage', (data) => {
        if (players[socket.id]) {
            io.emit('chatMessage', { id: socket.id, name: players[socket.id].name, text: data.text.substring(0, 100) });
        }
    });

    socket.on('disconnect', () => {
        if (fishTimers[socket.id]) { clearTimeout(fishTimers[socket.id]); delete fishTimers[socket.id]; }
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