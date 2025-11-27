const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const peerServer = ExpressPeerServer(server, {
    debug: true,
    path: '/myapp'
});

app.use('/peerjs', peerServer);

let onlineUsers = 0;
let waitingUsers = [];

io.on('connection', (socket) => {
    onlineUsers++;
    io.emit('user_count', onlineUsers);
    console.log(`User connected: ${socket.id}. Online: ${onlineUsers}`);

    socket.on('find_partner', (peerId) => {
        // Validate peerId before queuing
        if (!peerId) {
            console.warn(`Socket ${socket.id} sent empty peerId, ignoring`);
            socket.emit('peer_not_ready');
            return;
        }

        // Store the peerId with the socket
        socket.peerId = peerId;
        console.log(`Socket ${socket.id} registered peerId=${peerId}`);

        if (waitingUsers.length > 0) {
            const partner = waitingUsers.pop();

            // Check if partner is still connected
            if (partner.connected) {
                // Store partner info
                socket.partner = partner;
                partner.partner = socket;

                // Mark initiator flags
                socket.isInitiator = true;
                partner.isInitiator = false;

                // Initialize ready flags
                socket.isReadyForCall = false;
                partner.isReadyForCall = false;

                // Emit match found to both
                socket.emit('match_found', { partnerId: partner.peerId, initiator: true });
                partner.emit('match_found', { partnerId: socket.peerId, initiator: false });

                console.log(`Matched ${socket.id} with ${partner.id}`);
            } else {
                // Partner disconnected, put current user back in queue
                waitingUsers.push(socket);
            }
        } else {
            waitingUsers.push(socket);
            console.log(`User ${socket.id} waiting for partner`);
        }
    });

    socket.on('disconnect', () => {
        onlineUsers--;
        io.emit('user_count', onlineUsers);
        console.log(`User disconnected: ${socket.id}. Online: ${onlineUsers}`);

        // Remove from waiting list
        const index = waitingUsers.indexOf(socket);
        if (index > -1) {
            waitingUsers.splice(index, 1);
        }

        // Notify partner if connected
        if (socket.partner) {
            socket.partner.emit('partner_disconnected');
            socket.partner.partner = null;
            socket.partner = null;
        }
        // Clear ready flag
        socket.isReadyForCall = false;
        socket.isInitiator = false;
    });

    // Client signals it's ready (has local stream and peer id registered)
    socket.on('peer_ready', () => {
        socket.isReadyForCall = true;
        console.log(`Socket ${socket.id} isReadyForCall=true`);
        // If partner exists and is ready, coordinate start
        if (socket.partner && socket.partner.isReadyForCall) {
            console.log(`Both peers ready: ${socket.id} <-> ${socket.partner.id}`);
            // Decide who should start the call: the initiator
            if (socket.isInitiator) {
                console.log(`Instructing initiator ${socket.id} to start_call -> ${socket.partner.peerId}`);
                socket.emit('start_call', { partnerId: socket.partner.peerId });
            } else if (socket.partner.isInitiator) {
                console.log(`Instructing initiator ${socket.partner.id} to start_call -> ${socket.peerId}`);
                socket.partner.emit('start_call', { partnerId: socket.peerId });
            } else {
                // fallback: let this socket start
                console.log(`Fallback start_call by ${socket.id} to ${socket.partner.peerId}`);
                socket.emit('start_call', { partnerId: socket.partner.peerId });
            }
        }
    });

    socket.on('send_message', (message) => {
        if (socket.partner && socket.partner.connected) {
            socket.partner.emit('receive_message', message);
        }
    });

    socket.on('disconnect_call', () => {
        if (socket.partner && socket.partner.connected) {
            socket.partner.emit('partner_disconnected');
            socket.partner.partner = null;
        }
        socket.partner = null;
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
