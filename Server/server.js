const config = require('./config.json');
const fs = require('fs');

/* Server middleware */
const { authenticate, create } = require('./DatabaseHandler.js');
const { dispatchHello } = require('./Dispatcher.js');
const { handleIncomingData, handlePresenceUpdate } = require('./EventHandler.js');

/* Server */
const https = require('https');
const WebSocket = require('ws');
const express = require('express');
const bodyParser = require('body-parser');

/* Apps */
const wss = https.createServer({
    cert: fs.readFileSync('./certificate.pem'),
    key: fs.readFileSync('./key.pem'),
});
const app = express.Router();
const server = new WebSocket.Server({ server: wss });


server.on('connection', async (client, req) => {
    if (!req.headers.authorization) {
        setTimeout(() => {
            if (!client.user && client.readyState !== WebSocket.CLOSED) { // Not logged in
                client.close(4001, 'Unauthorized: Invalid credentials');
            }
        }, 30e3); // 30 second grace period to login
    } else {
        checkLogin(client, req.headers.authorization);
    }

    client.on('message', (data) => {
        if (typeof data === 'string' && data.startsWith('Basic ') && !client.user) {
            checkLogin(client, data);
        } else if (client.user) { // Heck off unauth'd users
            handleIncomingData(client, data, server.clients);
        }
    });
    client.on('error', () => {});
    client.on('close', () => client.user && handlePresenceUpdate(client.user.id, server.clients));
    client.on('pong', () => client.isAlive = true);
});


async function checkLogin(client, data) {
    const auth = data.split(' ')[1];

    if (!auth) {
        return client.close(4001, 'Unauthorized: Invalid credentials');
    }

    const decrypted = Buffer.from(auth, 'base64').toString();
    const [username, password] = decrypted.split(':');
    const user = await authenticate(username, password);

    if (!user) {
        return client.close(4001, 'Unauthorized: Invalid credentials');
    }

    console.log(`Connection from ${username} established | Clients: ${server.clients.size}`); // eslint-disable-line
    client._un = username;
    client.user = user;
    client.isAlive = true;

    await dispatchHello(client);
    handlePresenceUpdate(client.user.id, server.clients);
}


app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(`${__dirname}/views`));

app.post('/create', async (req, res) => {
    const { username, password } = req.body;

    if (username.trim().length === 0) {
        return res.send('Username cannot be empty.');
    }

    if (username.trim().length > 15) {
        return res.send('Username cannot exceed 15 characters.');
    }

    if (password.length === 0) {
        return res.send('Password cannot be empty.');
    }

    const created = await create(username.trim(), password);

    if (created) {
        return res.send('Account created! Login with the Union client.');
    } else {
        return res.send('Looks like that account exists, sad.');
    }

});


wss.listen(config.ws.port, () => {
    console.log(`[WS] Server started on port ${config.ws.port}`); // eslint-disable-line
    setInterval(() => {
        server.clients.forEach(ws => {
            if (!ws.isAlive && ws.user) {
                console.log(`WS Died\n\t${ws._un}\n\t${server.clients.size - 1} clients`); // eslint-disable-line
                handlePresenceUpdate(ws.user.id, server.clients);
                return ws.terminate();
            }
            ws.isAlive = false;
            ws.ping();
        });
    }, 10e3);
})

exports.router = app;
//app.listen(config.web.port);

process.on('SIGINT', () => {
    server.clients.forEach(ws => ws.close(1000));
});
