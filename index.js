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
let hotlineWaiting = [];

// Helper: check if two hotline users are compatible
function isHotlineMatch(userA, userB) {
    // userA wants to match with userB
    if (userA.targetCountry && userA.targetCountry !== '' && userA.targetCountry !== userB.country) return false;
    if (userA.excludeCountry && userA.excludeCountry !== '' && userA.excludeCountry === userB.country) return false;
    // userB wants to match with userA
    if (userB.targetCountry && userB.targetCountry !== '' && userB.targetCountry !== userA.country) return false;
    if (userB.excludeCountry && userB.excludeCountry !== '' && userB.excludeCountry === userA.country) return false;
    return true;
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

    // HotLine: country-based matching
    socket.on('find_hotline_partner', ({ peerId, country, targetCountry, excludeCountry }) => {
        if (!peerId) {
            console.warn(`Socket ${socket.id} sent empty peerId for hotline, ignoring`);
            socket.emit('peer_not_ready');
            return;
        }

        socket.peerId = peerId;
        socket.country = country || 'Unknown';
        socket.targetCountry = targetCountry || '';
        socket.excludeCountry = excludeCountry || '';
        console.log(`[HotLine] ${socket.id} peerId=${peerId} country=${socket.country} target=${targetCountry || 'Any'} exclude=${excludeCountry || 'None'}`);

        // Find a compatible partner from the hotline queue
        let partner = null;
        let partnerIndex = -1;
        for (let i = hotlineWaiting.length - 1; i >= 0; i--) {
            const candidate = hotlineWaiting[i];
            if (!candidate.connected || !candidate.peerId || candidate.partner) {
                hotlineWaiting.splice(i, 1); // clean stale
                continue;
            }
            if (isHotlineMatch(socket, candidate)) {
                partner = candidate;
                partnerIndex = i;
                break;
            }
        }

        if (partner) {
            hotlineWaiting.splice(partnerIndex, 1);

            socket.partner = partner;
            partner.partner = socket;
            socket.isInitiator = true;
            partner.isInitiator = false;
            socket.isReadyForCall = false;
            socket.isPreflightDone = false;
            partner.isReadyForCall = false;
            partner.isPreflightDone = false;

            // Include partner country in match_found
            socket.emit('match_found', { partnerId: partner.peerId, initiator: true, partnerCountry: partner.country });
            partner.emit('match_found', { partnerId: socket.peerId, initiator: false, partnerCountry: socket.country });

            socket.emit('preflight', { partnerId: partner.peerId });
            partner.emit('preflight', { partnerId: socket.peerId });

            setTimeout(() => {
                if (socket.partner && socket.partner.isReadyForCall && socket.isReadyForCall) {
                    console.log('[HotLine] Preflight timeout — forcing start_call');
                    if (socket.isInitiator) {
                        socket.emit('start_call', { partnerId: socket.partner.peerId });
                    } else if (socket.partner.isInitiator) {
                        socket.partner.emit('start_call', { partnerId: socket.peerId });
                    } else {
                        socket.emit('start_call', { partnerId: socket.partner.peerId });
                    }
                }
            }, 3000);

            console.log(`[HotLine] Matched ${socket.id} (${socket.country}) with ${partner.id} (${partner.country})`);
        } else {
            hotlineWaiting.push(socket);
            console.log(`[HotLine] ${socket.id} (${socket.country}) waiting for partner`);
        }
    });

    socket.on('disconnect', () => {
        // Use setTimeout so clientsCount reflects the removal
        setTimeout(() => {
            io.emit('user_count', io.engine.clientsCount);
        }, 0);
        console.log(`User disconnected: ${socket.id}`);

        // Remove from waiting lists
        const index = waitingUsers.indexOf(socket);
        if (index > -1) {
            waitingUsers.splice(index, 1);
        }
        const hIndex = hotlineWaiting.indexOf(socket);
        if (hIndex > -1) {
            hotlineWaiting.splice(hIndex, 1);
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
