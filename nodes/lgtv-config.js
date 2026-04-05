module.exports = function (RED) {
    let status;
    let token;
    let lgtv;

    function LgtvConfigNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.host = config.host;
        node.secure = config.secure !== false && config.secure !== 'false';
        node.users = {};
        const subscriptions = {};

        const tvUrl = (node.secure ? 'wss://' : 'ws://') + node.host + (node.secure ? ':3001' : ':3000');
        let connectingTimer = null;
        let connecting = false;

        const lgtvOpts = {
            url: tvUrl,
            reconnect: false,
            clientKey: node.credentials.token,
            saveKey(key, cb) {
                token = key;
                RED.nodes.addCredentials(node.id, {
                    token: key
                });
                if (typeof cb === 'function') {
                    cb();
                }
            }
        };

        if (node.secure) {
            lgtvOpts.wsconfig = {
                keepalive: true,
                keepaliveInterval: 10000,
                dropConnectionOnKeepaliveTimeout: true,
                keepaliveGracePeriod: 5000,
                tlsOptions: {rejectUnauthorized: config.verifycert === true}
            };
        }

        const lgtv = require('lgtv2')(lgtvOpts);

        lgtv.on('connecting', () => {
            connecting = true;
            node.setStatus('connecting');
            clearTimeout(connectingTimer);
            connectingTimer = setTimeout(() => {
                node.warn('Connection stuck, forcing retry');
                lgtv.disconnect();
                connecting = false;
            }, 30000);
        });

        lgtv.on('connect', () => {
            clearTimeout(connectingTimer);
            connecting = false;
            node.setStatus('connect');
            node.connected = true;
            node.emit('tvconnect');

            Object.keys(subscriptions).forEach(url => {
                subscriptions[url]._active = true;
                const payload = subscriptions[url]._payload;
                if (payload) {
                    lgtv.subscribe(url, payload, (err, res) => {
                        node.subscriptionHandler(url, err, res);
                    });
                } else {
                    lgtv.subscribe(url, (err, res) => {
                        node.subscriptionHandler(url, err, res);
                    });
                }
            });

            lgtv.getSocket('ssap://com.webos.service.networkinput/getPointerInputSocket',
                (err, sock) => {
                    if (!err) {
                        node.buttonSocket = sock;
                    }
                }
            );
        });

        lgtv.on('error', e => {
            clearTimeout(connectingTimer);
            connecting = false;
            const code = e.code || e.message || String(e);
            node.warn('TV error: ' + code);
            // Only update status if not connected — don't overwrite
            // green status for non-fatal errors (JSON parse, saveKey, etc.)
            // that fire while the WebSocket is still alive.
            if (!node.connected) {
                node.setStatus(code);
            }
        });

        lgtv.on('close', () => {
            clearTimeout(connectingTimer);
            connecting = false;
            node.connected = false;
            node.buttonSocket = null;
            node.setStatus('close');
            node.emit('tvclose');
            Object.keys(subscriptions).forEach(url => {
                subscriptions[url]._active = false;
            });
        });

        lgtv.on('prompt', () => {
            node.setStatus('prompt');
        });

        // Reconnect interval: periodically checks if disconnected and
        // not already connecting, and initiates a reconnect. This is
        // the sole reconnect mechanism — error/close handlers just
        // update state, and this interval picks it up.
        const reconnectInterval = setInterval(() => {
            if (node.connected) {
                return;
            }

            node.warn('Reconnect tick: connecting=' + connecting +
                ' lgtv.connection=' + lgtv.connection);

            if (connecting) {
                return;
            }

            if (lgtv.connection) {
                lgtv.disconnect();
            } else {
                lgtv.connect(tvUrl);
            }
        }, 5000);

        node.on('close', done => {
            clearInterval(reconnectInterval);
            clearTimeout(connectingTimer);
            lgtv.disconnect();
            done();
        });

        this.subscriptionHandler = function (url, err, res) {
            if (subscriptions[url]) {
                Object.keys(subscriptions[url]).forEach(id => {
                    if (id[0] !== '_') {
                        subscriptions[url][id](err, res);
                    }
                });
            }
        };

        this.subscribe = function (id, url, payload, callback) {
            if (typeof payload === 'function') {
                callback = payload;
                payload = undefined;
            }

            const isNew = !subscriptions[url];

            if (isNew) {
                subscriptions[url] = {_payload: payload, _active: false};
            }

            subscriptions[url][id] = callback;

            if (node.connected && !subscriptions[url]._active) {
                subscriptions[url]._active = true;
                const p = subscriptions[url]._payload;
                if (p) {
                    lgtv.subscribe(url, p, (err, res) => {
                        node.subscriptionHandler(url, err, res);
                    });
                } else {
                    lgtv.subscribe(url, (err, res) => {
                        node.subscriptionHandler(url, err, res);
                    });
                }
            }
        };

        this.request = function (url, payload, callback) {
            if (node.connected) {
                lgtv.request(url, payload, callback);
            }
        };

        this.reconnect = function () {
            if (!node.connected && !connecting) {
                lgtv.connect(tvUrl);
            }
        };

        this.register = function (lgtvNode) {
            node.users[lgtvNode.id] = lgtvNode;
        };

        this.deregister = function (lgtvNode, done) {
            delete node.users[lgtvNode.id];
            Object.keys(subscriptions).forEach(url => {
                delete subscriptions[url][lgtvNode.id];
            });
            return done();
        };

        this.setStatus = function (c) {
            status = c;
            let s;
            switch (c) {
                case 'connecting':
                    s = {
                        fill: 'yellow',
                        shape: 'ring',
                        text: 'node-red:common.status.connecting'
                    };
                    break;
                case 'prompt':
                    s = {
                        fill: 'yellow',
                        shape: 'ring',
                        text: c
                    };
                    break;
                case 'connect':
                    s = {
                        fill: 'green',
                        shape: 'dot',
                        text: 'node-red:common.status.connected'
                    };
                    break;
                case 'disconnected':
                    s = {
                        fill: 'red',
                        shape: 'ring',
                        text: 'node-red:common.status.disconnected'
                    };
                    break;
                default:
                    s = {
                        fill: 'red',
                        shape: 'ring',
                        text: c
                    };
            }

            Object.keys(node.users).forEach(id => {
                node.users[id].status(s);
            });
        };
    }

    RED.httpAdmin.get('/lgtv-connect', (req, res) => {
        if (!status || status === 'Close') {
            const secure = req.query.secure !== 'false';
            const pairUrl = (secure ? 'wss://' : 'ws://') + req.query.host + (secure ? ':3001' : ':3000');
            const pairOpts = {
                url: pairUrl,
                saveKey(key, cb) {
                    token = key;
                    RED.nodes.addCredentials(req.query.id, {
                        token: key
                    });
                    if (typeof cb === 'function') {
                        cb();
                    }
                }
            };

            if (secure) {
                pairOpts.wsconfig = {
                    keepalive: true,
                    keepaliveInterval: 10000,
                    dropConnectionOnKeepaliveTimeout: true,
                    keepaliveGracePeriod: 5000,
                    tlsOptions: {rejectUnauthorized: false}
                };
            }

            lgtv = require('lgtv2')(pairOpts);

            status = 'Connecting';

            setTimeout(() => {
                lgtv.disconnect();
                status = '';
            }, 31000);

            lgtv.on('connecting', () => {
                status = 'Connecting';
            });

            lgtv.on('connect', () => {
                lgtv.disconnect();
                status = 'Connected';
            });

            lgtv.on('error', e => {
                status = 'Error: ' + e.code.toLowerCase();
            });

            lgtv.on('prompt', () => {
                status = 'Please answer the prompt on your TV';
            });
        }

        res.status(200).send(JSON.stringify({
            state: status,
            token
        }));
    });

    RED.nodes.registerType('lgtv-config', LgtvConfigNode, {
        credentials: {
            token: {type: 'text'}
        }
    });
};
