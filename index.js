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
    },
    pingTimeout: 5000,
    pingInterval: 10000
});

const peerServer = ExpressPeerServer(server, {
    debug: true,
    path: '/myapp'
});

app.use('/peerjs', peerServer);

let waitingUsers = [];

io.on('connection', (socket) => {
    io.emit('user_count', io.engine.clientsCount);
    console.log(`User connected: ${socket.id}. Online: ${io.engine.clientsCount}`);

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

        // Find a valid partner from the waiting queue
        let partner = null;
        while (waitingUsers.length > 0) {
            const candidate = waitingUsers.pop();
            // Only accept connected sockets that have a valid peerId and aren't already paired
            if (candidate.connected && candidate.peerId && !candidate.partner) {
                partner = candidate;
                break;
            }
        }

        if (partner) {
            // Store partner info
            socket.partner = partner;
            partner.partner = socket;

            // Mark initiator flags
            socket.isInitiator = true;
            partner.isInitiator = false;

            // Initialize ready flags
            socket.isReadyForCall = false;
            socket.isPreflightDone = false;
            partner.isReadyForCall = false;
            partner.isPreflightDone = false;

            // Emit match found to both
            socket.emit('match_found', { partnerId: partner.peerId, initiator: true });
            partner.emit('match_found', { partnerId: socket.peerId, initiator: false });

            // Emit preflight to allow clients to warm up signaling/data channels
            socket.emit('preflight', { partnerId: partner.peerId });
            partner.emit('preflight', { partnerId: socket.peerId });

            // Force start after timeout even if preflight hasn't completed, to avoid stalling
            setTimeout(() => {
                if (socket.partner && socket.partner.isReadyForCall && socket.isReadyForCall) {
                    console.log('Preflight timeout reached — forcing start_call');
                    if (socket.isInitiator) {
                        socket.emit('start_call', { partnerId: socket.partner.peerId });
                    } else if (socket.partner.isInitiator) {
                        socket.partner.emit('start_call', { partnerId: socket.peerId });
                    } else {
                        socket.emit('start_call', { partnerId: socket.partner.peerId });
                    }
                }
            }, 3000);

            console.log(`Matched ${socket.id} with ${partner.id}`);
        } else {
            waitingUsers.push(socket);
            console.log(`User ${socket.id} waiting for partner`);
        }
    });

    socket.on('disconnect', () => {
        // Use setTimeout so clientsCount reflects the removal
        setTimeout(() => {
            io.emit('user_count', io.engine.clientsCount);
        }, 0);
        console.log(`User disconnected: ${socket.id}`);

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
        // start only when both peers are ready AND preflight completed
        if (socket.partner && socket.partner.isReadyForCall && socket.isPreflightDone && socket.partner.isPreflightDone) {
            console.log(`Both peers ready and preflight done: ${socket.id} <-> ${socket.partner.id}`);
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

    // Client reports preflight completed (used to warm-up connections)
    socket.on('preflight_done', () => {
        socket.isPreflightDone = true;
        console.log(`Socket ${socket.id} preflight done`);
        if (socket.partner && socket.partner.isReadyForCall && socket.isReadyForCall && socket.partner.isPreflightDone) {
            console.log(`Both peers ready and preflight done (via preflight_done): ${socket.id} <-> ${socket.partner.id}`);
            if (socket.isInitiator) {
                socket.emit('start_call', { partnerId: socket.partner.peerId });
            } else if (socket.partner.isInitiator) {
                socket.partner.emit('start_call', { partnerId: socket.peerId });
            } else {
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
