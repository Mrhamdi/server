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

// Helper: clean full teardown of a partnership
function teardownPartnership(socket) {
    if (socket.partner) {
        const partner = socket.partner;
        partner.partner = null;
        partner.isReadyForCall = false;
        partner.isPreflightDone = false;
        partner.isInitiator = false;
        socket.partner = null;
    }
    socket.isReadyForCall = false;
    socket.isPreflightDone = false;
    socket.isInitiator = false;
}

// Helper: remove socket from waiting queue
function removeFromQueue(socket) {
    const index = waitingUsers.indexOf(socket);
    if (index > -1) {
        waitingUsers.splice(index, 1);
    }
}

// Helper: emit start_call to the initiator of a pair
function emitStartCall(socketA, socketB) {
    // Guard: both must still be partnered with each other
    if (!socketA.partner || !socketB.partner) return;
    if (socketA.partner !== socketB || socketB.partner !== socketA) return;

    if (socketA.isInitiator) {
        console.log(`Instructing initiator ${socketA.id} to start_call -> ${socketB.peerId}`);
        socketA.emit('start_call', { partnerId: socketB.peerId });
    } else if (socketB.isInitiator) {
        console.log(`Instructing initiator ${socketB.id} to start_call -> ${socketA.peerId}`);
        socketB.emit('start_call', { partnerId: socketA.peerId });
    } else {
        // fallback
        console.log(`Fallback start_call by ${socketA.id} to ${socketB.peerId}`);
        socketA.emit('start_call', { partnerId: socketB.peerId });
    }
}

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

        // If already in a partnership, ignore (prevents double-queue)
        if (socket.partner) {
            console.warn(`Socket ${socket.id} already has a partner, ignoring find_partner`);
            return;
        }

        // Remove from queue first to prevent duplicates
        removeFromQueue(socket);

        // Store the peerId with the socket
        socket.peerId = peerId;
        console.log(`Socket ${socket.id} registered peerId=${peerId}`);

        // Find a valid partner from the waiting queue
        let partner = null;
        while (waitingUsers.length > 0) {
            const candidate = waitingUsers.pop();
            // Only accept connected sockets with valid peerId, not already paired, and not self
            if (candidate.connected && candidate.peerId && !candidate.partner && candidate.id !== socket.id) {
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
            const matchTimestamp = Date.now();
            socket._matchTimestamp = matchTimestamp;
            partner._matchTimestamp = matchTimestamp;

            setTimeout(() => {
                // Only force-start if this match is still current
                if (socket._matchTimestamp !== matchTimestamp) return;
                if (!socket.partner || socket.partner !== partner) return;
                if (!partner.partner || partner.partner !== socket) return;

                if (socket.isReadyForCall && partner.isReadyForCall) {
                    console.log('Preflight timeout reached — forcing start_call');
                    emitStartCall(socket, partner);
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
        removeFromQueue(socket);

        // Notify partner if connected
        if (socket.partner) {
            socket.partner.emit('partner_disconnected');
            teardownPartnership(socket);
        }
    });

    // Client signals it's ready (has local stream and peer id registered)
    socket.on('peer_ready', () => {
        socket.isReadyForCall = true;
        console.log(`Socket ${socket.id} isReadyForCall=true`);
        // start only when both peers are ready AND preflight completed
        if (socket.partner && socket.partner.isReadyForCall && socket.isPreflightDone && socket.partner.isPreflightDone) {
            console.log(`Both peers ready and preflight done: ${socket.id} <-> ${socket.partner.id}`);
            emitStartCall(socket, socket.partner);
        }
    });

    // Client reports preflight completed (used to warm-up connections)
    socket.on('preflight_done', () => {
        socket.isPreflightDone = true;
        console.log(`Socket ${socket.id} preflight done`);
        if (socket.partner && socket.partner.isReadyForCall && socket.isReadyForCall && socket.partner.isPreflightDone) {
            console.log(`Both peers ready and preflight done (via preflight_done): ${socket.id} <-> ${socket.partner.id}`);
            emitStartCall(socket, socket.partner);
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
        }
        teardownPartnership(socket);
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
